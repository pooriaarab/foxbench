// Online-Mind2Web (Xue et al., 2025): 300 tasks on 136 live sites. The task
// list is gated on Hugging Face (auto-approved), so it runs through the
// user's own HF_TOKEN and stays in the cache. The official judge is WebJudge
// with o4-mini; foxbench uses Claude or a local model through the judge
// interface, with a WebJudge-style rubric: first the task's key points, then
// the outcome from the key points and the agent's evidence. Screenshots are
// not part of it: the agent does not hand them over.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Judge } from "./judge.js";
import { judgeWith } from "./judge.js";
import { pickSubset } from "./subsets.js";
import { siteNote } from "./open-web.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness, Trace } from "./types.js";
import { locked } from "./webgames.js";

/** The `osunlp/Online-Mind2Web` revision of 2026-07-18, after the 2025-11 and 2026-05 task replacements. */
export const OM2W_DATASET_REF = "eacad896a84dc5b65e29b0b06e4699ab0544d701";
const ACCESS_URL = "https://huggingface.co/datasets/osunlp/Online-Mind2Web";

interface Om2wTask {
  task_id: string;
  website: string;
  task_description?: string;
  confirmed_task?: string;
  reference_length?: number;
  level?: string;
}

const listFile = (ctx: BenchContext) => join(ctx.cacheDir, `online-mind2web-${OM2W_DATASET_REF.slice(0, 12)}`, "Online_Mind2Web.json");
const listUrl = (ctx: BenchContext) => `${(ctx.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/+$/, "")}/datasets/osunlp/Online-Mind2Web/resolve/${OM2W_DATASET_REF}/Online_Mind2Web.json`;
const auth = (ctx: BenchContext) => ({ authorization: `Bearer ${ctx.env.HF_TOKEN ?? ""}` });
const describe = (t: Om2wTask) => t.task_description ?? t.confirmed_task ?? "";

/** Upstream's level, else the paper's rule on the human step count (M2W3). */
function tier(t: Om2wTask): "easy" | "medium" | "hard" {
  const level = t.level?.toLowerCase();
  if (level === "easy" || level === "medium" || level === "hard") return level;
  const n = t.reference_length ?? 0;
  return n <= 5 ? "easy" : n <= 10 ? "medium" : "hard";
}

