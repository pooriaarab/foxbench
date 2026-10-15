// Tests for the LLM judge failure modes in docs/failure-modes.md (J1-J8), on
// a small scripted benchmark whose cases are questions an LLM judge scores.
// The judges are fakes: an in-process judge, a fake Messages API and a fake
// llama-server. No test calls a real API.
import { spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { claudeJudge, DEFAULT_JUDGE_MODEL, judgesFrom, judgeWith, localJudge, type Judge } from "../src/bench/judge.js";
import { runBenchmarks } from "../src/bench/run.js";
import type { Benchmark, Case } from "../src/bench/types.js";
import { toMarkdown } from "../src/score.js";

const root = join(import.meta.dirname, "..");
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, "dist/cli.js"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ANTHROPIC_API_KEY: "" } });
const CAPITALS: Record<string, string> = { fr: "Paris", jp: "Tokyo", pe: "Lima" };
const CASES: Case[] = Object.keys(CAPITALS).map((id) => ({ id, tags: ["toy"], judge: "llm" }));
const KEY = "sk-ant-test-DO-NOT-LEAK";

/** The verdict line a WebJudge-style rubric asks the judge for. */
const parse = (reply: string) => {
  const m = /Status:\s*(success|failure)/i.exec(reply);
  if (!m) throw new Error("the reply has no Status line");
  return { success: m[1]!.toLowerCase() === "success", reasons: m[1]!.toLowerCase() === "success" ? [] : [reply.slice(0, 200)] };
};

/** A judged benchmark: the agent answers in its log, and the judges compare the answer with the reference. */
function quiz(scoring: "llm" | "mixed" = "llm"): Benchmark {
  return {
    id: `quiz-${scoring}`, title: "quiz", upstream: { repo: "test", ref: "test" }, licence: { code: "MIT", data: "MIT", mode: "vendored" },
    where: "local", measures: ["task"], scoring, baselines: [],
    check: async () => ({ ready: true }),
    load: async () => CASES,
    up: async (ctx) => ({ judges: ctx.judges ?? [] }),
    async start(_env, item) {
      const server = createServer((_req, res) => res.end(`<p>Name the capital of ${item.id}.</p>`));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as { port: number };
      return { url: `http://127.0.0.1:${port}/`, goal: `Name the capital (${item.id}).`, startPath: "/", close: () => new Promise<void>((r) => server.close(() => r())) };
    },
    judge: async (env, episode, output) => judgeWith(env.judges as Judge[], {
      system: "You judge whether an answer matches the reference. End with a line `Status: success` or `Status: failure`.",
      prompt: `Reference: ${CAPITALS[/\((\w+)\)/.exec(episode.goal)![1]!]}\nAnswer: ${output.log}`,
    }, parse),
    down: async () => {},
  };
}

/** A fake judge that says success when the answer holds the reference, or always the same thing. */
const fake = (name: string, mode: "fair" | "yes" | "throws" = "fair", where: Judge["where"] = "local"): Judge => ({
  name, model: `${name}-model`, where,
  async ask({ prompt }) {
    if (mode === "throws") throw new Error("boom");
    const [, want = "", answer = ""] = /Reference: (.*)\nAnswer: ([\s\S]*)/.exec(prompt) ?? [];
    return `Thoughts: compared.\nStatus: ${mode === "yes" || answer.includes(want) ? "success" : "failure"}`;
  },
});

const answerer = (name: string, answer: (country: string) => string): Adapter => ({
  name, runTask: async ({ goal }) => ({ done: true, log: answer(/\((\w+)\)/.exec(goal)![1]!) }),
});
const perfect = answerer("perfect", (c) => `The capital is ${CAPITALS[c]}.`);
const wrong = answerer("wrong", () => "The capital is Atlantis.");
const play = (adapter: Adapter, judges: Judge[] | undefined, bench = quiz()) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], ...(judges ? { judges } : {}) });

