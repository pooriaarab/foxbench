// Tests for the timeout failure modes in docs/failure-modes.md (R1-R5).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapter.js";
import { mcpAdapter } from "../src/mcp.js";
import { runSuite } from "../src/runner.js";
import { taskById, type Task } from "../src/tasks.js";

const FIXTURE = join(import.meta.dirname, "fixtures/mcp-server.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const hoodie = { email: "sam.park@example.com", name: "Sam Park", address: "12 King St W", city: "Toronto", postal: "M5H 1A1",
  card: "4242 4242 4242 4242", exp: "12/29", cvc: "123" };
async function buyHoodie(origin: string): Promise<void> {
  const send = (path: string, body: Record<string, string>) =>
    fetch(origin + path, { method: "POST", body: new URLSearchParams(body), redirect: "manual" });
  await send("/shop/cart/add", { sku: "merino-hoodie", color: "Forest", size: "M", qty: "1" });
  await send("/shop/checkout", hoodie);
}
const fake = (goal: string): Task => ({ ...taskById("shop-mugs")!, id: `fake-${goal}`, goal });

describe("R1 a late write does not reach the next task", () => {
  it("keeps the next task's state clean", async () => {
    let calls = 0;
    const late: Adapter = {
      name: "late",
      async runTask({ url }) {
        calls += 1;
        if (calls === 1) {
          // Times out at 150 ms, then buys a hoodie while the next task runs.
          setTimeout(() => buyHoodie(new URL(url).origin).catch(() => {}), 200);
          await new Promise(() => {});
        }
        // The next task does nothing, so any order in its state leaked in.
        await sleep(140);
        return { done: false, log: "did nothing" };
      },
    };
    const board = await runSuite({ adapter: late, tasks: [taskById("shop-mugs")!, taskById("shop-hoodie")!], timeoutMs: 150 });
    expect(board.results[0]!.log).toContain("timed out");
    expect(board.results[1]).toMatchObject({ id: "shop-hoodie", success: false, reasons: ["there are 0 orders, not 1"] });
  });
});

describe("R2 the runner aborts the agent after a timeout", () => {
  it("calls abort once", async () => {
    let aborts = 0;
    const stuck: Adapter = {
      name: "stuck",
      runTask: ({ goal }) => (goal.includes("hang") ? new Promise(() => {}) : Promise.resolve({ done: false, log: "" })),
      abort: async () => {
        aborts += 1;
      },
    };
    await runSuite({ adapter: stuck, tasks: [fake("hang here"), fake("fine")], timeoutMs: 100 });
    expect(aborts).toBe(1);
  });
});

describe("R3 R4 R5 the mcp adapter and its process tree", () => {
  it("starts a new server after abort and stops the old tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fbn-r3-"));
    const childFile = join(dir, "child");
    process.env.FBN_CHILD_FILE = childFile;
    process.env.FBN_PROBE = "probe-value";
    const adapter = mcpAdapter({ command: process.execPath, args: [FIXTURE], name: "fixture" });
    try {
      const first = JSON.parse((await adapter.runTask({ url: "http://127.0.0.1/", goal: "one" })).log);
      expect(first.probe).toBe("probe-value");
      const firstChild = Number(readFileSync(childFile, "utf8"));
      expect(alive(firstChild)).toBe(true);
      const hung = adapter.runTask({ url: "http://127.0.0.1/", goal: "hang" }).catch((e: Error) => e);
      await sleep(200);
      await adapter.abort!();
      await hung;
      expect(alive(first.pid)).toBe(false);
      expect(alive(firstChild)).toBe(false);
      const second = JSON.parse((await adapter.runTask({ url: "http://127.0.0.1/", goal: "two" })).log);
      expect(second.pid).not.toBe(first.pid);
      const secondChild = Number(readFileSync(childFile, "utf8"));
      await adapter.close!();
      await sleep(100);
      expect(alive(second.pid)).toBe(false);
      expect(alive(secondChild)).toBe(false);
    } finally {
      delete process.env.FBN_CHILD_FILE;
      delete process.env.FBN_PROBE;
      await adapter.close?.();
    }
  }, 20_000);
});
