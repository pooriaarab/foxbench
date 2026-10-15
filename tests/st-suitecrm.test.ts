// Tests for the ST-WebAgentBench SuiteCRM failure modes in docs/failure-modes.md (ST1-ST4).
import { describe, expect, it } from "vitest";
import { noopAdapter } from "../src/adapter.js";
import { benchContext, benchmarkById, resolveSuites } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { ST_REF, stSuitecrmBenchmark } from "../src/bench/st-suitecrm.js";

const ctx = benchContext();

describe("ST-WebAgentBench SuiteCRM skip row", () => {
  it("ST1 --suite st-suitecrm gives one skip row and runs no case", async () => {
    expect(resolveSuites("st-suitecrm").map((r) => r.benchmark.id)).toEqual(["st-suitecrm"]);
    let ran = 0;
    const noop = noopAdapter();
    const adapter = { ...noop, async runTask(...args: Parameters<typeof noop.runTask>) { ran++; return noop.runTask(...args); } };
    const board = await runBenchmarks({ adapter, runs: [{ benchmark: stSuitecrmBenchmark(), subset: "full" }] });
    expect(board.skipped.map((s) => s.benchmark)).toEqual(["st-suitecrm"]);
    expect(board.results).toEqual([]);
    expect(ran).toBe(0);
  });

  it("ST2 the reason names the counts and the pin, and the fix names browser events", async () => {
    const ready = await stSuitecrmBenchmark().check(ctx);
    expect(ready.ready).toBe(false);
    if (ready.ready) return;
    expect(ready.reason).toContain("93 of 170");
    expect(ready.reason).toContain("80 tasks");
    expect(ready.reason).toContain("1,458 policy");
    expect(ready.reason).toContain("67f56dd");
    expect(ready.fix).toMatch(/browser events/);
  });

  it("ST3 no subset has cases and no baseline is listed", async () => {
    const b = stSuitecrmBenchmark();
    for (const subset of ["quick", "published", "full"] as const) expect(await b.load(ctx, subset)).toEqual([]);
    expect(b.baselines).toEqual([]);
  });

  it("ST4 the pin and the licence are recorded", () => {
    const b = benchmarkById("st-suitecrm")!;
    expect(b.upstream).toMatchObject({ repo: "https://github.com/segev-shlomov/ST-WebAgentBench", ref: ST_REF });
    expect(ST_REF).toBe("67f56dd7df9eca1646c9e49407b087e950aa1e77");
    expect(b.licence.code).toBe("Apache-2.0");
  });
});
