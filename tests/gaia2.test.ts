// Tests for the Gaia2 failure modes in docs/failure-modes.md (GA1-GA9),
// through the run loop on ARE's real code and three real scenarios. The LLM
// judge is a fake: no test calls an API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { ARE_REF, DATA_REF, dataDir, startBridge, type Gaia2Bridge, type OracleCall } from "../src/bench/gaia2/bridge.js";
import { gaia2Benchmark } from "../src/bench/gaia2/index.js";
import type { Judge } from "../src/bench/judge.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";

/** No free-text check; two free-text checks; two env events and a second turn. */
const HARD = "0060_20gzbu5axwurnrooquit6zgdiu8h51v0";
const SOFT = "0099_dys7qiasymc6tsiomethj9v7ofhlksfb";
const ADAPT = "0663_c4rhds3gn4hecrdzan4k442j69gsgzsl";
const CONFIGS = ["execution", "adaptability"];
const ctx = benchContext();
const benchmark = () => gaia2Benchmark({ configs: CONFIGS });
let oracle: Gaia2Bridge;
let order: string[] = [];
let listed: Awaited<ReturnType<ReturnType<typeof benchmark>["load"]>> = [];
const steps = new Map<string, OracleCall[]>();

beforeAll(async () => {
  listed = await benchmark().load(ctx, "full");
  order = listed.map((c) => c.id).filter((id) => [HARD, SOFT, ADAPT].includes(id));
  oracle = await startBridge(ctx, undefined, CONFIGS);
  for (const id of order) {
    await oracle.start(id, listed.find((c) => c.id === id)!.tags[0]!, false);
    steps.set(id, await oracle.oracle());
  }
}, 1_800_000);
afterAll(async () => { await oracle?.close(); });

/** A fake judge that meets every soft check, or none; `asked` counts its questions. */
const asked: string[] = [];
const fake = (met: boolean): Judge => ({ name: "claude", model: "fake-judge", where: "cloud", ask: async ({ prompt }) => { asked.push(prompt); return met ? "[[Success]] [[True]]" : "[[Failure]] [[False]]"; } });

const post = (origin: string, s: OracleCall) => fetch(`${origin}/apps/${s.app}/${s.tool}`, { method: "POST",
  body: new URLSearchParams({ go: "1", ...Object.fromEntries(Object.entries(s.args).filter(([, v]) => v !== null).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) }) });
/** perfect: ARE's oracle actions on its clock; wrong: without the last; garbled: the emails say something else. Once its `ids` are done it does nothing. */
function agent(mode: "perfect" | "wrong" | "garbled", ids = order): Adapter {
  const queue = [...ids];
  return { name: mode, async runTask({ url }) {
    const origin = new URL(url).origin;
    const t0 = Date.now();
    const id = queue.shift();
    let calls = id ? steps.get(id)! : [];
    if (mode === "wrong") calls = calls.slice(0, -1);
    for (const s of calls) {
      await new Promise((r) => setTimeout(r, Math.max(0, s.at * 1000 - (Date.now() - t0))));
      await post(origin, mode === "garbled" && s.tool === "send_email" ? { ...s, args: { ...s.args, content: "Hello, nothing to see here." } } : s);
    }
    return { done: true, log: mode };
  } };
}
const run = (adapter: Adapter, ids = order, judges?: Judge[], trials?: number) =>
  runBenchmarks({ adapter, runs: [{ benchmark: benchmark(), subset: "full" }], ids, timeoutMs: 180_000, ...(judges ? { judges } : {}), ...(trials ? { trials } : {}) });
const passed = (board: Awaited<ReturnType<typeof run>>) => board.results.filter((r) => r.success).map((r) => r.id);

describe("gaia2", () => {
  it("GA1 pins ARE and the data, and writes the licence beside the data", () => {
    expect([ARE_REF, DATA_REF].every((ref) => /^[0-9a-f]{40}$/.test(ref))).toBe(true);
    expect(readFileSync(join(dataDir(ctx), "NOTICE"), "utf8")).toMatch(/CC-BY-4\.0.*Llama/);
    expect(benchmark()).toMatchObject({ licence: { code: "MIT", mode: "fetch-at-run" }, upstream: { ref: ARE_REF } });
  });

  it("GA2 lists the scenarios with their capability and which need the judge", () => {
    expect(new Set(listed.map((c) => c.id)).size).toBe(320);
    expect(new Set(listed.map((c) => c.tags[0]))).toEqual(new Set(CONFIGS));
    expect(listed.filter((c) => c.judge === "programmatic").map((c) => c.id)).toContain(HARD);
    expect(listed.find((c) => c.id === SOFT)!.judge).toBe("llm");
  });

  it("GA3 ARE's oracle actions through the pages pass, with ARE's own judge", async () => {
    const board = await run(agent("perfect"), order, [fake(true)]);
    expect(board.results.map((r) => [r.id, r.success, r.reasons, r.judges, r.adapterError])).toEqual(order.map((id) => [id, true, [], undefined, false]));
  }, 900_000);

  it("GA4 noop and a run without the last oracle action score 0", async () => {
    expect(passed(await run(noopAdapter(), order, [fake(true)]))).toEqual([]);
    expect(passed(await run(agent("wrong"), order, [fake(true)]))).toEqual([]);
  }, 900_000);

  it("GA5 a second trial starts from a fresh environment", async () => {
    const board = await run(agent("perfect", [HARD]), [HARD], undefined, 2);
    expect(board.results.map((r) => r.success)).toEqual([true, false]);
  }, 600_000);

  it("GA6 the feed holds the user's task, and no page serves the oracle", async () => {
    const seen: string[] = [];
    const looker: Adapter = { name: "looker", async runTask({ url }) {
      const get = (path: string) => fetch(new URL(path, url));
      seen.push(await (await get("/notifications")).text(), String((await get("/oracle")).status), String((await get("/apps/SystemApp/oracle")).status));
      return { done: true, log: "" };
    } };
    await run(looker, [HARD], [fake(true)]);
    expect(seen[0]).toMatch(/USER_MESSAGE at \d+ s: Received at.*Sender: User/s);
    expect(seen.slice(1)).toEqual(["404", "404"]);
  }, 300_000);

  it("GA7 free-text arguments go to the run's judge only, and its verdict is marked", async () => {
    asked.length = 0;
    expect((await run(agent("garbled", [SOFT]), [SOFT], [fake(true)])).results[0]).toMatchObject({ success: true, judges: [{ model: "fake-judge" }] });
    expect(asked.length).toBeGreaterThan(0);
    expect((await run(agent("garbled", [SOFT]), [SOFT], [fake(false)])).results[0]).toMatchObject({ success: false, judges: [{ model: "fake-judge", success: false }] });
    asked.length = 0;
    const none = (await run(agent("garbled", [SOFT]), [SOFT])).results[0]!;
    expect([none.success, none.judges, asked]).toEqual([true, undefined, []]);
  }, 900_000);

  it("GA8 GA9 a stopped bridge fails each call at once, and a PATH without uv is not ready", async () => {
    const bridge = await startBridge(ctx, undefined, ["execution"]);
    await bridge.close();
    await expect(bridge.notifications()).rejects.toThrow(/stopped/);
    expect(await benchmark().check({ ...ctx, env: { PATH: "" } })).toMatchObject({ ready: false, fix: expect.stringContaining("install") });
  }, 300_000);
});
