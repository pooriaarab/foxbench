// GAIA (Mialon et al., 2023), validation set: general-assistant questions
// that need the web, some with an attached file. GAIA is gated on Hugging Face
// and must not be reshared, so it runs only through the user's own access
// (HF_TOKEN from an account that accepted its terms), stays in the cache, and
// is redacted from boards. Answers are scored by GAIA's own question_scorer
// (quasi-exact match) from the leaderboard space, through uv.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { pickSubset } from "./subsets.js";
import { OPEN_WEB_NOTE } from "./open-web.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness } from "./types.js";
import { locked } from "./webgames.js";

/** The `gaia-benchmark/GAIA` dataset revision of 2025-10-28. */
export const GAIA_DATASET_REF = "682dd723ee1e1697e00360edccf2366dc8418dd9";
/** The `gaia-benchmark/leaderboard` space revision of 2026-05-03; its scorer.py is the official scorer. */
export const GAIA_SCORER_REF = "9f133d71362e77b3539f1514f31b9c101a545fec";
const SCORER_URL = `https://huggingface.co/spaces/gaia-benchmark/leaderboard/raw/${GAIA_SCORER_REF}/scorer.py`;
const ACCESS_URL = "https://huggingface.co/datasets/gaia-benchmark/GAIA";

interface GaiaTask {
  task_id: string;
  Question: string;
  Level: string | number;
  "Final answer": string;
  file_name: string | null;
}

const dataDir = (ctx: BenchContext) => join(ctx.cacheDir, `gaia-${GAIA_DATASET_REF.slice(0, 12)}`);
const helpers = (ctx: BenchContext) => join(ctx.cacheDir, "foxbench-helpers");
const fileUrl = (ctx: BenchContext, name: string) =>
  `${(ctx.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/+$/, "")}/datasets/gaia-benchmark/GAIA/resolve/${GAIA_DATASET_REF}/2023/validation/${name}`;

// The helper lives in foxbench's own directory and loads the scorer by path (Q7).
const SCORE = `import contextlib, importlib.util, json, sys, warnings
warnings.simplefilter("ignore")
spec = importlib.util.spec_from_file_location("gaia_scorer", sys.argv[1])
scorer = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(sys.stderr):
    spec.loader.exec_module(scorer)
for line in sys.stdin:
    q = json.loads(line)
    with contextlib.redirect_stdout(sys.stderr):
        correct = bool(scorer.question_scorer(q["prediction"], q["gold"]))
    print(json.dumps({"correct": correct}), flush=True)
`;

/** Runs a helper and returns its stdout. The error never quotes the helper's output, which can hold GAIA text (Q2). */
function helper(ctx: BenchContext, args: string[], input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("uv", args, { env: ctx.env, timeout: 300_000, maxBuffer: 1 << 26 }, (error, stdout) =>
      error ? reject(new Error(`a GAIA helper failed (exit ${child.exitCode ?? "?"})`)) : resolve(stdout));
    child.stdin!.end(input);
  });
}

