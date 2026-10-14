// AssistantBench (Yoran et al., 2024): realistic, time-consuming questions
// on the open web. foxbench runs the 33 dev tasks, as HAL does. The agent
// starts on a local page with the question and a search form, then works on
// the live web. Its answer is scored by AssistantBench's own question_scorer
// (partial credit), fetched from BrowserGym at a pinned commit and run
// through uv. The dataset and the scorer stay in the cache, never committed.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { pickSubset } from "./subsets.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness } from "./types.js";
import { locked } from "./webgames.js";

const run = promisify(execFile);

/** The `AssistantBench/AssistantBench` dataset revision of 2024-07-26. */
export const AB_DATASET_REF = "482cbbc0400f6d048438c4021727f21a10cbff49";
const DATASET_URL = `https://huggingface.co/datasets/AssistantBench/AssistantBench/resolve/${AB_DATASET_REF}/assistant_bench_v1.0_dev.jsonl`;
/** The BrowserGym commit of 2026-10-05; its `browsergym/assistantbench` holds the official scorer. */
export const AB_SCORER_REF = "e71419aef5759a11cb7896a26c36e5f7e92d82b2";
const SCORER_REPO = "https://github.com/ServiceNow/BrowserGym.git";
const EVALUATOR = "browsergym/assistantbench/src/browsergym/assistantbench";

export interface AssistantbenchTask {
  id: string;
  task: string;
  answer: string;
  difficulty: string;
}

const datasetFile = (ctx: BenchContext) => join(ctx.cacheDir, `assistantbench-${AB_DATASET_REF.slice(0, 12)}`, "dev.jsonl");
export const scorerDir = (ctx: BenchContext) => join(ctx.cacheDir, `browsergym-${AB_SCORER_REF.slice(0, 12)}`);
const helperFile = (ctx: BenchContext) => join(ctx.cacheDir, "foxbench-helpers", "assistantbench_score.py");

// Reads one {prediction, gold} per line and writes upstream's accuracy. It imports only the evaluator package, by path (A6).
const HELPER = `import json, sys
sys.path.insert(0, sys.argv[1])
from evaluation.evaluator import question_scorer
for line in sys.stdin:
    q = json.loads(line)
    accuracy, has_answer = question_scorer(q["prediction"], q["gold"])
    print(json.dumps({"accuracy": float(accuracy)}), flush=True)
`;

