// Odysseys (Jang et al., 2026): 200 long-horizon web tasks drawn from real
// browsing sessions, each with its own rubric of about six items. The task file
// is fetched at a pinned commit into the cache. Odysseys' judge is Gemini on
// screenshots; foxbench grades each rubric item 1 or 0 with Claude through the
// judge interface, from the agent's answer, action history and the proxy
// trace. A case passes when every item is met ("perfect"); `score` is the
// share met ("rubric average"). The agent starts at Google, as upstream does.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { TaskOutput } from "../adapter.js";
import { judgeWith, type Judge } from "./judge.js";
import { pickSubset } from "./subsets.js";
import { OPEN_WEB_NOTE } from "./open-web.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness, Trace, Verdict } from "./types.js";
import { locked } from "./webgames.js";

/** The `ljang0/Odysseys` commit of 2026-05-30 (MIT). */
export const ODYSSEYS_REF = "837814633ef948479abb3d142458f0acdb73fa65";
const FILE = { repo: "ljang0/Odysseys", ref: ODYSSEYS_REF, path: "data/odysseys.json" };

type Source = { repo: string; ref: string; path: string };
const rawUrl = (ctx: BenchContext, f: Source) => `${(ctx.env.FOXBENCH_RAW_URL ?? "https://raw.githubusercontent.com").replace(/\/+$/, "")}/${f.repo}/${f.ref}/${f.path}`;
const cached = (ctx: BenchContext, f: Source) => join(ctx.cacheDir, `${f.repo.replace("/", "-").toLowerCase()}-${f.ref.slice(0, 12)}`, f.path.replaceAll("/", "-"));