async function loadTasks(ctx: BenchContext): Promise<Om2wTask[]> {
  const file = listFile(ctx);
  await locked(join(file, ".."), async () => {
    if (existsSync(file)) return;
    const res = await fetch(listUrl(ctx), { headers: auth(ctx) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for the Online-Mind2Web task list`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(`${file}.part`, await res.text());
    renameSync(`${file}.part`, file);
  });
  return JSON.parse(readFileSync(file, "utf8")) as Om2wTask[];
}

// The rubric follows WebJudge's two text steps (key points, then outcome) in foxbench's own words.
const KEY_POINTS = `You analyse a web task and list the key points it states explicitly.
A key point is a condition or step the task names: an item, a place, a date, a filter, a sort order ("cheapest", "newest" and the like mean a sort or filter must be applied). Do not add anything the task does not say.
Reply with "**Key Points**:" and a numbered list, one point per line, no explanations.`;

const OUTCOME = `You judge whether a web agent completed a user's task on live websites. You get the task, its key points, the agent's final answer, its own account of its actions, and the requests it made.
A task succeeds only when every key point is met: required filters and sort orders were applied exactly (a range must match, not be wider or narrower), a required submission or result page was reached, and the final answer holds what the task asked for. If the site truly has no match but the agent did the right steps, that is a success. An answer with no evidence of the steps is a failure.
Reply in two lines:
Thoughts: <your reasoning, point by point>
Status: "success" or "failure"`;

/** The agent's requests, as the judge reads them: method, host and path, status. */
const requests = (trace: Trace) => trace.requests.slice(0, 200).map((r) => `${r.method} ${r.host}${r.path} ${r.status}`).join("\n") || "(none)";

const parse = (reply: string) => {
  const m = /Status:\s*"?(success|failure)"?/i.exec(reply);
  if (!m) throw new Error("the reply has no Status line");
  const success = m[1]!.toLowerCase() === "success";
  return { success, reasons: success ? [] : [`judged a failure: ${(/Thoughts:\s*([^\n]*)/.exec(reply)?.[1] ?? "").slice(0, 300)}`] };
};

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A local start page with the task and a link to its site (M2W7). */
async function startPage(t: Om2wTask) {
  const html = `<!doctype html><meta charset="utf-8"><title>Online-Mind2Web</title><main data-case="${escape(t.task_id)}"><p>${escape(describe(t))}</p>
<p>Start at <a href="${escape(t.website)}">${escape(t.website)}</a>.</p>
<p>${escape(siteNote(t.website))}</p></main>`;
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const started = new WeakMap<Episode, Om2wTask>();

export const onlineMind2webBenchmark = (): Benchmark => {
  let tasks: Om2wTask[] = [];
  return {
    id: "online-mind2web",
    title: "Online-Mind2Web",
    upstream: { repo: ACCESS_URL, ref: OM2W_DATASET_REF, paper: "https://arxiv.org/abs/2504.01382" },
    licence: { code: "MIT (not used: the rubric is foxbench's)", data: "CC-BY-4.0", mode: "user-access" },
    where: "live-web",
    measures: ["task"],
    scoring: "llm",
    async check(ctx): Promise<Readiness> {
      if (!ctx.env.HF_TOKEN?.trim()) return { ready: false, reason: "the Online-Mind2Web task list is gated and HF_TOKEN is not set", fix: `set HF_TOKEN for an account that accepted the gate at ${ACCESS_URL} (auto-approved)` };
      if (existsSync(listFile(ctx))) return { ready: true };
      const res = await fetch(listUrl(ctx), { method: "HEAD", headers: auth(ctx) }).catch(() => null);
      if (!res) return { ready: false, reason: "Hugging Face is not reachable, and the task list is not in the cache", fix: "connect to the network once; the cache is used after that" };
      return res.ok ? { ready: true } : { ready: false, reason: `HF_TOKEN has no access to the gated task list (HTTP ${res.status})`, fix: `accept the gate at ${ACCESS_URL} with the account of HF_TOKEN` };
    },
    async load(ctx, subset) {
      tasks = await loadTasks(ctx);
      const all: Case[] = tasks.map((t) => ({ id: t.task_id, tags: [tier(t)], tier: tier(t), judge: "llm", goal: describe(t) }));
      return pickSubset("online-mind2web", all, subset);
    },
    async up(ctx) {
      tasks = await loadTasks(ctx);
      return { judges: ctx.judges ?? [] };
    },
    async start(_env, item) {
      const task = tasks.find((t) => t.task_id === item.id);
      if (!task) throw new Error(`online-mind2web has no case ${item.id}`);
      const page = await startPage(task);
      const episode: Episode = { url: page.url, goal: `${describe(task)}\n\nDo this on ${task.website}. ${siteNote(task.website)} When you are done, reply with what you found or did.`, startPath: "/", close: page.close };
      started.set(episode, task);
      return episode;
    },
    async judge(env, episode, output, trace) {
      const task = started.get(episode);
      if (!task) throw new Error("online-mind2web did not start this episode");
      // Each judge runs both rubric steps with its own model (M2W4).
      const staged = (env.judges as Judge[]).map((j): Judge => ({
        ...j,
        async ask() {
          const points = (await j.ask({ system: KEY_POINTS, prompt: `Task: ${describe(task)}` })).split(/Key Points\**:/i).at(-1)!.trim();
          return j.ask({
            system: OUTCOME,
            prompt: `User Task: ${describe(task)}\n\nKey Points: ${points}\n\nFinal answer:\n${String(output.answer ?? "") || "(none)"}\n\nAction History:\n${String(output.log ?? "") || "(none)"}\n\nRequests the agent made:\n${requests(trace)}`,
          });
        },
      }));
      return judgeWith(staged, { system: OUTCOME, prompt: "" }, parse);
    },
    down: async () => {},
    baselines: [
      { agent: "OpenAI Operator (human-judged)", subset: "full", score: 0.613, source: "https://arxiv.org/html/2504.01382" },
      { agent: "Claude Computer Use 3.7 (human-judged)", subset: "full", score: 0.563, source: "https://arxiv.org/html/2504.01382" },
      { agent: "Browser Use (human-judged)", subset: "full", score: 0.3, source: "https://arxiv.org/html/2504.01382" },
      { agent: "Fara1.5-9B (WebJudge, vendor-run)", subset: "full", score: 0.634, source: "https://github.com/microsoft/fara", vendorReported: true },
      { agent: "HAL SeeAct + GPT-5 (WebJudge)", subset: "full", score: 0.4233, source: "https://hal.cs.princeton.edu/online_mind2web" },
    ],
  };
};