/** The 33 dev tasks, fetched once at the pinned revision. */
export async function loadTasks(ctx: BenchContext): Promise<AssistantbenchTask[]> {
  const file = datasetFile(ctx);
  await locked(join(file, ".."), async () => {
    if (existsSync(file)) return;
    const res = await fetch(DATASET_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} for the AssistantBench dataset`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, await res.text());
  });
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => {
    const row = JSON.parse(l) as AssistantbenchTask;
    return { id: row.id, task: row.task, answer: row.answer, difficulty: row.difficulty };
  });
}

/** The scorer at the pinned commit, only its own directory checked out (A1). */
const fetchScorer = (ctx: BenchContext): Promise<string> => locked(scorerDir(ctx), async () => {
  const dir = scorerDir(ctx);
  if (!existsSync(join(dir, EVALUATOR, "evaluation", "evaluator.py"))) {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => run("git", ["-C", dir, ...args], { env: ctx.env });
    await git("init", "-q");
    await git("sparse-checkout", "set", "--no-cone", `${EVALUATOR}/evaluation`);
    await git("fetch", "-q", "--depth", "1", "--filter=blob:none", SCORER_REPO, AB_SCORER_REF);
    await git("checkout", "-q", "FETCH_HEAD");
  }
  mkdirSync(join(helperFile(ctx), ".."), { recursive: true });
  writeFileSync(helperFile(ctx), HELPER);
  return dir;
});

/** The scorer's command: uv, isolated, python -I, the helper from foxbench's own directory (A6). */
export const scorerCommand = (ctx: BenchContext): [string, string[]] =>
  ["uv", ["run", "--isolated", "--no-project", "--with", "numpy", "--with", "scipy", "python", "-I", helperFile(ctx), join(scorerDir(ctx), EVALUATOR)]];

/** Upstream's accuracy, from 0 to 1, for one answer. */
async function score(ctx: BenchContext, prediction: string, gold: string): Promise<number> {
  const [cmd, args] = scorerCommand(ctx);
  const child = execFile(cmd, args, { env: ctx.env, timeout: 300_000 });
  child.stdin!.end(`${JSON.stringify({ prediction, gold })}\n`);
  let out = "";
  child.stdout!.on("data", (d: Buffer) => { out += String(d); });
  let err = "";
  child.stderr!.on("data", (d: Buffer) => { err += String(d); });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`the AssistantBench scorer exited ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`);
  return (JSON.parse(out.trim().split("\n").at(-1)!) as { accuracy: number }).accuracy;
}

// The answer format follows the scorer: it reads a JSON list as several items (A4).
const goalFor = (task: string) =>
  `${task}\n\nUse the web to find the answer. Reply with the final answer only. If the answer has several items, reply with a JSON list of them.`;

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A local start page with the question and a search form, as BrowserGym starts at google.com (A8). */
async function startPage(item: AssistantbenchTask) {
  const html = `<!doctype html><meta charset="utf-8"><title>AssistantBench</title><main data-case="${item.id}"><p>${escape(item.task)}</p>
<form action="https://www.google.com/search" method="get"><input name="q" aria-label="Search the web"><button>Search</button></form></main>`;
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const golds = new WeakMap<Episode, string>();

export const assistantbenchBenchmark = (): Benchmark => {
  let tasks: AssistantbenchTask[] = [];
  let context: BenchContext | null = null;
  return {
    id: "assistantbench",
    title: "AssistantBench (dev)",
    upstream: { repo: "https://huggingface.co/datasets/AssistantBench/AssistantBench", ref: AB_DATASET_REF, paper: "https://arxiv.org/abs/2407.15711" },
    licence: { code: "Apache-2.0", data: "Apache-2.0", mode: "fetch-at-run" },
    where: "live-web",
    measures: ["task", "info-seeking"],
    scoring: "programmatic",
    async check(ctx): Promise<Readiness> {
      for (const [cmd, fix] of [["uv", "install uv: https://docs.astral.sh/uv/"], ["git", "install git"]] as const) {
        if (spawnSync(cmd, ["--version"], { env: ctx.env }).status !== 0) return { ready: false, reason: `${cmd} is not installed (the AssistantBench scorer needs it)`, fix };
      }
      return { ready: true };
    },
    async load(ctx, subset) {
      tasks = await loadTasks(ctx);
      const all: Case[] = tasks.map((t) => ({ id: t.id, tags: [t.difficulty.toLowerCase()], tier: t.difficulty.toLowerCase() === "hard" ? "hard" : "medium", goal: t.task }));
      return pickSubset("assistantbench", all, subset);
    },
    async up(ctx) {
      context = ctx;
      tasks = await loadTasks(ctx);
      await fetchScorer(ctx);
      return {};
    },
    async start(_env, item) {
      const task = tasks.find((t) => t.id === item.id);
      if (!task) throw new Error(`assistantbench has no case ${item.id}`);
      const page = await startPage(task);
      const episode: Episode = { url: page.url, goal: goalFor(task.task), startPath: "/", close: page.close };
      golds.set(episode, task.answer);
      return episode;
    },
    async judge(_env, episode, output) {
      const gold = golds.get(episode);
      if (gold === undefined || !context) throw new Error("assistantbench did not start this episode");
      const accuracy = await score(context, String(output.answer ?? output.log ?? ""), gold);
      const success = accuracy === 1;
      return { success, score: accuracy, attack: null, reasons: success ? [] : [`accuracy ${accuracy.toFixed(2)}`], judgedBy: "programmatic" };
    },
    down: async () => {},
    baselines: [
      { agent: "HAL Browser-Use + o3 (mean accuracy)", subset: "full", score: 0.3881, source: "https://hal.cs.princeton.edu/assistantbench" },
      { agent: "HAL Browser-Use + GPT-5 (mean accuracy)", subset: "full", score: 0.3523, source: "https://hal.cs.princeton.edu/assistantbench" },
    ],
  };
};