/** A file of a GitHub repo at a pinned commit, fetched once into the cache. */
export async function rawFile(ctx: BenchContext, f: Source): Promise<string> {
  const file = cached(ctx, f);
  await locked(join(file, ".."), async () => {
    if (existsSync(file)) return;
    const res = await fetch(rawUrl(ctx, f));
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.repo} ${f.path}`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(`${file}.part`, await res.text());
    renameSync(`${file}.part`, file);
  });
  return readFileSync(file, "utf8");
}

/** Preflight: in the cache, or reachable. */
export async function rawReady(ctx: BenchContext, f: Source): Promise<Readiness> {
  if (existsSync(cached(ctx, f))) return { ready: true };
  const res = await fetch(rawUrl(ctx, f), { method: "HEAD" }).catch(() => null);
  return res?.ok ? { ready: true } : { ready: false, reason: res ? `${f.repo} ${f.path} is not reachable (HTTP ${res.status})` : `GitHub is not reachable, and ${f.repo} is not in the cache`, fix: "connect to the network once; the cache is used after that" };
}

export const GRADE = `You grade a web agent's work on a task against a list of items. You get the task, the items, the agent's final answer, its own account of its actions, and the hosts and requests it made.
Grade each item 1 if the evidence shows it was met, else 0. The answer or the action history must show it: a claim with no sign of the steps behind it, or a source the agent never reached, does not count.
Reply in two lines:
Rubric: [one 1 or 0 per item, in order]
Thoughts: <your reasoning>`;

const hosts = (trace: Trace) => [...new Set(trace.requests.map((r) => r.host))].slice(0, 30).join(", ") || "(none)";
const requests = (trace: Trace) => trace.requests.slice(0, 200).map((r) => `${r.method} ${r.host}${r.path} ${r.status}`).join("\n") || "(none)";
export const evidence = (output: TaskOutput, trace: Trace) => `Final answer:\n${String(output.answer ?? "") || "(none)"}\n\nAction History:\n${String(output.log ?? "") || "(none)"}\n\nHosts the agent reached: ${hosts(trace)}\n\nRequests the agent made:\n${requests(trace)}`;

/** The 1s and 0s of a reply. With `n`, the list must have exactly that many (ODY4). */
export function parseGrades(reply: string, n?: number) {
  const list = /Rubric:\s*\[([^\]]*)\]/i.exec(reply)?.[1];
  if (list === undefined) throw new Error("the reply has no Rubric line");
  const grades = list.split(",").map((g) => Number(g.trim()));
  if (grades.some((g) => g !== 0 && g !== 1) || !grades.length || (n !== undefined && grades.length !== n)) throw new Error(`expected ${n ?? "some"} grades of 0 or 1, got "${list.slice(0, 80)}"`);
  const met = grades.reduce((a, b) => a + b, 0);
  return { success: met === grades.length, score: met / grades.length, reasons: met === grades.length ? [] : [`${grades.length - met} of ${grades.length} items not met: ${(/Thoughts:\s*([^\n]*)/.exec(reply)?.[1] ?? "").slice(0, 300)}`] };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A local start page with the task and a search form (ODY6). */
export async function startPage(id: string, task: string) {
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(id)}</title><main data-case="${esc(id)}"><p>${esc(task)}</p>
<form action="https://www.google.com/search" method="get"><input name="q" aria-label="Search the web"><button>Search</button></form>
<p>${OPEN_WEB_NOTE}</p></main>`;
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

interface Task { task_id: string; confirmed_task: string; level: "easy" | "medium" | "hard"; rubrics: Record<string, { requirement: string; verification: string }> }
const started = new WeakMap<Episode, Task>();

export const odysseysBenchmark = (): Benchmark => {
  let tasks: Task[] = [];
  const read = async (ctx: BenchContext) => (tasks = JSON.parse(await rawFile(ctx, FILE)) as Task[]);
  return {
    id: "odysseys",
    title: "Odysseys",
    upstream: { repo: "https://github.com/ljang0/Odysseys", ref: ODYSSEYS_REF, paper: "https://arxiv.org/abs/2604.24964" },
    licence: { code: "MIT", data: "MIT (repo); unstated for the task text", mode: "fetch-at-run" },
    where: "live-web",
    measures: ["task"],
    scoring: "llm",
    check: (ctx) => rawReady(ctx, FILE),
    async load(ctx, subset) {
      const all: Case[] = (await read(ctx)).map((t) => ({ id: t.task_id, tags: [t.level], tier: t.level, judge: "llm", goal: t.confirmed_task }));
      return pickSubset("odysseys", all, subset);
    },
    async up(ctx) {
      await read(ctx);
      return { judges: ctx.judges ?? [] };
    },
    async start(_env, item) {
      const task = tasks.find((t) => t.task_id === item.id);
      if (!task) throw new Error(`odysseys has no case ${item.id}`);
      const page = await startPage(task.task_id, task.confirmed_task);
      const episode: Episode = { url: page.url, goal: `${task.confirmed_task}\n\n${OPEN_WEB_NOTE} When you are done, reply with your answer.`, startPath: "/", close: page.close };
      started.set(episode, task);
      return episode;
    },
    async judge(env, episode, output, trace): Promise<Verdict> {
      const task = started.get(episode);
      if (!task) throw new Error("odysseys did not start this episode");
      const items = Object.entries(task.rubrics).map(([key, r]) => `${key}. Requirement: ${r.requirement}\n   Verify: ${r.verification}`).join("\n");
      return judgeWith(env.judges as Judge[], { system: GRADE, prompt: `Task: ${task.confirmed_task}\n\nItems:\n${items}\n\n${evidence(output, trace)}` }, (reply) => parseGrades(reply, Object.keys(task.rubrics).length));
    },
    down: async () => {},
    baselines: [
      { agent: "Claude Opus 4.6 (100 steps, Gemini judge)", subset: "full", score: 0.445, source: "https://arxiv.org/html/2604.24964v1" },
      { agent: "Qwen-3.5-9B (100 steps, Gemini judge)", subset: "full", score: 0.135, source: "https://arxiv.org/html/2604.24964v1" },
      { agent: "Qwen-3.5-4B (100 steps, Gemini judge)", subset: "full", score: 0.107, source: "https://arxiv.org/html/2604.24964v1" },
    ],
  };
};
