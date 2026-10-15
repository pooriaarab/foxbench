// Tests for the AssistantBench failure modes in docs/failure-modes.md (A1-A8),
// against the real dev answers and the real upstream scorer: the first run
// fetches both at their pinned refs into the cache. The scorer runs through
// uv; without uv on the PATH these tests are skipped (CI installs uv).
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { AB_DATASET_REF, AB_SCORER_REF, assistantbenchBenchmark, loadTasks, scorerCommand, scorerDir, type AssistantbenchTask } from "../src/bench/assistantbench.js";
import { benchContext } from "../src/bench/registry.js";
import type { Env } from "../src/bench/types.js";
import { runBenchmarks } from "../src/bench/run.js";
import { toMarkdown } from "../src/score.js";

const hasUv = spawnSync("uv", ["--version"]).status === 0;
if (!hasUv) console.warn("tests/assistantbench.test.ts: uv is not on the PATH, so the AssistantBench tests are skipped");
const bench = assistantbenchBenchmark();
const ctx = benchContext();
let tasks: AssistantbenchTask[] = [];
let env: Env = {};

/** The gold answer in the format the goal asks for: a JSON list for several plain items, else as upstream writes it. */
function perfectAnswer(gold: string): string {
  const lines = gold.split("\n").filter((l) => l.trim());
  if (lines.length < 2 || lines.every((l) => l.trim().startsWith("{"))) return gold;
  return JSON.stringify(lines);
}

/** A scripted agent: it reads which case it is on from the start page and answers with `answer`. */
const scripted = (name: string, answer: (t: AssistantbenchTask) => string): Adapter => ({
  name,
  async runTask({ url, goal }) {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(goal).not.toMatch(/127\.0\.0\.1/);
    const page = await (await fetch(url)).text();
    expect(page).toContain("not a sandbox");
    expect(goal).toContain("not a sandbox");
    const task = tasks.find((t) => page.includes(`data-case="${t.id}"`))!;
    return { done: true, log: answer(task) };
  },
});
const play = (adapter: Adapter, ids?: string[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], ...(ids ? { ids } : {}), timeoutMs: 30_000 });

describe.skipIf(!hasUv)("AssistantBench", () => {
  beforeAll(async () => {
    expect(await bench.check(ctx)).toEqual({ ready: true });
    tasks = await loadTasks(ctx);
    env = await bench.up(ctx);
  }, 300_000);
  afterAll(() => bench.down(env));

  it("A1 the dataset and the scorer are the pinned refs", () => {
    expect(AB_DATASET_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(AB_SCORER_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("git", ["-C", scorerDir(ctx), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(AB_SCORER_REF);
    expect(bench).toMatchObject({ upstream: { ref: AB_DATASET_REF }, licence: { code: "Apache-2.0", data: "Apache-2.0", mode: "fetch-at-run" }, where: "live-web", scoring: "programmatic" });
  });

  it("A2 the cases are the 33 dev tasks with upstream ids and tiers", async () => {
    const cases = await bench.load(ctx, "full");
    expect(cases).toHaveLength(33);
    expect(new Set(cases.map((c) => c.id)).size).toBe(33);
    expect(cases.map((c) => c.id)).toEqual(tasks.map((t) => t.id));
    expect(cases.every((c) => /^[0-9a-f]{64}$/.test(c.id) && (c.tier === "medium" || c.tier === "hard"))).toBe(true);
    expect(cases.filter((c) => c.tier === "hard")).toHaveLength(19);
  });

  it("A3 noop and a liar pass nothing", async () => {
    expect((await play(noopAdapter())).passed).toBe(0);
    expect((await play(scripted("liar", () => "Done. I found the answer."))).passed).toBe(0);
  }, 120_000);

  it("A4 a scripted perfect agent passes all 33 with the upstream scorer", async () => {
    const board = await play(scripted("perfect", (t) => perfectAnswer(t.answer)));
    expect(board).toMatchObject({ tasks: 33, passed: 33, adapterErrors: 0 });
    expect(board.benchmarks.assistantbench).toEqual({ tasks: 33, passed: 33, meanScore: 1 });
  }, 120_000);

  it("A5 a wrong answer fails, and a near miss is partial credit, not a pass", async () => {
    expect((await play(scripted("wrong", () => "Atlantis"))).passed).toBe(0);
    const numeric = tasks.find((t) => t.answer === "14.2")!;
    const board = await play(scripted("close", () => "15"), [numeric.id]);
    expect(board.results[0]).toMatchObject({ success: false, score: expect.closeTo(1 - Math.log(15 / 14.2), 3) });
    expect(board.benchmarks.assistantbench!.meanScore).toBeCloseTo(1 - Math.log(15 / 14.2), 3);
    expect(toMarkdown(board)).toMatch(/assistantbench 0\/1 \(mean score 0\.95\)/);
  }, 60_000);

  it("A6 the scorer runs isolated, from a directory foxbench owns", () => {
    const [cmd, args] = scorerCommand(ctx);
    expect(cmd).toBe("uv");
    expect(args).toEqual(expect.arrayContaining(["run", "--isolated", "-I"]));
    const helper = args.find((a) => a.endsWith(".py"))!;
    expect(helper.startsWith(scorerDir(ctx))).toBe(false);
    expect(helper.startsWith(ctx.cacheDir)).toBe(true);
  });

  it("A8 the agent starts on a local page with the question and a search form", async () => {
    const episode = await bench.start(env, { id: tasks[0]!.id, tags: [] });
    try {
      expect(episode.goal).toContain(tasks[0]!.task);
      expect(episode.goal).toContain("JSON list");
      const html = await (await fetch(episode.url)).text();
      expect(html).toContain('action="https://www.google.com/search"');
    } finally {
      await episode.close?.();
    }
  });
});

describe("A7 check() without the tools", () => {
  it("is not ready, with a fix, when uv or git is missing", async () => {
    const result = await bench.check({ ...ctx, env: { ...process.env, PATH: "/nonexistent" } });
    expect(result).toMatchObject({ ready: false, reason: expect.stringMatching(/uv|git/), fix: expect.any(String) });
  });
});
