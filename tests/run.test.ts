// Tests for the run loop failure modes in docs/failure-modes.md (L1-L7), on a
// small scripted benchmark: each case is a page that asks for one word, and
// the judge reads the word the server got.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { benchContext, benchmarkById } from "../src/bench/registry.js";
import { missingRequired, runBenchmarks } from "../src/bench/run.js";
import { pickSubset } from "../src/bench/subsets.js";
import type { Benchmark, Case, Episode } from "../src/bench/types.js";

const root = join(import.meta.dirname, "..");
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, "dist/cli.js"), ...args], { encoding: "utf8", timeout: 60_000 });
const WORDS: Record<string, string> = { a: "apple", b: "birch", c: "cedar" };
const CASES: Case[] = Object.keys(WORDS).map((id) => ({ id, tags: ["toy"] }));
const posted = new WeakMap<Episode, string[]>();

/** The scripted benchmark. `ends` makes a post end the episode; `broken` makes start or judge throw on case b. */
function toy(id: string, opts: { ready?: boolean; ends?: boolean; broken?: "start" | "judge"; downs?: string[] } = {}): Benchmark {
  return {
    id, title: `toy ${id}`, upstream: { repo: "test", ref: "test" }, licence: { code: "MIT", data: "MIT", mode: "vendored" },
    where: "local", measures: ["task"], scoring: "programmatic", baselines: [],
    check: async () => (opts.ready === false ? { ready: false, reason: "no toy here", fix: "install the toy" } : { ready: true }),
    load: async (_ctx, subset) => pickSubset(id, CASES, subset),
    up: async () => ({}),
    async start(_env, item) {
      if (opts.broken === "start" && item.id === "b") throw new Error("the toy site is down");
      const got: string[] = [];
      const ends: (() => void)[] = [];
      const ended = new Promise<void>((resolve) => ends.push(resolve));
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        if (req.method === "POST") {
          got.push(new URLSearchParams(body).get("word") ?? "");
          ends[0]!();
        }
        res.end(`<p>Type the word <b>${WORDS[item.id]}</b>.</p><form method="post"><input name="word"></form>`);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as { port: number };
      const episode: Episode = { url: `http://127.0.0.1:${port}/`, goal: `Type the word on the page (${item.id}).`, startPath: "/",
        ...(opts.ends ? { ended } : {}), close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
      posted.set(episode, got);
      return episode;
    },
    async judge(_env, episode, _output) {
      const got = posted.get(episode)!;
      if (opts.broken === "judge" && episode.goal.includes("(b)")) throw new Error("the toy judge broke");
      const want = WORDS[/\((\w)\)/.exec(episode.goal)![1]!];
      return { success: got.length === 1 && got[0] === want, attack: null, reasons: got[0] === want ? [] : [`got ${got[0] ?? "nothing"}, not ${want}`], judgedBy: "programmatic" };
    },
    down: async () => { opts.downs?.push(id); },
  };
}

/** Reads the word and posts it; "wrong" posts another word; "linger" keeps working after the post. */
function typist(mode: "perfect" | "wrong" | "linger", aborts = { n: 0 }): Adapter {
  return {
    name: mode,
    async runTask({ url }) {
      const word = /<b>(\w+)<\/b>/.exec(await (await fetch(url)).text())![1]!;
      await fetch(url, { method: "POST", body: new URLSearchParams({ word: mode === "wrong" ? "nope" : word }) });
      if (mode === "linger") await new Promise((r) => setTimeout(r, 2_000));
      return { done: true, log: mode };
    },
    abort: async () => { aborts.n += 1; },
  };
}

const run = (bench: Benchmark | Benchmark[], adapter: Adapter, extra = {}) =>
  runBenchmarks({ adapter, runs: [bench].flat().map((benchmark) => ({ benchmark, subset: "full" as const })), ...extra });

describe("the loop scores a scripted benchmark", () => {
  it("noop scores 0", async () => expect((await run(toy("t"), noopAdapter())).passed).toBe(0));
  it("perfect passes every case", async () => expect(await run(toy("t"), typist("perfect"))).toMatchObject({ tasks: 3, passed: 3 }));
  it("wrong fails every case", async () => expect(await run(toy("t"), typist("wrong"))).toMatchObject({ passed: 0, results: [{ reasons: ["got nope, not apple"] }, {}, {}] }));
});

describe("L1 L6 a not-ready benchmark is a skip row; counts are per benchmark", () => {
  it("runs the ready ones and records the reason and fix", async () => {
    const board = await run([toy("gone", { ready: false }), toy("one"), toy("two")], typist("perfect"));
    expect(board.skipped).toEqual([{ benchmark: "gone", reason: "no toy here", fix: "install the toy" }]);
    expect(board.benchmarks).toEqual({ one: { tasks: 3, passed: 3 }, two: { tasks: 3, passed: 3 } });
    expect(board.results.map((r) => r.benchmark)).toEqual(["one", "one", "one", "two", "two", "two"]);
  });
});

describe("L2 --require makes a skip an error", () => {
  it("names the required benchmarks that were skipped", async () =>
    expect(missingRequired(await run([toy("gone", { ready: false }), toy("t")], noopAdapter()), ["gone", "t"])).toEqual(["gone"]));
});

describe("L3 the episode end stops the agent", () => {
  it("aborts the agent when the benchmark ends the episode", async () => {
    const aborts = { n: 0 };
    const started = Date.now();
    const board = await run(toy("t", { ends: true }), typist("linger", aborts), { graceMs: 50 });
    expect(aborts.n).toBe(3);
    expect(board.results.every((r) => r.endedEarly && r.success)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("L4 a throwing start or judge fails one case", () => {
  for (const broken of ["start", "judge"] as const) {
    it(`goes on after ${broken} throws`, async () => {
      const downs: string[] = [];
      const board = await run(toy("t", { broken, downs }), typist("perfect"));
      expect(board.results.map((r) => [r.id, r.success])).toEqual([["a", true], ["b", false], ["c", true]]);
      expect(board.results[1]!.reasons[0]).toMatch(/^harness: /);
      expect(downs).toEqual(["t"]);
    });
  }
});

describe("L5 quick is a committed list", () => {
  it("loads the same foxbench ids every time, at most 20", async () => {
    const foxbench = benchmarkById("foxbench")!;
    const one = (await foxbench.load(benchContext(), "quick")).map((c) => c.id);
    expect(one.length > 0 && one.length <= 20).toBe(true);
    expect((await foxbench.load(benchContext(), "quick")).map((c) => c.id)).toEqual(one);
  });
  it("refuses a list that names a missing case", () => expect(() => pickSubset("t", CASES, "quick", { t: { quick: ["a", "zz"] } })).toThrow(/quick list names zz/));
});

describe("L7 the CLI: doctor, --subset and --require", () => {
  beforeAll(() => {
    const built = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8" });
    if (built.status !== 0) throw new Error(built.stdout + built.stderr);
  }, 60_000);
  it("doctor prints each benchmark, and run takes a quick subset with --require", () => {
    expect(cli("doctor", "--require", "foxbench")).toMatchObject({ status: 0, stdout: expect.stringMatching(/foxbench\s+ready/) });
    const r = cli("run", "--agent", "noop", "--suite", "all", "--subset", "quick", "--require", "foxbench", "--out", mkdtempSync(join(tmpdir(), "fbn-l7-")));
    expect(r.status).toBe(0);
    expect(r.stderr.match(/^fail /gm)?.length).toBeLessThanOrEqual(20);
  });
  it("refuses an unknown subset", () => expect(cli("run", "--agent", "noop", "--subset", "most").status).toBe(2));
});
