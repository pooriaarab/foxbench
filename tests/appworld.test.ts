// Tests for the appworld benchmark failure modes in docs/failure-modes.md
// (AW9-AW13): the site and the run loop on the real bridge, with the fake
// AppWorld package of tests/fixtures/fake-appworld. tests/appworld-real.test.ts
// runs real dev tasks on a real install.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { appworldBenchmark } from "../src/bench/appworld/index.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import quick from "../src/bench/subsets/appworld.json" with { type: "json" };

const FAKE = fileURLToPath(new URL("./fixtures/fake-appworld/python", import.meta.url));
const saved = { root: process.env.APPWORLD_ROOT, python: process.env.APPWORLD_PYTHON };
let root = "";
const files = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)).toSorted();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fake-appworld-"));
  for (const [id, difficulty] of [["fake1_1", 1], ["fake2_1", 3], ["fake3_1", 2]] as const) {
    const dir = join(root, "data", "tasks", id, "ground_truth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ difficulty }));
  }
  writeFileSync(join(root, "data", "version.txt"), "0.1.0");
  // The run loop reads its context from process.env.
  Object.assign(process.env, { APPWORLD_ROOT: root, APPWORLD_PYTHON: FAKE });
});
afterAll(() => {
  for (const [k, v] of [["APPWORLD_ROOT", saved.root], ["APPWORLD_PYTHON", saved.python]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const form = (origin: string, path: string, fields: Record<string, string>) => fetch(origin + path, { method: "POST", body: new URLSearchParams(fields) });
/** perfect: signs in, adds the note the fake task wants, completes, then waits to be stopped; wrong: the note is not pinned. */
function agent(mode: "perfect" | "wrong", seen: string[] = []): Adapter {
  let stop: (() => void) | undefined;
  return {
    name: mode,
    async runTask({ url, goal }) {
      const stopped = new Promise<void>((resolve) => { stop = resolve; setTimeout(resolve, 20_000); });
      const origin = new URL(url).origin;
      seen.push(goal);
      await form(origin, "/notes/login", { username: "ada@example.com", password: "pw-<b>" });
      await form(origin, "/notes/add_note", { title: "groceries", pinned: mode === "perfect" ? "true" : "false", tags: "milk, eggs" });
      await form(origin, "/supervisor/complete_task", {});
      await stopped;
      return { done: true, log: `${mode}: ${goal}` };
    },
    async abort() { stop?.(); },
  };
}
const run = (adapter: Adapter, ids = ["fake1_1"]) => runBenchmarks({ adapter, runs: [{ benchmark: appworldBenchmark(), subset: "full" }], ids, timeoutMs: 60_000, graceMs: 5_000 });

describe("appworld", () => {
  it("AW9 cases carry the split and tier and no goal; published and quick are the test splits", async () => {
    const bench = appworldBenchmark();
    expect(await bench.load(benchContext(), "full")).toEqual([{ id: "fake3_1", tags: ["dev"], tier: "medium" }, { id: "fake1_1", tags: ["test_normal"], tier: "easy" }, { id: "fake2_1", tags: ["test_challenge"], tier: "hard" }]);
    expect((await bench.load(benchContext(), "published")).map((c) => c.id)).toEqual(["fake1_1", "fake2_1"]);
    expect(new Set(quick.quick).size).toBe(20);
    expect(quick.quick.every((id) => /^[0-9a-f]{7}_1$/.test(id))).toBe(true);
    expect(bench).toMatchObject({ redact: true, licence: { mode: "user-access" }, scoring: "programmatic" });
  });

  it("AW10 AW13 a page view never writes, values are escaped, and a dead bridge is a 502", async () => {
    const bench = appworldBenchmark();
    const env = await bench.up(benchContext());
    try {
      const episode = await bench.start(env, { id: "fake1_1", tags: [] });
      const o = new URL(episode.url).origin;
      expect(await (await fetch(`${o}/`)).text()).toMatch(/href="\/notes\/"/);
      expect(await (await fetch(`${o}/notes/`)).text()).toMatch(/href="\/notes\/add_note"/);
      expect(await (await fetch(`${o}/notes/add_note`)).text()).toMatch(/<form method="post" action="\/notes\/add_note">.*name="pinned"/s);
      expect(await (await fetch(`${o}/supervisor/show_account_passwords?_run=1`)).text()).toContain("<dd>pw-&#60;b&#62;</dd>");
      await form(o, "/notes/login", { username: "ada@example.com", password: "pw-<b>" });
      await fetch(`${o}/notes/add_note?title=viewed&_run=1`);
      const bad = await form(o, "/notes/add_note", { title: "x", stars: "many" });
      expect([bad.status, await bad.text()]).toEqual([400, expect.stringMatching(/role="alert">stars \(integer\)/)]);
      await form(o, "/notes/add_note", { title: "posted" });
      const notes = await (await form(o, "/notes/show_notes", {})).text();
      expect(notes).not.toContain("viewed");
      expect(notes).toContain('<script type="application/json" id="result">[{&#34;title&#34;: &#34;posted&#34;}]</script>');
      await (env.bridge as { close(): Promise<void> }).close();
      expect((await fetch(`${o}/notes/show_notes?_run=1`)).status).toBe(502);
      await episode.close!();
    } finally {
      await bench.down(env);
    }
  });

  it("AW11 noop and a wrong agent fail, a perfect agent passes, and the board holds no AppWorld text", async () => {
    const before = files(root);
    const seen: string[] = [];
    const [noop, wrong, perfect] = [await run(noopAdapter()), await run(agent("wrong", seen), ["fake1_1", "fake2_1"]), await run(agent("perfect"))];
    expect(noop.results[0]).toMatchObject({ success: false, reasons: ["AppWorld: 2 of 2 tests failed", "the agent did not call complete_task"] });
    expect(wrong.results.map((r) => [r.success, r.log, r.reasons])).toEqual([[false, "", ["AppWorld: 1 of 2 tests failed"]], [false, "", ["AppWorld: 1 of 2 tests failed"]]]);
    expect(perfect.results[0]).toMatchObject({ success: true, reasons: [] });
    expect(seen[0]).toMatch(/add a pinned note titled groceries.*You act for Ada Lovelace \(email ada@example\.com, phone 5550100\)/s);
    for (const secret of ["groceries", "Lovelace", "pw-", "milk"]) expect(JSON.stringify([noop, wrong, perfect])).not.toContain(secret);
    expect(files(root)).toEqual(before);
  }, 60_000);

  it("AW12 the episode ends at complete_task, and done alone never passes", async () => {
    const board = await run(agent("perfect"));
    expect(board.results[0]).toMatchObject({ success: true, endedEarly: true, done: true });
    expect(board.results[0]!.ms).toBeLessThan(15_000);
    const liar: Adapter = { name: "liar", runTask: async () => ({ done: true, log: "done" }) };
    expect((await run(liar)).results[0]).toMatchObject({ success: false, done: true });
  }, 60_000);
});
