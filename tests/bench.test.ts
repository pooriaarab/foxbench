// Tests for the Benchmark interface failure modes in docs/failure-modes.md
// (B1-B7). They drive the interface as the run loop does: start, the agent,
// judge, then close.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { benchContext, benchmarkById, benchmarks, readiness, resolveSuites } from "../src/bench/registry.js";
import type { Benchmark, SubsetName, Verdict } from "../src/bench/types.js";
import { tasks, tasksIn } from "../src/tasks.js";
import { referenceAdapter } from "./reference.js";

const root = join(import.meta.dirname, "..");
const foxbench = benchmarkById("foxbench")!;
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, "dist/cli.js"), "list", ...args], { encoding: "utf8", timeout: 60_000 });

/** Runs every case of a subset through the interface, one after another. */
async function play(bench: Benchmark, subset: SubsetName, adapter: Adapter): Promise<{ id: string; verdict: Verdict }[]> {
  const ctx = benchContext();
  const env = await bench.up(ctx);
  const out: { id: string; verdict: Verdict }[] = [];
  try {
    for (const item of await bench.load(ctx, subset)) {
      const episode = await bench.start(env, item);
      const output = await adapter.runTask({ url: episode.url, goal: episode.goal });
      out.push({ id: item.id, verdict: await bench.judge(env, episode, output, { requests: [] }) });
      await episode.close?.();
    }
  } finally {
    await bench.down(env);
  }
  return out;
}

const HARD = [...tasksIn("hard"), ...tasksIn("security+")];
/** Does the work of the next hard or security+ task instead of this one. */
function wrongAdapter(): Adapter {
  const reference = referenceAdapter("careful");
  return {
    name: "wrong",
    runTask: async ({ url, goal }) => {
      const at = HARD.findIndex((t) => t.goal === goal);
      // The other task's steps may not fit this site; the agent still claims done.
      await reference.runTask({ url, goal: HARD[(at + 1) % HARD.length]!.goal }).catch(() => {});
      return { done: true, log: "did the next task" };
    },
  };
}

describe("B1 suite names resolve to one benchmark", () => {
  it("has unique ids", () => expect(new Set(benchmarks.map((b) => b.id)).size).toBe(benchmarks.length));
  it("maps the in-house suites to foxbench tags", () => {
    expect(resolveSuites("core")).toEqual([{ benchmark: foxbench, subset: "tag:core" }]);
    expect(resolveSuites("hard,security+").map((r) => r.subset)).toEqual(["tag:hard", "tag:security+"]);
    expect(resolveSuites("foxbench")).toEqual([{ benchmark: foxbench, subset: "full" }]);
    expect(resolveSuites("all").map((r) => r.benchmark.id)).toEqual(benchmarks.map((b) => b.id));
  });
  it("names the known suites for an unknown one", () => expect(() => resolveSuites("nope")).toThrow(/core, hard, security\+, all, foxbench/));
});

describe("B2 full is the scored suites only", () => {
  it("loads tasksIn(all) for full and one suite for a tag", async () => {
    const ctx = benchContext();
    expect((await foxbench.load(ctx, "full")).map((c) => c.id)).toEqual(tasksIn("all").map((t) => t.id));
    expect((await foxbench.load(ctx, "tag:core")).map((c) => c.id)).toEqual(tasksIn("core").map((t) => t.id));
    expect(await foxbench.load(ctx, "tag:train")).toEqual(tasks.filter((t) => (t.suite as string) === "train").map((t) => expect.objectContaining({ id: t.id })));
  });
});

describe("B3 the agent gets the task's own start page and goal", () => {
  it("starts each case on a fresh server", async () => {
    const ctx = benchContext();
    const env = await foxbench.up(ctx);
    try {
      for (const item of await foxbench.load(ctx, "full")) {
        const task = tasks.find((t) => t.id === item.id)!;
        const episode = await foxbench.start(env, item);
        expect(episode.goal).toBe(task.goal);
        expect(new URL(episode.url).pathname).toBe(`/${task.site}${task.path}`);
        expect(episode.startPath).toBe(`/${task.site}${task.path}`);
        expect(item.tags).toEqual(expect.arrayContaining([task.suite, task.tier, task.site]));
        expect(item.trap).toBe(Boolean(task.trap));
        await episode.close?.();
      }
    } finally {
      await foxbench.down(env);
    }
  });
});

describe("B4 the judge reads the state, not the claim", () => {
  it("noop fails every case", async () => {
    const results = await play(foxbench, "full", noopAdapter());
    expect(results.filter((r) => r.verdict.success)).toEqual([]);
    expect(results.every((r) => r.verdict.judgedBy === "programmatic")).toBe(true);
  });
  it("a liar that claims done fails every case", async () => {
    const liar: Adapter = { name: "liar", runTask: async () => ({ done: true, log: "done, all good" }) };
    expect((await play(foxbench, "tag:core", liar)).filter((r) => r.verdict.success)).toEqual([]);
  });
  it("the reference solver passes every hard and security+ case with each attack blocked", async () => {
    for (const tag of ["tag:hard", "tag:security+"] as const) {
      const results = await play(foxbench, tag, referenceAdapter("careful"));
      expect(results.filter((r) => !r.verdict.success || r.verdict.attack === "followed")).toEqual([]);
    }
  });
  it("a scripted wrong agent fails every case", async () => {
    const results = [...await play(foxbench, "tag:hard", wrongAdapter()), ...await play(foxbench, "tag:security+", wrongAdapter())];
    expect(results.filter((r) => r.verdict.success).map((r) => r.id)).toEqual([]);
  });
  it("the gullible solver follows every attack", async () => {
    const results = await play(foxbench, "tag:security+", referenceAdapter("gullible"));
    expect(results.map((r) => r.verdict.attack)).toEqual(results.map(() => "followed"));
  });
});

describe("B5 a case's server stops at the end of the case", () => {
  it("refuses a request after close", async () => {
    const ctx = benchContext();
    const env = await foxbench.up(ctx);
    const [item] = await foxbench.load(ctx, "tag:core");
    const episode = await foxbench.start(env, item!);
    expect((await fetch(episode.url)).status).toBe(200);
    await episode.close?.();
    await expect(fetch(episode.url)).rejects.toThrow();
    await foxbench.down(env);
  });
});

describe("B6 a throwing check is a not-ready row", () => {
  it("turns the throw into the reason", async () => {
    const broken: Benchmark = { ...foxbench, id: "broken", check: async () => { throw new Error("boom"); } };
    expect(await readiness(broken, benchContext())).toEqual({ ready: false, reason: "check() threw: boom" });
    expect(await readiness(foxbench, benchContext())).toEqual({ ready: true });
  });
});

describe("B7 case ids are unique and equal the task ids", () => {
  it("keeps the task ids", async () => {
    const ids = (await foxbench.load(benchContext(), "full")).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(tasksIn("all").map((t) => t.id));
  });
});

describe("foxbench list reads the registry", () => {
  it("prints each benchmark with its readiness", () => {
    const rows = JSON.parse(cli("--json").stdout) as { id: string; ready: boolean; cases: number }[];
    expect(rows.map((r) => r.id)).toEqual(benchmarks.map((b) => b.id));
    expect(rows[0]).toMatchObject({ id: "foxbench", ready: true, cases: tasksIn("all").length });
    expect(cli().stdout).toMatch(/foxbench\s+ready/);
  });
});
