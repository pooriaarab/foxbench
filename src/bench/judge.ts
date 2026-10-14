// LLM judges for cases that code cannot score: Online-Mind2Web's WebJudge,
// rubric checks, fuzzy answer matches. A case marked `judge: "llm"` asks each
// configured judge by name; the first one decides, and every verdict stays in
// the result so a board can show the cloud and the local judge side by side.
import Anthropic from "@anthropic-ai/sdk";
import type { Verdict } from "./types.js";

/** Who judges: the Claude API in the cloud, or an OpenAI-compatible llama-server here. */
export interface Judge {
  name: string;
  model: string;
  where: "cloud" | "local";
  /** One question, one reply. Throws on an HTTP error or a refusal. */
  ask(q: JudgeAsk): Promise<string>;
}

export interface JudgeAsk {
  system: string;
  prompt: string;
}

/** One judge's verdict on one case. */
export interface JudgeResult {
  judge: string;
  model: string;
  where: Judge["where"];
  success: boolean;
  score?: number;
  reasons: string[];
}

export const JUDGE_NAMES = ["claude", "local"] as const;
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";

/** The Claude API. The key comes from the environment and never leaves this client (J7). */
export function claudeJudge(o: { apiKey: string; model?: string; baseURL?: string; workspaceId?: string; maxRetries?: number }): Judge {
  const client = new Anthropic({
    apiKey: o.apiKey, authToken: null, baseURL: o.baseURL ?? "https://api.anthropic.com", timeout: 300_000,
    ...(o.maxRetries === undefined ? {} : { maxRetries: o.maxRetries }),
    ...(o.workspaceId ? { defaultHeaders: { "anthropic-workspace-id": o.workspaceId } } : {}),
  });
  const model = o.model ?? DEFAULT_JUDGE_MODEL;
  return {
    name: "claude", model, where: "cloud",
    async ask({ system, prompt }) {
      try {
        const res = await client.messages.create({ model, max_tokens: 16_000, system, messages: [{ role: "user", content: prompt }] });
        if (res.stop_reason === "refusal") throw new Error("the model refused to judge");
        return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      } catch (error) {
        throw new Error(scrub(error instanceof Error ? error.message : String(error), o.apiKey), { cause: error });
      }
    },
  };
}

/** An OpenAI-compatible chat endpoint, such as llama-server serving WebJudge-7B. */
export function localJudge(o: { url: string; model?: string }): Judge {
  const model = o.model ?? "unnamed";
  return {
    name: "local", model, where: "local",
    async ask({ system, prompt }) {
      const res = await fetch(`${o.url.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(600_000),
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${o.url}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("the reply has no message content");
      return text;
    },
  };
}

/**
 * The judges for a run, by name (J3). With no names, every judge that is
 * configured: claude when ANTHROPIC_API_KEY is set, local when a URL is.
 * Throws with what to set, before any case runs.
 */
export function judgesFrom(env: NodeJS.ProcessEnv, o: { names?: string[]; model?: string; localUrl?: string; localModel?: string }): Judge[] {
  const key = env.ANTHROPIC_API_KEY?.trim();
  const url = o.localUrl ?? env.FOXBENCH_LOCAL_JUDGE_URL?.trim();
  const names = o.names ?? [...(key ? ["claude"] : []), ...(url ? ["local"] : [])];
  for (const name of names) if (!(JUDGE_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown judge "${name}". The judges are ${JUDGE_NAMES.join(", ")}.`);
  return names.map((name) => {
    if (name === "claude") {
      if (!key) throw new Error("The claude judge needs ANTHROPIC_API_KEY in the environment.");
      return claudeJudge({ apiKey: key, model: o.model ?? DEFAULT_JUDGE_MODEL, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}), ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {}) });
    }
    if (!url) throw new Error("The local judge needs --local-judge-url or FOXBENCH_LOCAL_JUDGE_URL (an OpenAI-compatible llama-server).");
    const model = o.localModel ?? env.FOXBENCH_LOCAL_JUDGE_MODEL?.trim();
    return localJudge({ url, ...(model ? { model } : {}) });
  });
}

const scrub = (text: string, secret: string) => (secret ? text.split(secret).join("[key]") : text);

/**
 * Asks every judge about one case and parses each reply. The first judge
 * decides; a judge that throws or gives no verdict fails with a `judge:`
 * reason, and the others still run (J4, J5).
 */
export async function judgeWith(judges: Judge[], q: JudgeAsk, parse: (reply: string) => { success: boolean; score?: number; reasons: string[] }): Promise<Verdict> {
  if (!judges.length) return { success: false, attack: null, reasons: ["judge: no judge"], judgedBy: "programmatic" };
  const results = await Promise.all(judges.map(async (j): Promise<JudgeResult> => {
    try {
      return { judge: j.name, model: j.model, where: j.where, ...parse(await j.ask(q)) };
    } catch (error) {
      return { judge: j.name, model: j.model, where: j.where, success: false, reasons: [`judge: ${j.name}: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }));
  const first = results[0]!;
  return { success: first.success, ...(first.score === undefined ? {} : { score: first.score }), attack: null, reasons: first.reasons, judgedBy: `llm:${first.model}`, judges: results };
}