describe("J1 a judged benchmark scores the answer, not the claim", () => {
  it("noop 0, perfect 3/3, wrong 0", async () => {
    expect((await play(noopAdapter(), [fake("fake")])).passed).toBe(0);
    expect(await play(perfect, [fake("fake")])).toMatchObject({ tasks: 3, passed: 3 });
    expect((await play(wrong, [fake("fake")])).passed).toBe(0);
  });
});

describe("J2 no judge", () => {
  it("an llm benchmark with no judge is a skip row with a fix", async () => {
    const board = await play(perfect, []);
    expect(board.tasks).toBe(0);
    expect(board.skipped).toEqual([{ benchmark: "quiz-llm", reason: expect.stringContaining("judge"), fix: expect.stringContaining("ANTHROPIC_API_KEY") }]);
  });
  it("a judged case of a mixed benchmark fails with judge: no judge", async () => {
    const board = await play(perfect, undefined, quiz("mixed"));
    expect(board.passed).toBe(0);
    expect(board.results.every((r) => r.reasons[0] === "judge: no judge")).toBe(true);
  });
});

describe("J3 judges are picked by name before any case runs", () => {
  it("rejects an unknown name, claude with no key, local with no URL", () => {
    expect(() => judgesFrom({}, { names: ["gpt"] })).toThrow(/claude, local/);
    expect(() => judgesFrom({}, { names: ["claude"] })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => judgesFrom({}, { names: ["local"] })).toThrow(/--local-judge-url/);
    expect(judgesFrom({}, {})).toEqual([]);
  });
  it("defaults to every configured judge, claude first, with the default model", () => {
    const judges = judgesFrom({ ANTHROPIC_API_KEY: KEY, FOXBENCH_LOCAL_JUDGE_URL: "http://127.0.0.1:1" }, {});
    expect(judges.map((j) => [j.name, j.model, j.where])).toEqual([["claude", DEFAULT_JUDGE_MODEL, "cloud"], ["local", "unnamed", "local"]]);
    expect(DEFAULT_JUDGE_MODEL).toBe("claude-sonnet-5-5");
    expect(judgesFrom({ ANTHROPIC_API_KEY: KEY }, { names: ["claude"], model: "claude-haiku-5-5" })[0]!.model).toBe("claude-haiku-5-5");
  });
  it("the CLI stops before any case on a bad --judge", () => {
    const bad = cli("run", "--agent", "noop", "--judge", "gpt");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Unknown judge "gpt"/);
    const nokey = cli("run", "--agent", "noop", "--judge", "claude");
    expect(nokey.status).toBe(2);
    expect(nokey.stderr).toMatch(/ANTHROPIC_API_KEY/);
    expect(nokey.stderr).not.toMatch(/^pass|^fail/m);
  });
});

describe("J4 J6 two judges side by side, and who judged", () => {
  it("keeps both verdicts, the first decides, the board counts each", async () => {
    const board = await play(wrong, [fake("claude", "fair", "cloud"), fake("local", "yes")]);
    expect(board.passed).toBe(0);
    expect(board.results[0]!.judges).toEqual([
      { judge: "claude", model: "claude-model", where: "cloud", success: false, reasons: [expect.stringContaining("failure")] },
      { judge: "local", model: "local-model", where: "local", success: true, reasons: [] },
    ]);
    expect(board.judges).toEqual({ claude: { model: "claude-model", where: "cloud", cases: 3, passed: 0 }, local: { model: "local-model", where: "local", cases: 3, passed: 3 } });
    expect(board.fingerprint.judges).toEqual([{ name: "claude", model: "claude-model", where: "cloud" }, { name: "local", model: "local-model", where: "local" }]);
    const md = toMarkdown(board);
    expect(md).toMatch(/\| claude \| claude-model \| cloud \| 0\/3 \|/);
    expect(md).toMatch(/\| local \| local-model \| local \| 3\/3 \|/);
    expect(md).toContain("differ from the official judge");
  });
  it("judgedBy names the deciding model", async () => {
    const v = await judgeWith([fake("claude")], { system: "", prompt: "Reference: Paris\nAnswer: Paris" }, parse);
    expect(v).toMatchObject({ success: true, judgedBy: "llm:claude-model" });
  });
});