const fetchFile = async (ctx: BenchContext, name: string, to: string) => {
  const res = await fetch(fileUrl(ctx, name), { headers: { authorization: `Bearer ${ctx.env.HF_TOKEN ?? ""}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for a GAIA file`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
};

/** The validation tasks, fetched once at the pinned revision into the cache. */
async function loadTasks(ctx: BenchContext): Promise<GaiaTask[]> {
  const file = join(dataDir(ctx), "metadata.parquet");
  await locked(dataDir(ctx), async () => {
    if (existsSync(file)) return;
    mkdirSync(dataDir(ctx), { recursive: true });
    await fetchFile(ctx, "metadata.parquet", `${file}.part`);
    renameSync(`${file}.part`, file);
  });
  return (await parquetReadObjects({ file: await asyncBufferFromFile(file), compressors })) as GaiaTask[];
}

/** The scorer's command: uv, isolated, python -I, the helper from foxbench's own directory (Q7). */
export const scorerCommand = (ctx: BenchContext): [string, string[]] =>
  ["uv", ["run", "--isolated", "--no-project", "--with", "numpy", "python", "-I", join(helpers(ctx), "gaia_score.py"), join(ctx.cacheDir, `gaia-scorer-${GAIA_SCORER_REF.slice(0, 12)}`, "scorer.py")]];

const fetchScorer = (ctx: BenchContext) => locked(join(ctx.cacheDir, `gaia-scorer-${GAIA_SCORER_REF.slice(0, 12)}`), async () => {
  const file = scorerCommand(ctx)[1].at(-1)!;
  mkdirSync(helpers(ctx), { recursive: true });
  writeFileSync(join(helpers(ctx), "gaia_score.py"), SCORE);
  if (existsSync(file)) return;
  const res = await fetch(SCORER_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} for the GAIA scorer`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, await res.text());
});

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const level = (t: GaiaTask) => Number(t.Level);
const TIERS = { 1: "easy", 2: "medium", 3: "hard" } as const;

/** The start page: the question, the attached file when there is one (Q6), and a search form. */
async function startPage(ctx: BenchContext, task: GaiaTask) {
  const name = task.file_name ? basename(task.file_name) : "";
  const file = name ? join(dataDir(ctx), "files", name) : "";
  if (file && !existsSync(file)) {
    mkdirSync(join(file, ".."), { recursive: true });
    await fetchFile(ctx, name, file);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>GAIA</title><main data-case="${escape(task.task_id)}"><p>${escape(task.Question)}</p>
${name ? `<p>Attached file: <a href="/files/${encodeURIComponent(name)}">${escape(name)}</a></p>` : ""}
<form action="https://www.google.com/search" method="get"><input name="q" aria-label="Search the web"><button>Search</button></form>
<p>${OPEN_WEB_NOTE}</p></main>`;
  const server = createServer((req, res) => {
    if (name && req.url === `/files/${encodeURIComponent(name)}`) return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(file));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const golds = new WeakMap<Episode, string>();

export const gaiaBenchmark = (): Benchmark => {
  let tasks: GaiaTask[] = [];
  let context: BenchContext | null = null;
  return {
    id: "gaia",
    title: "GAIA (validation)",
    upstream: { repo: ACCESS_URL, ref: GAIA_DATASET_REF, paper: "https://arxiv.org/abs/2311.12983" },
    licence: { code: "unstated (gaia-benchmark/leaderboard scorer)", data: "gated, no licence stated; do not reshare", mode: "user-access" },
    where: "live-web",
    measures: ["task", "info-seeking"],
    scoring: "programmatic",
    redact: true,
    async check(ctx): Promise<Readiness> {
      if (spawnSync("uv", ["--version"], { env: ctx.env }).status !== 0) return { ready: false, reason: "uv is not installed (the GAIA scorer needs it)", fix: "install uv: https://docs.astral.sh/uv/" };
      if (!ctx.env.HF_TOKEN?.trim()) return { ready: false, reason: "GAIA is gated and HF_TOKEN is not set", fix: `set HF_TOKEN for an account that accepted the terms at ${ACCESS_URL}` };
      if (existsSync(join(dataDir(ctx), "metadata.parquet"))) return { ready: true };
      const res = await fetch(fileUrl(ctx, "metadata.parquet"), { method: "HEAD", headers: { authorization: `Bearer ${ctx.env.HF_TOKEN}` } }).catch(() => null);
      if (!res) return { ready: false, reason: "Hugging Face is not reachable, and GAIA is not in the cache", fix: "connect to the network once; the cache is used after that" };
      return res.ok ? { ready: true } : { ready: false, reason: `HF_TOKEN has no access to the gated GAIA dataset (HTTP ${res.status})`, fix: `accept the terms at ${ACCESS_URL} with the account of HF_TOKEN` };
    },
    async load(ctx, subset) {
      tasks = await loadTasks(ctx);
      // No goal: GAIA's text stays out of `foxbench list` and the boards (Q2).
      const all: Case[] = tasks.map((t) => ({ id: t.task_id, tags: [`level${level(t)}`], ...(level(t) in TIERS ? { tier: TIERS[level(t) as 1 | 2 | 3] } : {}) }));
      return pickSubset("gaia", all, subset);
    },
    async up(ctx) {
      context = ctx;
      tasks = await loadTasks(ctx);
      await fetchScorer(ctx);
      return {};
    },
    async start(_env, item) {
      const task = tasks.find((t) => t.task_id === item.id);
      if (!task || !context) throw new Error(`gaia has no case ${item.id}`);
      const page = await startPage(context, task);
      const episode: Episode = { url: page.url, goal: `${task.Question}\n\n${OPEN_WEB_NOTE} Use the web, and the attached file when there is one. Reply with the final answer only.`, startPath: "/", close: page.close };
      golds.set(episode, task["Final answer"]);
      return episode;
    },
    async judge(_env, episode, output) {
      const gold = golds.get(episode);
      if (gold === undefined || !context) throw new Error("gaia did not start this episode");
      const [cmd, args] = scorerCommand(context);
      if (cmd !== "uv") throw new Error("the GAIA scorer runs through uv");
      const out = await helper(context, args, `${JSON.stringify({ prediction: String(output.answer ?? output.log ?? ""), gold })}\n`);
      const success = (JSON.parse(out.trim().split("\n").at(-1)!) as { correct: boolean }).correct;
      // The reason never quotes the gold answer (Q2).
      return { success, attack: null, reasons: success ? [] : ["the answer does not match"], judgedBy: "programmatic" };
    },
    down: async () => {},
    baselines: [
      { agent: "HAL Generalist + Claude Sonnet 4.5", subset: "full", score: 0.7455, source: "https://hal.cs.princeton.edu/gaia" },
    ],
  };
};
