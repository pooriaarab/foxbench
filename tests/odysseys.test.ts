// Tests for the Odysseys and Mind2Web 2 failure modes in docs/failure-modes.md
// (ODY1-ODY6, MW21-MW23). The task files are synthetic, served by a fake GitHub
// endpoint (FOXBENCH_RAW_URL) into a temporary cache. The judges are fakes; no
// test calls a real API.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import type { Judge, JudgeAsk } from "../src/bench/judge.js";
import { DEV_TASKS, M2W2_REF, mind2web2Benchmark } from "../src/bench/mind2web2.js";
import { ODYSSEYS_REF, odysseysBenchmark } from "../src/bench/odysseys.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import type { Benchmark } from "../src/bench/types.js";

const rubric = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`R${i + 1}`, { requirement: `Requirement ${i + 1}`, verification: `Verify ${i + 1}` }]));
const TASKS = [
  { task_id: "ody-easy", confirmed_task: "Find the alpha of the first site.", level: "easy", rubrics: rubric(2) },
  { task_id: "ody-mid", confirmed_task: "Compare beta on two sites.", level: "medium", rubrics: rubric(3) },
  { task_id: "ody-hard", confirmed_task: "Plan the gamma trip.", level: "hard", rubrics: rubric(4) },
];
const script = (name: string) => `TASK_ID = "${name}"\nTASK_DESCRIPTION = """\nFind ${name} facts and cite them.\n"""\n`;
const dir = mkdtempSync(join(tmpdir(), "fbn-ody-"));
const saved = { ...process.env };
let broken = "";
const server = createServer((req, res) => {
  const dev = DEV_TASKS.find((n) => req.url === `/OSU-NLP-Group/Mind2Web-2/${M2W2_REF}/eval_scripts/dev_set/${n}.py`);
  const body = req.url === `/ljang0/Odysseys/${ODYSSEYS_REF}/data/odysseys.json` ? JSON.stringify(TASKS) : dev ? (dev === broken ? "print('no task here')" : script(dev)) : undefined;
  res.writeHead(body === undefined ? 404 : 200).end(body === undefined || req.method === "HEAD" ? undefined : body);
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { FOXBENCH_RAW_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, FOXBENCH_CACHE: join(dir, "cache") });
});
afterAll(() => {
  process.env = saved;
  return new Promise<void>((r) => server.close(() => r()));
});

type Mode = "fair" | "mute" | "short";
/** A fake judge. Odysseys: items are R-lines; Mind2Web 2: step one lists three criteria, step two numbered items. "half" in the answer meets only the first item. */
function fake(mode: Mode = "fair", calls: JudgeAsk[] = []): Judge {
  return {
    name: "claude", model: "claude-fake", where: "cloud",
    async ask(q) {
      calls.push(q);
      if (mode === "mute") return "I am not sure.";
      if (q.system.includes("list what a complete")) return "**Criteria**:\n1. Finds the facts\n2. Cites a source\n3. Gives at least three";
      const n = [...q.prompt.matchAll(/^(?:R)?\d+\.[ ]/gm)].length;
      const answer = /Final answer:\n([\s\S]*?)\n\nAction History:/.exec(q.prompt)![1]!;
      const grades = Array.from({ length: mode === "short" ? n - 1 : n }, (_, i) => (answer.includes("done") || (answer.includes("half") && i === 0) ? 1 : 0));
      return `Rubric: [${grades.join(", ")}]\nThoughts: graded.`;
    },
  };
}
const scripted = (name: string, answer: string): Adapter => ({
  name,
  async runTask({ url }) {
    const page = await (await fetch(url)).text();
    expect(page).toContain('data-case="');
    expect(page).toContain("google.com/search");
    return { done: true, log: "searched and read pages", answer };
  },
});
const play = (bench: Benchmark, adapter: Adapter, judges: Judge[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], judges, timeoutMs: 30_000 });
const ctx = () => benchContext();
const ody = odysseysBenchmark();
const m2w2 = mind2web2Benchmark();

