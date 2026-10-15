// Tests for the repeated-trials failure modes in docs/failure-modes.md
// (K1-K6), on a toy benchmark: each case is a page that takes one word, and
// the scripted agent types the right word only on the trials its pattern says.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapter.js";
import { runBenchmarks } from "../src/bench/run.js";
import { passHatK } from "../src/bench/trials.js";
import type { Benchmark, Episode } from "../src/bench/types.js";

const root = join(import.meta.dirname, "..");
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, "dist/cli.js"), ...args], { encoding: "utf8", timeout: 60_000 });
/** Which trials pass, per case: a passes 2 of 4, b all, c none. */
const PATTERN: Record<string, boolean[]> = { a: [true, false, true, false], b: [true, true, true, true], c: [false, false, false, false] };
const posts = new WeakMap<Episode, string[]>();

/** The toy benchmark. `broken` makes start throw on those (case, trial) pairs. */
function toy(broken: string[] = []): Benchmark {
  const starts: Record<string, number> = {};
  return {
    id: "toy", title: "toy", upstream: { repo: "test", ref: "test" }, licence: { code: "MIT", data: "MIT", mode: "vendored" },
    where: "local", measures: ["task"], scoring: "programmatic", baselines: [],
    check: async () => ({ ready: true }),
    load: async () => Object.keys(PATTERN).map((id) => ({ id, tags: [] })),
    up: async () => ({}),
    async start(_env, item) {
      const trial = (starts[item.id] = (starts[item.id] ?? -1) + 1);
      if (broken.includes(`${item.id}${trial}`)) throw new Error("the toy site is down");
      const got: string[] = [];
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        if (req.method === "POST") got.push(new URLSearchParams(body).get("word") ?? "");
        res.end("<form method=post><input name=word></form>");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const episode: Episode = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, goal: `Type ok (${item.id}).`, startPath: "/",
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
      posts.set(episode, got);
      return episode;
    },
    async judge(_env, episode) {
      const got = posts.get(episode)!;
      // A fresh server per trial: one post, never an earlier trial's (K3).
      const success = got.length === 1 && got[0] === "ok";
      return { success, attack: null, reasons: success ? [] : [`got ${got.join(",") || "nothing"}`], judgedBy: "programmatic" };
    },
    down: async () => {},
  };
}

/** Types "ok" on the trials the pattern passes, "no" on the others. */
function patterned(): Adapter {
  const seen: Record<string, number> = {};
  return {
    name: "patterned",
    async runTask({ url, goal }) {
      const id = /\((\w)\)/.exec(goal)![1]!;
      const trial = (seen[id] = (seen[id] ?? -1) + 1);
      await fetch(url, { method: "POST", body: new URLSearchParams({ word: PATTERN[id]![trial] ? "ok" : "no" }) });
      return { done: true, log: "" };
    },
  };
}
const run = (bench: Benchmark, trials?: number) => runBenchmarks({ adapter: patterned(), runs: [{ benchmark: bench, subset: "full" }], ...(trials ? { trials } : {}) });
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 10));

describe("repeated trials and pass^k", () => {
  it("K1 pass^k is tau2's C(c, k) / C(n, k), averaged over cases", async () => {
    close([1, 2, 3, 4].map((k) => passHatK(4, 2, k)), [0.5, 1 / 6, 0, 0]);
    close([1, 2, 3, 4].map((k) => passHatK(4, 4, k)), [1, 1, 1, 1]);
    const board = await run(toy(), 4);
    expect(board.passHatK).toMatchObject({ toy: { trials: 4, excluded: 0 } });
    const k = board.passHatK!.toy!.k;
    close([k[1]!, k[2]!, k[3]!, k[4]!], [(0.5 + 1) / 3, (1 / 6 + 1) / 3, 1 / 3, 1 / 3]);
  });

  it("K2 pass^1 equals the success rate of the same trials", async () => {
    const board = await run(toy(), 4);
    expect(board).toMatchObject({ tasks: 12, passed: 6 });
    expect(board.passHatK!.toy!.k[1]).toBeCloseTo(board.successRate, 10);
  });

  it("K3 K5 each trial starts fresh and names its trial", async () => {
    const board = await run(toy(), 4);
    expect(board.results.filter((r) => r.id === "a").map((r) => [r.trial, r.success])).toEqual([[0, true], [1, false], [2, true], [3, false]]);
    expect(board.results.every((r) => r.success || r.reasons[0] === "got no")).toBe(true);
  });

  it("K4 harness errors are left out of pass^k and counted; k stops at the fewest trials left", async () => {
    const board = await run(toy(["b2"]), 4);
    expect(board.passHatK!.toy).toMatchObject({ trials: 3, excluded: 1 });
    expect(Object.keys(board.passHatK!.toy!.k)).toEqual(["1", "2", "3"]);
    expect(board.passed).toBe(5);
  });

  it("K6 one trial by default has no pass^k; a bad --trials exits 2", async () => {
    const board = await run(toy());
    expect(board.tasks).toBe(3);
    expect(board.passHatK).toBeUndefined();
    expect(board.results[0]!.trial).toBeUndefined();
    for (const bad of ["0", "1.5", "many"]) expect(cli("run", "--agent", "noop", "--trials", bad)).toMatchObject({ status: 2, stderr: expect.stringMatching(/--trials/) });
  });
});
