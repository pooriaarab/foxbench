// Tests for the tau2-retail benchmark failure modes in docs/failure-modes.md
// (T9-T16), through the run loop on tau2's real code. The customer is a
// scripted user and the NL-assertion judge is a fake: no test calls an API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import type { Judge } from "../src/bench/judge.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { fetchTau2 } from "../src/bench/tau2/bridge.js";
import { TAU2_GOAL, tau2Benchmark } from "../src/bench/tau2/index.js";
import { RETAIL_WRITES } from "../src/bench/tau2/retail.js";
import { scriptedUser } from "../src/bench/user.js";
import { goldStep, type Action } from "./fixtures/tau2-agent.js";

interface Task { id: string; evaluation_criteria: { actions: Action[] | null; communicate_info?: string[] | null } }
let tasks: Task[] = [];
const byId = (id: string) => tasks.find((t) => t.id === id)!;
const prompts: string[] = [];

beforeAll(async () => {
  tasks = JSON.parse(readFileSync(join(await fetchTau2(benchContext()), "data/tau2/domains/retail/tasks.json"), "utf8"));
}, 600_000);

/** A fake judge that meets every NL assertion, or none. */
const fakeJudge = (met: boolean): Judge => ({
  name: "claude", model: "fake-judge", where: "cloud",
  ask: async ({ system, prompt }) => {
    prompts.push(system + prompt);
    return `\`\`\`json\n${JSON.stringify({ results: [{ expectedOutcome: "all", reasoning: "fake", metExpectation: met }] })}\n\`\`\``;
  },
});
/** A customer who opens with a fixed line and thanks the agent; `stop` ends the chat. */
const customer = (stop = false) => tau2Benchmark("retail", { user: () => scriptedUser({ opening: "Hi, I need help with my order.", answer: () => (stop ? "Thanks! ###STOP###" : "Thank you.") }) });

/**
 * The scripted agent. The cases run in `ids` order, so it knows which task it is on.
 * perfect: the gold actions through the pages, then the facts to tell in the chat;
 * wrong: the same but without the last write.
 */
function agent(mode: "perfect" | "wrong", ids: string[], seen: { goals: string[]; chats: string[] } = { goals: [], chats: [] }): Adapter {
  const queue = inOrder(ids);
  return {
    name: mode,
    async runTask({ url, goal }) {
      const origin = new URL(url).origin;
      const task = byId(queue.shift()!);
      seen.goals.push(goal);
      seen.chats.push(await (await fetch(`${origin}/user/`)).text());
      let steps = task.evaluation_criteria.actions ?? [];
      if (mode === "wrong") steps = steps.filter((a) => a !== steps.findLast((s) => RETAIL_WRITES.has(s.name)));
      for (const a of steps) await goldStep(origin, a);
      const facts = task.evaluation_criteria.communicate_info ?? [];
      await fetch(`${origin}/user/`, { method: "POST", body: new URLSearchParams({ q: `All done. ${facts.join(", ")}` }), redirect: "manual" });
      return { done: true, log: mode };
    },
  };
}
/** The cases run in tau2's task order, so the scripted agent takes its ids in that order too. */
const inOrder = (ids: string[]) => tasks.map((t) => t.id).filter((id) => ids.includes(id));
const run = (adapter: Adapter, ids: string[], options: { met?: boolean; judge?: boolean; stop?: boolean } = {}) =>
  runBenchmarks({ adapter, runs: [{ benchmark: customer(options.stop), subset: "full" }], ids, timeoutMs: 120_000, ...(options.judge === false ? {} : { judges: [fakeJudge(options.met ?? true)] }) });
const passed = (board: Awaited<ReturnType<typeof run>>) => board.results.filter((r) => r.success).map((r) => r.id);

const NO_WRITE = ["10", "12", "24", "25", "50", "57", "62", "65", "67", "68"];
const WRITES = ["0", "1", "5", "33", "64"];

describe("tau2-retail", () => {
  it("T9 T17 the gold actions through the pages pass 112 of 114 tasks on tau2's own evaluator", async () => {
    const ids = tasks.map((t) => t.id);
    const board = await run(agent("perfect", ids), ids);
    expect(board.results.filter((r) => !r.success).map((r) => `${r.id}: ${r.reasons.join("; ")}`)).toEqual(["21: the database differs from tau2's gold database", "100: the database differs from tau2's gold database"]);
    expect(board).toMatchObject({ tasks: 114, passed: 112, asks: 114, adapterErrors: 0 });
    expect(board.results.find((r) => r.id === "24")!.reasons).toEqual([]);
  }, 900_000);

  it("T10 noop passes only the 6 tasks tau2 itself passes for doing nothing", async () => {
    const board = await run(noopAdapter(), [...NO_WRITE, ...WRITES], { met: false });
    expect(passed(board)).toEqual(["10", "12", "25", "50", "57", "65"]);
  }, 300_000);

  it("T11 a wrong agent fails with a database reason", async () => {
    const board = await run(agent("wrong", WRITES.slice(0, 4)), WRITES.slice(0, 4));
    expect(board.passed).toBe(0);
    expect(board.results.every((r) => r.reasons.includes("the database differs from tau2's gold database"))).toBe(true);
  }, 300_000);

  it("T12 the agent sees one goal for every case, and only the customer's opening", async () => {
    const seen = { goals: [] as string[], chats: [] as string[] };
    await run(agent("perfect", ["0", "1"], seen), ["0", "1"]);
    expect(seen.goals).toEqual([TAU2_GOAL, TAU2_GOAL]);
    expect(seen.chats[0]).toContain("Hi, I need help with my order.");
    expect(seen.chats.join()).not.toMatch(/Yusuf|Reason for call|19122/);
  }, 300_000);

  it("T13 a customer's stop and an agent's return both end the conversation for tau2", async () => {
    expect((await run(agent("perfect", ["0", "1"]), ["0", "1"], { stop: true })).passed).toBe(2);
  }, 300_000);

  it("T14 NL assertions go to the run's judge with tau2's prompt, and the verdict names it", async () => {
    prompts.length = 0;
    const board = await run(agent("perfect", ["24", "10"]), ["24", "10"]);
    expect(board.results.map((r) => [r.id, r.success])).toEqual([["10", true], ["24", true]]);
    expect(prompts.join()).toMatch(/expected outcomes/i);
    expect(prompts.join()).toContain("polyester");
    const noJudge = await run(agent("perfect", ["24", "10"]), ["24", "10"], { judge: false });
    expect(noJudge.results.map((r) => [r.id, r.success])).toEqual([["10", true], ["24", false]]);
    expect(noJudge.results[1]!.reasons.join()).toMatch(/no LLM judge/);
    expect((await run(agent("perfect", ["24"]), ["24"], { met: false })).passed).toBe(0);
  }, 300_000);

  it("T15 check names a missing uv or API key", async () => {
    const bench = tau2Benchmark("retail");
    expect(await bench.check(benchContext({ env: { PATH: process.env.PATH } }))).toMatchObject({ ready: false, reason: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    expect(await bench.check(benchContext({ env: { PATH: "/nonexistent", ANTHROPIC_API_KEY: "k" } }))).toMatchObject({ ready: false, fix: expect.any(String) });
  });

  it("T16 quick is 20 tasks of tau2's test split", async () => {
    const quick = await customer().load(benchContext(), "quick");
    expect(quick).toHaveLength(20);
    expect(quick.every((c) => c.tags.includes("test"))).toBe(true);
    expect((await customer().load(benchContext(), "full")).length).toBe(114);
  });
});