describe("Odysseys", () => {
  it("ODY1 ODY2 the pinned file, with upstream ids and levels", async () => {
    expect(ODYSSEYS_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(ody).toMatchObject({ upstream: { ref: ODYSSEYS_REF }, licence: { code: "MIT", mode: "fetch-at-run" }, where: "live-web", scoring: "llm" });
    expect(await ody.check(ctx())).toEqual({ ready: true });
    expect((await ody.load(ctx(), "full")).map((c) => [c.id, c.tier, c.tags, c.judge])).toEqual([["ody-easy", "easy", ["easy"], "llm"], ["ody-mid", "medium", ["medium"], "llm"], ["ody-hard", "hard", ["hard"], "llm"]]);
  });

  it("ODY3 ODY5 ODY6 noop and wrong pass 0, perfect passes, a partial agent fails with its average, and the judge sees the evidence", async () => {
    expect((await play(ody, noopAdapter(), [fake()])).passed).toBe(0);
    expect((await play(ody, scripted("wrong", "no idea"), [fake()])).passed).toBe(0);
    const calls: JudgeAsk[] = [];
    expect(await play(ody, scripted("perfect", "done"), [fake("fair", calls)])).toMatchObject({ tasks: 3, passed: 3 });
    expect(calls[1]!.prompt).toContain("R1. Requirement: Requirement 1\n   Verify: Verify 1\nR2.");
    expect(calls[1]!.prompt).toMatch(/Hosts the agent reached: 127\.0\.0\.1:\d+\n/);
    expect(calls[1]!.prompt).toContain("searched and read pages");
    const half = await play(ody, scripted("half", "half"), [fake()]);
    expect(half.passed).toBe(0);
    expect(half.results.map((r) => r.score)).toEqual([1 / 2, 1 / 3, 1 / 4]);
  });

  it("ODY4 a wrong item count or no verdict fails the case", async () => {
    for (const mode of ["short", "mute"] as const) {
      const board = await play(ody, scripted("perfect", "done"), [fake(mode)]);
      expect(board.passed).toBe(0);
      expect(board.results[0]!.reasons[0]).toMatch(/^judge: claude: /);
    }
  });
});

describe("Mind2Web 2 dev", () => {
  it("MW21 the ten pinned scripts, and a script without a task stops the load", async () => {
    expect(M2W2_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(m2w2).toMatchObject({ upstream: { ref: M2W2_REF }, licence: { mode: "fetch-at-run" }, where: "live-web", scoring: "llm" });
    expect(await m2w2.check(ctx())).toEqual({ ready: true });
    expect((await m2w2.load(ctx(), "full")).map((c) => c.id)).toEqual(DEV_TASKS);
    broken = "buy_monitor";
    await expect(mind2web2Benchmark().load({ ...ctx(), cacheDir: join(dir, "fresh") }, "full")).rejects.toThrow("buy_monitor.py has no TASK_ID");
    broken = "";
  });

  it("MW22 MW23 two steps, the hosts the agent reached, noop and wrong pass 0, perfect passes, partial fails with its share", async () => {
    expect((await play(m2w2, noopAdapter(), [fake()])).passed).toBe(0);
    expect((await play(m2w2, scripted("wrong", "no idea"), [fake()])).passed).toBe(0);
    const calls: JudgeAsk[] = [];
    expect(await play(m2w2, scripted("perfect", "done"), [fake("fair", calls)])).toMatchObject({ tasks: 10, passed: 10 });
    expect(calls[0]!.prompt).toBe("Task: Find ad_patent facts and cite them.");
    expect(calls[1]!.prompt).toContain("Items:\n1. Finds the facts\n2. Cites a source\n3. Gives at least three");
    expect(calls[1]!.prompt).toMatch(/Hosts the agent reached: 127\.0\.0\.1:\d+\n/);
    const half = await play(m2w2, scripted("half", "half"), [fake()]);
    expect(half.passed).toBe(0);
    expect(half.results[0]!.score).toBeCloseTo(1 / 3);
    expect((await play(m2w2, scripted("perfect", "done"), [fake("short")])).results[0]!.reasons[0]).toMatch(/^judge: claude: expected 3 grades/);
  });
});
