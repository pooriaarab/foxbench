// Tests for the Online-Mind2Web failure modes in docs/failure-modes.md
// (M2W1-M2W7). The task list is gated, so the dataset here is synthetic,
// served by a fake Hugging Face endpoint (HF_ENDPOINT) into a temporary cache.
// The judges are fakes; no test calls a real API.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import type { Judge, JudgeAsk } from "../src/bench/judge.js";
import { OM2W_DATASET_REF, onlineMind2webBenchmark } from "../src/bench/online-mind2web.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { toMarkdown } from "../src/score.js";

const TOKEN = "hf_fake_token";
const ROWS = [
  { task_id: "om-easy", website: "https://shop.example/", task_description: "Find the price of the blue kettle.", reference_length: 4 },
  { task_id: "om-mid", website: "https://rail.example/", task_description: "Find the first train to Leeds tomorrow.", reference_length: 8 },
  { task_id: "om-hard_051526", website: "https://flats.example/", task_description: "Find a two-bed flat under 900 a month.", reference_length: 9, level: "hard" },
];
const RIGHT: Record<string, string> = { "om-easy": "19 pounds", "om-mid": "06:12", "om-hard_051526": "12 Elm Road" };

const dir = mkdtempSync(join(tmpdir(), "fbn-om2w-"));
const saved = { ...process.env };
const bench = onlineMind2webBenchmark();
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(403).end("Access to dataset osunlp/Online-Mind2Web is restricted.");
  if (req.url !== `/datasets/osunlp/Online-Mind2Web/resolve/${OM2W_DATASET_REF}/Online_Mind2Web.json`) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" }).end(req.method === "HEAD" ? undefined : JSON.stringify(ROWS));
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { HF_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`, HF_TOKEN: TOKEN, FOXBENCH_CACHE: join(dir, "cache") });
});
afterAll(() => {
  process.env = saved;
  return new Promise<void>((r) => server.close(() => r()));
});

/** A fake judge: key points on the first step; on the outcome step, success when the final answer holds the right value. "mute" never gives a verdict. */
function fake(name: string, mode: "fair" | "mute" = "fair", calls: JudgeAsk[] = []): Judge {
  return {
    name, model: `${name}-model`, where: name === "claude" ? "cloud" : "local",
    async ask(q) {
      calls.push(q);
      if (q.prompt.startsWith("Task: ")) return "**Key Points**:\n1. Find the value the task asks for";
      if (mode === "mute") return "I am not sure.";
      const task = ROWS.find((r) => q.prompt.includes(r.task_description))!;
      const answer = /Final answer:\n([\s\S]*?)\n\nAction History:/.exec(q.prompt)![1]!;
      return `Thoughts: checked the key points.\nStatus: ${answer.includes(RIGHT[task.task_id]!) ? "success" : "failure"}`;
    },
  };
}

/** A scripted agent: it reads which case it is on from the start page and answers with `answer`. */
const scripted = (name: string, answer: (id: string) => string): Adapter => ({
  name,
  async runTask({ url, goal }) {
    const page = await (await fetch(url)).text();
    const id = /data-case="([^"]+)"/.exec(page)![1]!;
    expect(page).toContain("is allowed");
    expect(goal).toContain("is allowed");
    expect(goal).toContain(ROWS.find((r) => r.task_id === id)!.website);
    return { done: true, log: "clicked Search, read the result", answer: answer(id) };
  },
});
const play = (adapter: Adapter, judges: Judge[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], judges, timeoutMs: 30_000 });
const ctx = () => benchContext();

describe("Online-Mind2Web", () => {
  it("M2W2 check() wants a token with access", async () => {
    expect(await bench.check({ ...ctx(), env: { ...process.env, HF_TOKEN: "" } })).toMatchObject({ ready: false, reason: expect.stringContaining("HF_TOKEN"), fix: expect.any(String) });
    expect(await bench.check({ ...ctx(), env: { ...process.env, HF_TOKEN: "hf_other" } })).toMatchObject({ ready: false, reason: expect.stringContaining("no access"), fix: expect.stringContaining("huggingface.co/datasets/osunlp/Online-Mind2Web") });
    expect(await bench.check(ctx())).toEqual({ ready: true });
    const board = await play(scripted("perfect", (id) => RIGHT[id]!), []);
    expect(board.skipped).toEqual([expect.objectContaining({ benchmark: "online-mind2web", reason: expect.stringContaining("judge") })]);
  });

  it("M2W1 M2W3 the pinned list, with upstream ids and tiers", async () => {
    expect(OM2W_DATASET_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(bench).toMatchObject({ upstream: { ref: OM2W_DATASET_REF }, licence: { data: "CC-BY-4.0", mode: "user-access" }, where: "live-web", scoring: "llm" });
    const cases = await bench.load(ctx(), "full");
    expect(cases.map((c) => [c.id, c.tier, c.tags, c.judge])).toEqual([
      ["om-easy", "easy", ["easy"], "llm"], ["om-mid", "medium", ["medium"], "llm"], ["om-hard_051526", "hard", ["hard"], "llm"],
    ]);
    expect((await bench.load(ctx(), "tag:medium")).map((c) => c.id)).toEqual(["om-mid"]);
  });

  it("M2W4 M2W7 noop and wrong pass 0, perfect passes, and the judge sees both steps and the evidence", async () => {
    expect((await play(noopAdapter(), [fake("claude")])).passed).toBe(0);
    expect((await play(scripted("wrong", () => "I could not find it"), [fake("claude")])).passed).toBe(0);
    const calls: JudgeAsk[] = [];
    const board = await play(scripted("perfect", (id) => `It is ${RIGHT[id]}.`), [fake("claude", "fair", calls)]);
    expect(board).toMatchObject({ tasks: 3, passed: 3 });
    expect(calls).toHaveLength(6);
    const outcome = calls[1]!;
    expect(outcome.prompt).toContain("Key Points:");
    expect(outcome.prompt).toContain("Find the value the task asks for");
    expect(outcome.prompt).toContain("It is 19 pounds.");
    expect(outcome.prompt).toContain("clicked Search, read the result");
    expect(outcome.prompt).toMatch(/Requests the agent made:\nGET 127\.0\.0\.1:\d+\/ 200/);
    expect(outcome.system).toContain("Status:");
  });

  it("M2W5 M2W6 two judges side by side, and a judge with no verdict fails its case", async () => {
    const board = await play(scripted("perfect", (id) => RIGHT[id]!), [fake("claude"), fake("local", "mute")]);
    expect(board.passed).toBe(3);
    expect(board.judges).toEqual({ claude: { model: "claude-model", where: "cloud", cases: 3, passed: 3 }, local: { model: "local-model", where: "local", cases: 3, passed: 0 } });
    expect(board.results[0]!.judges![1]!.reasons[0]).toMatch(/^judge: local: .*Status/);
    expect(toMarkdown(board)).toContain("differ from the official judge");
    expect(bench.baselines.every((b) => /human|WebJudge/.test(b.agent))).toBe(true);
  });
});
