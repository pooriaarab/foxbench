// Tests for the tau2-airline benchmark failure modes in docs/failure-modes.md
// (T21-T23), through the run loop on tau2's real evaluator, with a scripted
// customer and a judge that fails the test if it is called.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { AIRLINE_WRITES } from "../src/bench/tau2/airline.js";
import { fetchTau2 } from "../src/bench/tau2/bridge.js";
import { tau2Benchmark, tau2Goal } from "../src/bench/tau2/index.js";
import { scriptedUser } from "../src/bench/user.js";
import { airlineStep, type Action } from "./fixtures/tau2-airline-agent.js";

interface Task { id: string; evaluation_criteria: { actions: Action[] | null; communicate_info?: string[] | null } }
let tasks: Task[] = [];
const judged: string[] = [];

beforeAll(async () => {
  tasks = JSON.parse(readFileSync(join(await fetchTau2(benchContext()), "data/tau2/domains/airline/tasks.json"), "utf8"));
}, 600_000);

const airline = () => tau2Benchmark("airline", { user: () => scriptedUser({ opening: "Hi, I need help with my booking.", answer: () => "Thank you." }) });
const inOrder = (ids: string[]) => tasks.map((t) => t.id).filter((id) => ids.includes(id));

/** perfect: the gold actions through the pages, then the facts to tell; wrong: without the last write. */
function agent(mode: "perfect" | "wrong", ids: string[], goals: string[] = []): Adapter {
  const queue = inOrder(ids);
  return {
    name: mode,
    async runTask({ url, goal }) {
      const origin = new URL(url).origin;
      const id = queue.shift();
      const task = tasks.find((t) => t.id === id)!;
      goals.push(goal);
      let steps = task.evaluation_criteria.actions ?? [];
      if (mode === "wrong") steps = steps.filter((a) => a !== steps.findLast((s) => AIRLINE_WRITES.has(s.name)));
      for (const a of steps) await airlineStep(origin, a);
      const facts = task.evaluation_criteria.communicate_info ?? [];
      await fetch(`${origin}/user/`, { method: "POST", body: new URLSearchParams({ q: `All done. ${facts.join(", ")}` }), redirect: "manual" });
      return { done: true, log: mode };
    },
  };
}
const run = (adapter: Adapter, ids: string[]) => runBenchmarks({ adapter, runs: [{ benchmark: airline(), subset: "full" }], ids, timeoutMs: 120_000,
  judges: [{ name: "claude", model: "fake-judge", where: "cloud", ask: async ({ prompt }) => { judged.push(prompt); return "{}"; } }] });
const NOOP_PASSES = ["0", "1", "2", "4", "5", "6", "9", "10", "13", "26", "27", "28", "31", "34", "36", "38", "41", "43", "45", "46", "47", "48", "49"];

describe("tau2-airline", () => {
  it("T21 T23 the gold actions through the pages pass all 50 tasks, with no judge call", async () => {
    const ids = tasks.map((t) => t.id);
    const goals: string[] = [];
    const board = await run(agent("perfect", ids, goals), ids);
    expect(board.results.filter((r) => !r.success).map((r) => `${r.id}: ${r.reasons.join("; ")}`)).toEqual([]);
    expect(board).toMatchObject({ tasks: 50, passed: 50 });
    expect(board.results.every((r) => r.reasons.length === 0)).toBe(true);
    expect(new Set(goals)).toEqual(new Set([tau2Goal("airline")]));
    expect(judged).toEqual([]);
  }, 900_000);

  it("T22 noop passes only the 23 tasks tau2 passes for doing nothing; a wrong agent fails", async () => {
    const all = tasks.map((t) => t.id);
    expect((await run(noopAdapter(), all)).results.filter((r) => r.success).map((r) => r.id)).toEqual(NOOP_PASSES);
    const writes = ["7", "8", "11", "12"];
    const wrong = await run(agent("wrong", writes), writes);
    expect(wrong.passed).toBe(0);
    expect(wrong.results.every((r) => r.reasons.includes("the database differs from tau2's gold database"))).toBe(true);
  }, 900_000);

  it("T23 every case is programmatic, and quick is tau2's test split", async () => {
    const quick = await airline().load(benchContext(), "quick");
    expect(quick).toHaveLength(20);
    expect(quick.every((c) => c.tags.includes("test") && c.judge === "programmatic")).toBe(true);
    expect(airline().scoring).toBe("programmatic");
  });
});
