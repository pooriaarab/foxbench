// Tests for the AppWorld bridge failure modes in docs/failure-modes.md
// (AW1-AW8). The bridge is the real one; the AppWorld package is a fake with
// one notes app (tests/fixtures/fake-appworld), so no AppWorld code or data
// is needed and none is read.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { appworldReadiness, startBridge, type AppWorldBridge } from "../src/bench/appworld/bridge.js";
import { benchContext } from "../src/bench/registry.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-appworld/python", import.meta.url));
let root = "";
const ctx = (env: Record<string, string | undefined> = {}) => benchContext({ env: { ...process.env, APPWORLD_ROOT: root, APPWORLD_PYTHON: FAKE, ...env } });
const files = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)).toSorted();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fake-appworld-"));
  for (const [id, difficulty] of [["fake1_1", 1], ["fake2_1", 3], ["fake3_1", 2]] as const) {
    const dir = join(root, "data", "tasks", id, "ground_truth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ difficulty }));
  }
  writeFileSync(join(root, "data", "version.txt"), "0.1.0");
});

/** A bridge with the fake task open, closed after `body`. */
async function session(body: (bridge: AppWorldBridge) => Promise<void>): Promise<void> {
  const bridge = await startBridge(ctx());
  try {
    await bridge.open("fake1_1");
    await body(bridge);
  } finally {
    await bridge.close();
  }
}
const login = (b: AppWorldBridge) => b.call("notes", "login", { username: "ada@example.com", password: "pw-<b>" });

describe("appworld bridge", () => {
  it("AW1 a session writes no file, and a harness error names only the exception", async () => {
    const before = files(root);
    await session(async (b) => {
      await login(b);
      await b.call("notes", "add_note", { title: "groceries" });
      await b.evaluate();
      await expect(b.open("no-such-task")).rejects.toThrow(/^the AppWorld bridge failed: FileNotFoundError$/);
    });
    expect(files(root)).toEqual(before);
  });

  it("AW2 check names what is missing, with the commands to fix it", async () => {
    expect(await appworldReadiness(ctx())).toEqual({ ready: true });
    expect(await appworldReadiness(ctx({ APPWORLD_ROOT: undefined }))).toMatchObject({ ready: false, reason: expect.stringMatching(/APPWORLD_ROOT/), fix: expect.stringMatching(/appworld install/) });
    expect(await appworldReadiness(ctx({ APPWORLD_ROOT: tmpdir() }))).toMatchObject({ ready: false, fix: expect.stringMatching(/appworld download data/) });
    expect(await appworldReadiness(ctx({ FAKE_APPWORLD_VERSION: "0.1.2" }))).toMatchObject({ ready: false, reason: expect.stringMatching(/0\.1\.2 is installed, not 0\.1\.3\.post1/) });
    expect(await appworldReadiness(ctx({ FAKE_APPWORLD_UNPACKED: "0" }))).toMatchObject({ ready: false, reason: expect.stringMatching(/not unpacked/) });
    expect(await appworldReadiness(ctx({ APPWORLD_PYTHON: "/nonexistent/python" }))).toMatchObject({ ready: false, reason: expect.stringMatching(/could not run/) });
  });

  it("AW3 tasks come from AppWorld's loader with their split and difficulty", async () => {
    const bridge = await startBridge(ctx());
    expect(await bridge.tasks().finally(() => bridge.close())).toEqual([
      { id: "fake3_1", split: "dev", difficulty: 2 }, { id: "fake1_1", split: "test_normal", difficulty: 1 }, { id: "fake2_1", split: "test_challenge", difficulty: 3 },
    ]);
  });

  it("AW4 AppWorld's evaluator judges: no calls and a wrong call fail, the right calls pass", async () => {
    await session(async (b) => {
      const task = await b.open("fake1_1");
      expect(task).toMatchObject({ goal: expect.stringContaining("pinned note titled groceries"), supervisor: { first_name: "Ada" } });
      expect(Object.keys(task.apps)).toEqual(["supervisor", "notes"]);
      expect(task.apps.notes!.find((d) => d.name === "add_note")).toMatchObject({ method: "POST", parameters: expect.arrayContaining([{ name: "pinned", type: "boolean", required: false, description: "The pinned.", default: null, constraints: [] }]) });
      expect(await b.evaluate()).toEqual({ success: false, passes: 0, fails: 2, completed: false });
      await login(b);
      await b.call("notes", "add_note", { title: "groceries", pinned: "false", tags: "milk, eggs" });
      expect(await b.call("supervisor", "complete_task", {})).toMatchObject({ completed: true });
      expect(await b.evaluate()).toEqual({ success: false, passes: 1, fails: 1, completed: true });
      await b.open("fake1_1");
      await login(b);
      await b.call("notes", "add_note", { title: "groceries", pinned: "true", tags: "milk, eggs" });
      await b.call("supervisor", "complete_task", {});
      expect(await b.evaluate()).toEqual({ success: true, passes: 2, fails: 0, completed: true });
    });
  });

  it("AW5 AW6 fields are converted by the doc's types, and a sign-in fills later tokens", async () => {
    await session(async (b) => {
      expect(await b.call("notes", "show_notes", {})).toMatchObject({ error: expect.stringMatching(/401/) });
      expect(await login(b)).toMatchObject({ result: { access_token: "token-1" } });
      expect(await b.call("notes", "add_note", { title: "x", stars: "many" })).toMatchObject({ error: expect.stringMatching(/^stars \(integer\): /) });
      expect(await b.call("notes", "add_note", { title: "x", pinned: "yes" })).toMatchObject({ error: "pinned (boolean): must be true or false" });
      await b.call("notes", "add_note", { title: "typed", pinned: "TRUE", tags: '["a", "b"]', stars: "3", access_token: " " });
      expect(await b.call("notes", "show_notes", {})).toEqual({ result: [{ title: "typed", pinned: true, tags: ["a", "b"], stars: 3 }], completed: false });
    });
  });

  it("AW7 AW8 each open is a fresh world without sign-ins, and a dead bridge fails at once", async () => {
    const bridge = await startBridge(ctx());
    await bridge.open("fake1_1");
    await login(bridge);
    await bridge.call("notes", "add_note", { title: "kept?" });
    await bridge.open("fake1_1");
    expect(await bridge.call("notes", "show_notes", {})).toMatchObject({ error: expect.stringMatching(/401/) });
    await login(bridge);
    expect(await bridge.call("notes", "show_notes", {})).toEqual({ result: [], completed: false });
    await bridge.close();
    const started = Date.now();
    await expect(bridge.evaluate()).rejects.toThrow(/the AppWorld bridge stopped/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
