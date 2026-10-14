// Tests for the user channel failure modes in docs/failure-modes.md (Q1-Q10),
// on a toy benchmark whose answer only the user knows: the agent must ask in
// the chat at /user/ which colour to order. The Claude user runs on a fake
// fetch; no test calls the Anthropic API.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import type { Benchmark, Episode } from "../src/bench/types.js";
import { llmUser, scriptedUser, userReadiness, type UserChannel } from "../src/bench/user.js";

const KEY = "sk-ant-test-0123456789";
const ordered = new WeakMap<Episode, { colours: string[]; userHits: number }>();

/** The toy shop: one form that orders a colour. `user` makes the case's user. */
function shop(user: () => UserChannel): Benchmark {
  return {
    id: "toyshop", title: "toy shop", upstream: { repo: "test", ref: "test" }, licence: { code: "MIT", data: "MIT", mode: "vendored" },
    where: "local", measures: ["task", "ask-user"], scoring: "programmatic", baselines: [],
    check: async () => ({ ready: true }),
    load: async () => [{ id: "colour", tags: [] }],
    up: async () => ({}),
    async start() {
      const seen = { colours: [] as string[], userHits: 0 };
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        if (req.url?.startsWith("/user")) seen.userHits += 1;
        if (req.method === "POST") seen.colours.push(new URLSearchParams(body).get("colour") ?? "");
        res.end('<form method="post" action="/order"><input name="colour"></form>');
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as { port: number };
      const episode: Episode = { url: `http://127.0.0.1:${port}/`, goal: "Order a shirt in the colour I want. Ask me in the chat at /user/.", startPath: "/", userChannel: user(),
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
      ordered.set(episode, seen);
      return episode;
    },
    async judge(_env, episode) {
      const { colours } = ordered.get(episode)!;
      const success = colours.length === 1 && colours[0] === "teal";
      return { success, attack: null, reasons: success ? [] : [`ordered ${colours.join(", ") || "nothing"}`], judgedBy: "programmatic" };
    },
    down: async () => {},
  };
}

const teal = () => scriptedUser({ opening: "Hi, I need a shirt.", answer: (q) => (/colou?r/i.test(q) ? "Teal, please." : "I don't know.") });
const bye = () => scriptedUser({ answer: () => "Thanks, that is all. ###STOP###" });
const page = async (origin: string) => (await fetch(`${origin}/user/`)).text();
const say = (origin: string, q: string) => fetch(`${origin}/user/`, { method: "POST", body: new URLSearchParams({ q }), redirect: "manual" });
const answers = (html: string) => [...html.matchAll(/<p class="user">([^<]*)<\/p>/g)].map((m) => m[1]!);

/** Asks (or not), then orders what the user said, or a guess. */
function shopper(mode: "ask" | "guess" | "ask-only" | "wait", seen: { pages: string[]; statuses: number[] } = { pages: [], statuses: [] }): Adapter {
  let stop: (() => void) | undefined;
  return {
    name: mode,
    async runTask({ url }) {
      const origin = new URL(url).origin;
      seen.pages.push(await page(origin));
      let colour = "red";
      if (mode !== "guess") {
        seen.statuses.push((await say(origin, "Which colour would you like?")).status);
        const html = await page(origin);
        seen.pages.push(html);
        colour = /teal/i.test(answers(html).at(-1) ?? "") ? "teal" : "red";
      }
      if (mode === "wait") await new Promise<void>((r) => { stop = r; });
      if (mode !== "ask-only") await fetch(`${origin}/order`, { method: "POST", body: new URLSearchParams({ colour }) });
      return { done: true, log: mode };
    },
    abort: async () => stop?.(),
  };
}

const run = (bench: Benchmark, adapter: Adapter, extra = {}) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], graceMs: 200, ...extra });