// A fake Messages API and a fake llama-server that record what they got.
const seen: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let reply: (path: string) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
const api = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  seen.push({ path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
  const out = reply(req.url ?? "");
  res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => api.close(() => r())));
const message = (text: string, stop = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });

describe("J8 the clients send the right request", () => {
  it("the Claude judge sends the key, the model and the prompt", async () => {
    seen.length = 0;
    reply = () => ({ status: 200, body: message("Status: success") });
    const judge = judgesFrom({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: base, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" }, { names: ["claude"] })[0]!;
    expect(await judge.ask({ system: "rubric", prompt: "the case" })).toBe("Status: success");
    expect(seen[0]).toMatchObject({ path: "/v1/messages", headers: { "x-api-key": KEY, "anthropic-workspace-id": "wrkspc_test" },
      body: { model: "claude-sonnet-5-5", system: "rubric", messages: [{ role: "user", content: "the case" }] } });
  });
  it("the local judge posts to /v1/chat/completions", async () => {
    seen.length = 0;
    reply = () => ({ status: 200, body: { choices: [{ message: { role: "assistant", content: "Status: failure" } }] } });
    const judge = localJudge({ url: `${base}/`, model: "webjudge-7b" });
    expect(await judge.ask({ system: "rubric", prompt: "the case" })).toBe("Status: failure");
    expect(seen[0]).toMatchObject({ path: "/v1/chat/completions", body: { model: "webjudge-7b", messages: [{ role: "system", content: "rubric" }, { role: "user", content: "the case" }] } });
  });
});

describe("J5 J7 a judge error fails the case, the run goes on, and the key never shows", () => {
  it("an HTTP error, a refusal, a reply with no verdict, a throw", async () => {
    const claude = claudeJudge({ apiKey: KEY, model: "claude-haiku-5-5", baseURL: base, maxRetries: 0 });
    const ask = { system: "", prompt: "Reference: Paris\nAnswer: Paris" };
    reply = () => ({ status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } } });
    const http = await judgeWith([claude], ask, parse);
    expect(http).toMatchObject({ success: false, reasons: [expect.stringMatching(/^judge: claude: /)] });
    reply = () => ({ status: 200, body: message("", "refusal") });
    expect((await judgeWith([claude], ask, parse)).reasons[0]).toMatch(/^judge: claude: .*refus/);
    reply = () => ({ status: 200, body: { choices: [{ message: { content: "I think it is fine." } }] } });
    expect((await judgeWith([localJudge({ url: base })], ask, parse)).reasons[0]).toMatch(/^judge: local: .*Status/);
    const board = await play(perfect, [fake("claude", "throws")]);
    expect(board).toMatchObject({ tasks: 3, passed: 0 });
    expect(board.results.every((r) => r.reasons[0]!.startsWith("judge: claude: boom"))).toBe(true);
    expect(JSON.stringify(board) + toMarkdown(board) + JSON.stringify(http)).not.toContain(KEY);
  });
});

describe("J9 images", () => {
  it("the Claude judge sends each image as a block before the prompt, and the local judge refuses them", async () => {
    seen.length = 0;
    reply = () => ({ status: 200, body: message("match") });
    const claude = claudeJudge({ apiKey: KEY, baseURL: base, maxRetries: 0 });
    const images = [{ mediaType: "image/png" as const, data: "cG5n" }, { mediaType: "image/jpeg" as const, data: "anBn" }];
    expect(await claude.ask({ system: "s", prompt: "same?", images })).toBe("match");
    expect(seen[0]!.body).toMatchObject({ messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "cG5n" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "anBn" } },
      { type: "text", text: "same?" }] }] });
    seen.length = 0;
    await expect(localJudge({ url: base }).ask({ system: "s", prompt: "same?", images })).rejects.toThrow("the local judge takes no images");
    expect(seen).toEqual([]);
  });
});
