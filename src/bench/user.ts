// The user channel: the person who gave the goal, for benchmarks that test
// asking (tau2, Gaia2). A benchmark sets `Episode.userChannel`; the recording
// proxy serves it as a chat at /user/ on the agent's own origin. A scripted
// user answers by rule; a Claude user answers from the benchmark's scenario.
// The Ask Sam chat of the in-house sites is the same idea with fixed answers.
import Anthropic from "@anthropic-ai/sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BenchContext, Readiness } from "./types.js";

export const USER_PATH = "/user/";
/** tau2's user ends the conversation with one of these; the agent never sees them. */
export const STOP_TOKENS = ["###STOP###", "###TRANSFER###", "###OUT-OF-SCOPE###"];
export const DEFAULT_USER_MODEL = "claude-sonnet-5-5";

/** `at` is performance.now() when the line was said, to order it among a benchmark's own events. */
export interface UserTurn { from: "agent" | "user"; text: string; at: number }

export interface UserChannel {
  /** "scripted", or "llm:<model>" for the board (Q8). */
  by: string;
  /** The user's first line, shown before the agent asks (tau2's user opens the chat), or null. */
  opening(): Promise<string | null>;
  /** Sends one message from the agent and returns the user's answer, without stop tokens. */
  reply(message: string): Promise<string>;
  /** The agent's messages and the user's answers, in order. */
  turns: UserTurn[];
  /** Settles when the user ends the conversation (Q5). */
  ended: Promise<void>;
  /** True once the user has ended the conversation. */
  stopped: boolean;
  /** The first failed reply, or null (Q7). */
  error: string | null;
}

type History = { role: "user" | "assistant"; content: string }[];

/** One channel over a function that writes the user's next line from the history so far. */
function channel(by: string, next: (history: History) => Promise<string>, first: () => Promise<string | null>): UserChannel {
  let end: (() => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let opened: Promise<string | null> | undefined;
  const user: UserChannel = {
    by, turns: [], error: null, stopped: false,
    ended: new Promise<void>((resolve) => { end = resolve; }),
    opening: () => (opened ??= first().then((text) => (text === null ? null : clean(text)), (error: unknown) => {
      user.error ??= error instanceof Error ? error.message : String(error);
      throw error;
    })),
    reply(message) {
      // One reply at a time, in the order the messages came (Q10).
      const turn = queue.then(async () => {
        await user.opening();
        const sent = performance.now();
        const history: History = [...user.turns.map((t) => ({ role: t.from === "agent" ? "user" as const : "assistant" as const, content: t.text })), { role: "user", content: message }];
        let text: string;
        try {
          text = await next(history);
        } catch (error) {
          user.error ??= error instanceof Error ? error.message : String(error);
          throw error;
        }
        user.turns.push({ from: "agent", text: message, at: sent }, { from: "user", text: clean(text), at: performance.now() });
        if (STOP_TOKENS.some((t) => text.includes(t))) {
          user.stopped = true;
          end?.();
        }
        return clean(text);
      });
      queue = turn.catch(() => {});
      return turn;
    },
  };
  return user;
}

const clean = (text: string) => STOP_TOKENS.reduce((s, t) => s.split(t).join(""), text).trim();

/** A user who answers by rule. `answer` gets the agent's message and the turns so far. */
export function scriptedUser(options: { opening?: string; answer: (message: string, turns: UserTurn[]) => string }): UserChannel {
  const user: UserChannel = channel("scripted", async (history) => options.answer(history.at(-1)!.content, user.turns), async () => options.opening ?? null);
  return user;
}

export interface LlmUserOptions {
  /** The scenario: who the user is and what they want. */
  system: string;
  model: string;
  apiKey: string;
  /** Sent as anthropic-workspace-id when set (plan section 10). */
  workspaceId?: string;
  /** The agent's first line, so the user opens the chat, as tau2's orchestrator does. */
  greeting?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
}

/** A user played by Claude. The scenario is the system prompt; the agent's lines are `user` turns (Q6). */
export function llmUser(options: LlmUserOptions): UserChannel {
  const client = new Anthropic({
    apiKey: options.apiKey, maxRetries: options.maxRetries ?? 2,
    ...(options.workspaceId ? { defaultHeaders: { "anthropic-workspace-id": options.workspaceId } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const say = async (messages: History) => {
    const response = await client.messages.create({ model: options.model, max_tokens: 16000, system: options.system, messages, output_config: { effort: "low" } });
    if (response.stop_reason === "refusal") throw new Error(`${options.model} refused to answer`);
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!text) throw new Error(`${options.model} gave an empty answer (${response.stop_reason})`);
    return text;
  };
  const prefix: History = [];
  return channel(`llm:${options.model}`, (history) => say([...prefix, ...history]), async () => {
    if (!options.greeting) return null;
    const text = await say([{ role: "user", content: options.greeting }]);
    prefix.push({ role: "user", content: options.greeting }, { role: "assistant", content: text });
    return text;
  });
}

/** Whether a Claude user can run here. A missing key is a skip row, never a request (Q9). */
export const userReadiness = (ctx: BenchContext): Readiness =>
  ctx.env.ANTHROPIC_API_KEY ? { ready: true } : { ready: false, reason: "ANTHROPIC_API_KEY is not set, and this benchmark's user is played by Claude", fix: "export ANTHROPIC_API_KEY (and ANTHROPIC_WORKSPACE_ID when the key needs one)" };

/** A Claude user with the run's model and the key from the environment. */
export const claudeUser = (ctx: BenchContext, scenario: { system: string; greeting?: string }): UserChannel =>
  llmUser({ ...scenario, model: ctx.userModel ?? DEFAULT_USER_MODEL, apiKey: ctx.env.ANTHROPIC_API_KEY ?? "", ...(ctx.env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: ctx.env.ANTHROPIC_WORKSPACE_ID } : {}) });

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function chatPage(user: UserChannel, error = ""): Promise<string> {
  const opening = await user.opening();
  const lines = [...(opening ? [{ from: "user", text: opening }] : []), ...user.turns]
    .map((t) => (t.from === "user" ? `<li><strong>User:</strong><p class="user">${esc(t.text)}</p></li>` : `<li><strong>You:</strong><p class="agent">${esc(t.text)}</p></li>`)).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat with the user</title></head><body><main>
<h1>Chat with the user</h1><p>The person who gave you the task. Ask here when you need a detail or a decision.</p>
<ol style="list-style:none;padding:0">${lines}</ol>${error ? `<p role="alert">${esc(error)}</p>` : ""}
<form method="post" action="${USER_PATH}"><label for="q">Your message</label><textarea id="q" name="q" rows="3"></textarea><p><button type="submit">Send</button></p></form></main></body></html>`;
}

/** Answers GET and POST /user/ for the proxy (Q1). Returns the status it sent. */
export async function serveUser(user: UserChannel, req: IncomingMessage, res: ServerResponse): Promise<number> {
  const send = (status: number, html: string) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(html); return status; };
  try {
    if (req.method !== "POST") return send(200, await chatPage(user));
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const text = (new URLSearchParams(body).get("q") ?? "").trim().slice(0, 4000);
    if (!text) return send(400, await chatPage(user, "Write a message."));
    await user.reply(text);
    res.writeHead(303, { location: USER_PATH }).end();
    return 303;
  } catch {
    // The error goes to the board through `user.error`, never to the agent as the user's words (Q7).
    return send(502, "<!doctype html><title>Chat</title><p role=\"alert\">The user is not available.</p>");
  }
}