/** A fake Anthropic API: records each request and answers with `say(i)`, or with an error status. */
function fakeApi(script: (i: number) => string | { status: number } | { refusal: true }, delay: (i: number) => number = () => 0) {
  const calls: { url: string; headers: Headers; body: { model: string; system: string; messages: { role: string; content: string }[] } }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const i = calls.length;
    calls.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    await new Promise((r) => setTimeout(r, delay(i)));
    const out = script(i);
    if (typeof out === "object" && "status" in out) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), { status: out.status, headers: { "content-type": "application/json" } });
    const refusal = typeof out === "object";
    return new Response(JSON.stringify({ id: `msg_${i}`, type: "message", role: "assistant", model: "m", content: refusal ? [] : [{ type: "text", text: out }],
      stop_reason: refusal ? "refusal" : "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fakeFetch };
}
const claude = (api: ReturnType<typeof fakeApi>, extra = {}) =>
  llmUser({ system: "You are Yusuf. You want a teal shirt.", greeting: "Hi! How can I help you today?", model: "claude-haiku-5-5", apiKey: KEY, fetch: api.fetch, ...extra });

describe("Q4 asking is needed and is not enough", () => {
  it("noop and guessing score 0, asking then acting passes with 1 ask, asking only fails", async () => {
    expect((await run(shop(teal), noopAdapter())).passed).toBe(0);
    expect(await run(shop(teal), shopper("guess"))).toMatchObject({ passed: 0, asks: 0 });
    expect(await run(shop(teal), shopper("ask"))).toMatchObject({ passed: 1, asks: 1, results: [{ asks: 1, success: true }] });
    expect(await run(shop(teal), shopper("ask-only"))).toMatchObject({ passed: 0, asks: 1 });
  });
});

describe("Q1 the chat is on the agent's origin and in the trace", () => {
  it("serves /user/ from the proxy, never the site, and logs the ask", async () => {
    let episode: Episode | undefined;
    const bench = shop(teal);
    const start = bench.start.bind(bench);
    bench.start = async (env, item) => (episode = await start(env, item));
    const judge = bench.judge.bind(bench);
    let trace: { method: string; path: string }[] = [];
    bench.judge = async (env, ep, output, t) => { trace = t.requests; return judge(env, ep, output, t); };
    await run(bench, shopper("ask"));
    expect(ordered.get(episode!)!.userHits).toBe(0);
    expect(trace.filter((r) => r.path === "/user/").map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
  });
});

describe("Q2 the chat shows no answer before the agent asks", () => {
  it("shows the opening line only, then the turns", async () => {
    const seen = { pages: [] as string[], statuses: [] as number[] };
    await run(shop(teal), shopper("ask", seen));
    expect(seen.pages[0]).toContain("Hi, I need a shirt.");
    expect(seen.pages[0]).not.toMatch(/teal/i);
    expect(seen.pages[1]).toContain("Which colour would you like?");
    expect(answers(seen.pages[1]!).at(-1)).toBe("Teal, please.");
  });
});

describe("Q3 an empty message is refused and not counted", () => {
  it("answers 400 and records no ask", async () => {
    const user = teal();
    const bench = shop(() => user);
    const adapter: Adapter = { name: "blank", async runTask({ url }) {
      expect((await say(new URL(url).origin, "   ")).status).toBe(400);
      return { done: false, log: "" };
    } };
    expect(await run(bench, adapter)).toMatchObject({ asks: 0 });
    expect(user.turns).toEqual([]);
  });
});

describe("Q5 the user's stop ends the episode", () => {
  it("aborts the agent, records endedEarly, and hides the token", async () => {
    const seen = { pages: [] as string[], statuses: [] as number[] };
    const started = Date.now();
    const board = await run(shop(bye), shopper("wait", seen));
    expect(board.results[0]).toMatchObject({ endedEarly: true, asks: 1 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.pages[1]).toContain("Thanks, that is all.");
    expect(seen.pages[1]).not.toContain("###STOP###");
  });
});

describe("Q6 the Claude user gets the model, the scenario and the turns in order", () => {
  it("opens with the greeting, then sends agent lines as user turns", async () => {
    const api = fakeApi((i) => ["Hi, I want to exchange a shirt.", "Teal, please."][i]!);
    const user = claude(api);
    expect(await user.opening()).toBe("Hi, I want to exchange a shirt.");
    expect(await user.reply("Which colour?")).toBe("Teal, please.");
    expect(api.calls).toHaveLength(2);
    const last = api.calls[1]!;
    expect(last.url).toBe("https://api.anthropic.com/v1/messages");
    expect(last.body).toMatchObject({ model: "claude-haiku-5-5", system: "You are Yusuf. You want a teal shirt." });
    expect(last.body.messages).toEqual([
      { role: "user", content: "Hi! How can I help you today?" },
      { role: "assistant", content: "Hi, I want to exchange a shirt." },
      { role: "user", content: "Which colour?" },
    ]);
    expect(user).toMatchObject({ by: "llm:claude-haiku-5-5", turns: [{ from: "agent", text: "Which colour?" }, { from: "user", text: "Teal, please." }] });
  });
  it("the context names the user model from the flag, claude-sonnet-5-5 by default", () => {
    expect(benchContext({ env: {} }).userModel).toBe("claude-sonnet-5-5");
    expect(benchContext({ env: {}, userModel: "claude-haiku-5-5" }).userModel).toBe("claude-haiku-5-5");
  });
});

describe("Q7 a failed user reply fails the case", () => {
  for (const [name, out] of [["an API error", { status: 400 }], ["a refusal", { refusal: true }]] as const) {
    it(`answers 502 on ${name}, records no turn, and fails with a harness reason`, async () => {
      const seen = { pages: [] as string[], statuses: [] as number[] };
      const api = fakeApi((i) => (i === 0 ? "Hi." : out));
      const board = await run(shop(() => claude(api, { maxRetries: 0 })), shopper("ask", seen));
      expect(seen.statuses).toEqual([502]);
      expect(board.results[0]).toMatchObject({ success: false, asks: 0 });
      expect(board.results[0]!.reasons[0]).toMatch(/^harness: the simulated user failed: /);
    });
  }
});

describe("Q8 the board names the user", () => {
  it("names scripted and llm users per result, and the llm model in the fingerprint", async () => {
    expect((await run(shop(teal), shopper("ask"))).results[0]!.user).toBe("scripted");
    const api = fakeApi((i) => ["Hi.", "Teal, please."][i]!);
    const board = await run(shop(() => claude(api)), shopper("ask"));
    expect(board).toMatchObject({ passed: 1, results: [{ user: "llm:claude-haiku-5-5" }], fingerprint: { users: ["llm:claude-haiku-5-5"] } });
  });
});

describe("Q9 the key goes only to the API", () => {
  it("sends the key and workspace id as headers, and the board holds neither", async () => {
    const api = fakeApi((i) => ["Hi.", "Teal, please."][i]!);
    const board = await run(shop(() => claude(api, { workspaceId: "wrkspc_test42" })), shopper("ask"));
    expect(api.calls[0]!.headers.get("x-api-key")).toBe(KEY);
    expect(api.calls[0]!.headers.get("anthropic-workspace-id")).toBe("wrkspc_test42");
    expect(JSON.stringify(board)).not.toContain(KEY);
    expect(JSON.stringify(board)).not.toContain("wrkspc_test42");
  });
  it("a missing key is not ready, with the fix", () => {
    expect(userReadiness(benchContext({ env: {} }))).toMatchObject({ ready: false, reason: expect.stringMatching(/ANTHROPIC_API_KEY/), fix: expect.any(String) });
    expect(userReadiness(benchContext({ env: { ANTHROPIC_API_KEY: KEY } }))).toEqual({ ready: true });
  });
});

describe("Q10 replies run one at a time", () => {
  it("answers two messages in the order they came, even when the first is slow", async () => {
    const api = fakeApi((i) => ["Hi.", "first", "second"][i]!, (i) => (i === 1 ? 200 : 0));
    const user = claude(api);
    await user.opening();
    const both = await Promise.all([user.reply("one"), user.reply("two")]);
    expect(both).toEqual(["first", "second"]);
    expect(user.turns.map((t) => t.text)).toEqual(["one", "first", "two", "second"]);
    expect(api.calls[2]!.body.messages.map((m) => m.content)).toEqual(["Hi! How can I help you today?", "Hi.", "one", "first", "two"]);
  });
});
