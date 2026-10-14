// Tests for the WebArena-Infinity failure modes in docs/failure-modes.md (WI1-WI9),
// on real Gmail and Xero tasks fetched at the pinned commit. The scripted agents
// act as the apps' pages do: a PUT of the state to /api/state.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter, type TaskInput, type TaskOutput } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { WAI_REF, waiBenchmark } from "../src/bench/wai/index.js";
import type { Benchmark, Case, Env } from "../src/bench/types.js";

const solve = join(import.meta.dirname, "fixtures/wai_solve.py");
const cache = mkdtempSync(join(tmpdir(), "foxbench-wai-"));
const upstream = join(cache, `webarena-infinity-${WAI_REF.slice(0, 12)}`);
const IDS = ["gmail/real/task_e1", "gmail/real/task_e6", "xero-invoicing/real/task_e1", "gmail/function/task_1", "xero-invoicing/function/task_1"];
const ctx = benchContext({ cacheDir: cache });
let bench: Benchmark;
let cases: Case[];

const solved = (app: string, kind: string, task: string): { seed: unknown; solved: unknown } =>
  JSON.parse(execFileSync("python3", ["-I", solve, join(upstream, "apps", app), kind, task], { encoding: "utf8", maxBuffer: 1 << 28 }));
const origin = (url: string) => `http://127.0.0.1:${new URL(url).port}`;
const put = (url: string, state: unknown) => fetch(`${origin(url)}/api/state`, { method: "PUT", body: JSON.stringify(state) });

/** What the page does: push the seed on load, then push the state the task needs (perfect) or an unrelated one (wrong). */
function scripted(kind: "perfect" | "wrong" | "liar"): Adapter {
  return {
    name: kind,
    async runTask({ url, goal }: TaskInput): Promise<TaskOutput> {
      const id = cases.find((c) => c.goal === goal)!.id;
      const [app, kind, task] = id.split("/");
      if (kind === "liar") return { done: true, log: "claims done" };
      const states = solved(app!, kind!, task!);
      await put(url, states.seed);
      await put(url, kind === "perfect" ? states.solved : { ...(states.seed as object), unrelated: true });
      return { done: true, log: `${kind} pushed state` };
    },
  };
}

const run = (adapter: Adapter, ids = IDS) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], ids });
const board = async (a: Adapter) => (await run(a)).results.map((r) => [r.id, r.success, r.reasons.length > 0]);

beforeAll(async () => {
  process.env.FOXBENCH_CACHE = cache;
  bench = waiBenchmark();
  cases = await bench.load(ctx, "full");
}, 180_000);
afterAll(() => { delete process.env.FOXBENCH_CACHE; });

describe("WebArena-Infinity", () => {
  it("WI1 fetches one pinned commit, whole, into the cache", () => {
    expect(readFileSync(join(upstream, ".foxbench-ref"), "utf8").trim()).toBe(WAI_REF);
    expect(readdirSync(cache).filter((n) => n.startsWith("webarena-infinity-"))).toEqual([`webarena-infinity-${WAI_REF.slice(0, 12)}`]);
    expect(existsSync(join(upstream, "apps/gmail/server.py"))).toBe(true);
    expect(existsSync(join(upstream, "apps/user-manuals"))).toBe(false);
    expect(cases.length).toBe(2357);
    expect(new Set(cases.map((c) => c.id)).size).toBe(2357);
  }, 180_000);

  it("WI5 WI6 noop and a liar score 0, perfect passes, wrong fails, on real and function cases", async () => {
    expect(await board(noopAdapter())).toEqual(IDS.map((id) => [id, false, true]));
    expect(await board(scripted("liar"))).toEqual(IDS.map((id) => [id, false, true]));
    expect(await board(scripted("wrong"))).toEqual(IDS.map((id) => [id, false, true]));
    expect((await board(scripted("perfect"))).map((r) => r[1])).toEqual(IDS.map(() => true));
  }, 180_000);

  it("WI2 WI3 resets between cases, hides the verifiers, and WI8 stops the servers", async () => {
    const env: Env = await bench.up(ctx);
    const item = cases.find((c) => c.id === IDS[0])!;
    const first = await bench.start(env, item);
    const states = solved("gmail", "real", "task_e1");
    await put(first.url, states.seed);
    await put(first.url, states.solved);
    expect((await bench.judge(env, first, { done: false, log: "" }, { requests: [] })).success).toBe(true);
    const second = await bench.start(env, item);
    // The seed is kept from the first push, so a reset puts it back (WI2).
    const verdict = await bench.judge(env, second, { done: false, log: "" }, { requests: [] });
    expect(verdict.success).toBe(false);
    for (const hidden of ["real-tasks/task_e1.py", "real-tasks.json", "function-tasks.json", "sanity_check_real.py", "Dockerfile"]) {
      expect((await fetch(`${origin(second.url)}/${hidden}`)).status, hidden).toBe(404);
    }
    expect((await fetch(`${origin(second.url)}/index.html`)).status).toBe(200);
    await bench.down(env);
    await expect(fetch(`${origin(second.url)}/api/state`)).rejects.toThrow();
  }, 180_000);

  it("WI4 gives each case a new origin", async () => {
    const seen: string[] = [];
    await run({ name: "urls", runTask: async ({ url }) => { seen.push(new URL(url).origin); return { done: false, log: "" }; } });
    expect(seen.length).toBe(IDS.length);
    expect(new Set(seen).size).toBe(IDS.length);
  }, 180_000);

  it("WI7 refuses a verifier outside its app", async () => {
    const tasks = join(upstream, "apps/gmail/real-tasks.json");
    const original = readFileSync(tasks, "utf8");
    writeFileSync(tasks, original.replace("real-tasks/task_e1.py", "../../LICENSE"));
    try {
      const result = await run(noopAdapter(), [IDS[0]!]);
      expect(result.results[0]!.reasons.join()).toMatch(/harness: .*outside/);
    } finally {
      writeFileSync(tasks, original);
    }
  }, 180_000);

  it("WI8 fails a case when the app server never answers", async () => {
    const bin = mkdtempSync(join(tmpdir(), "foxbench-fake-py-"));
    writeFileSync(join(bin, "python3"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(bin, "python3"), 0o755);
    const slow = waiBenchmark({ startTimeoutMs: 500 });
    const env = await slow.up({ ...ctx, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    await expect(slow.start(env, cases.find((c) => c.id === IDS[0])!)).rejects.toThrow(/did not answer/);
    await slow.down(env);
  }, 60_000);

  it("WI9 check() fetches nothing and names what is missing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "foxbench-empty-"));
    const fresh = join(empty, "never-made");
    const result = await bench.check({ cacheDir: fresh, env: { ...process.env, PATH: empty } });
    expect(result).toMatchObject({ ready: false });
    expect(JSON.stringify(result)).toMatch(/python3/);
    expect(existsSync(fresh)).toBe(false);
    expect(await bench.check(ctx)).toEqual({ ready: true });
  });
});
