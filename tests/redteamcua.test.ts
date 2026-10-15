// Tests for the RedTeamCUA failure modes in docs/failure-modes.md (RT1-RT4).
import { describe, expect, it } from "vitest";
import { noopAdapter } from "../src/adapter.js";
import { benchContext, benchmarkById, resolveSuites } from "../src/bench/registry.js";
import { REDTEAMCUA_REF, redteamcuaBenchmark } from "../src/bench/redteamcua.js";
import { runBenchmarks } from "../src/bench/run.js";

const ctx = benchContext();

describe("RedTeamCUA skip row", () => {
  it("RT1 --suite redteamcua gives one skip row and runs no case", async () => {
    expect(resolveSuites("redteamcua").map((r) => r.benchmark.id)).toEqual(["redteamcua"]);
    let ran = 0;
    const noop = noopAdapter();
    const adapter = { ...noop, async runTask(...args: Parameters<typeof noop.runTask>) { ran++; return noop.runTask(...args); } };
    const board = await runBenchmarks({ adapter, runs: [{ benchmark: redteamcuaBenchmark(), subset: "full" }] });
    expect(board.skipped.map((s) => s.benchmark)).toEqual(["redteamcua"]);
    expect(board.results).toEqual([]);
    expect(ran).toBe(0);
  });

  it("RT2 the reason names the count, the pin and the OS VM", async () => {
    const ready = await redteamcuaBenchmark().check(ctx);
    expect(ready.ready).toBe(false);
    if (ready.ready) return;
    expect(ready.reason).toMatch(/0 of 864/);
    expect(ready.reason).toContain("a05b8bd");
    expect(ready.reason).toMatch(/OS VM/);
    expect(ready.fix).toMatch(/OS VM/);
  });

  it("RT3 no subset has cases and no baseline is listed", async () => {
    const b = redteamcuaBenchmark();
    for (const subset of ["quick", "published", "full"] as const) expect(await b.load(ctx, subset)).toEqual([]);
    expect(b.baselines).toEqual([]);
  });

  it("RT4 the pin and the licence are recorded", () => {
    const b = benchmarkById("redteamcua")!;
    expect(b.upstream).toMatchObject({ repo: "https://github.com/OSU-NLP-Group/RedTeamCUA", ref: REDTEAMCUA_REF });
    expect(REDTEAMCUA_REF).toBe("a05b8bd04629e19a9a06bf04f8e0c5b53549d16c");
    expect(b.licence.code).toBe("Apache-2.0");
  });
});
