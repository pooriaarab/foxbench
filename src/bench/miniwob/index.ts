// MiniWoB++ as a foxbench benchmark. MiniWoB++ (MIT) is fetched at run
// time at a pinned commit; foxbench vendors none of its files. Each task runs
// the way BrowserGym runs it: the human display (goal, timer, reward) is
// removed, the seed is set, the episode has no time limit, and the goal goes
// to the agent as text. The verdict is MiniWoB's own reward, computed by the
// task's script in the page: BrowserGym counts a raw reward above 0 as a
// success. A small script in the page posts that reward to the server.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { serveCase } from "../serve.js";
import { pickSubset } from "../subsets.js";
import { MINIWOB_EPISODES, MINIWOB_TASKS } from "./tasks.js";
import type { Benchmark, Episode, Verdict } from "../types.js";

export const MINIWOB_REPO = "https://github.com/Farama-Foundation/miniwob-plusplus.git";
export const MINIWOB_COMMIT = "33c3b4ddef8c6eb67c57a29663d844b1eda7e614";

export type MiniwobEpisode = (typeof MINIWOB_EPISODES)[number];
/** The goal cache key: the same task and page seed make the same problem (E15). */
export const goalKey = (e: MiniwobEpisode) => `${e.task}#${e.seed}`;

/** Fetches MiniWoB++ at the pinned commit once, and returns its html directory. */
export function fetchMiniwob(dir: string) {
  const repo = join(dir, `miniwob-${MINIWOB_COMMIT.slice(0, 12)}`);
  if (!existsSync(join(repo, "miniwob", "html", "core", "core.js"))) {
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", MINIWOB_REPO, MINIWOB_COMMIT);
    git("checkout", "-q", "FETCH_HEAD");
  }
  return join(repo, "miniwob", "html");
}

// BrowserGym's setup script (browsergym/miniwob/base.py), plus two posts:
// the goal the page made, and the reward when the episode ends.
const bootstrap = (seed: number, nonce: string) => `<script>
window.addEventListener("load", function () { setTimeout(function () {
  var post = function (path, data) { fetch(path + "?nonce=${nonce}", { method: "POST", body: JSON.stringify(data), keepalive: true }); };
  var ids = ["reward-display", "click-canvas", "sync-task-cover"], kept = {}, query = null;
  var removeDisplay = function () {
    core.clearTimer();
    document.body.removeEventListener("click", core.canvasDrawClick);
    query = document.getElementById("query").cloneNode(true);
    document.getElementById("query").innerHTML = "";
    ids.forEach(function (id) { var el = document.getElementById(id); if (el) { el.remove(); kept[id] = el; } });
  };
  var bringBackDisplay = function () {
    document.getElementById("query").innerHTML = query.innerHTML;
    Object.keys(kept).forEach(function (id) { document.body.appendChild(kept[id]); });
    core.createDisplay();
  };
  var endLegacy = core.endEpisode, startLegacy = core.startEpisodeReal, utteranceLegacy = core.getUtterance;
  core.getUtterance = function () { bringBackDisplay(); var u = utteranceLegacy(); removeDisplay(); return u; };
  core.endEpisode = function (reward, timed, reason) {
    var open = core.EP_TIMER !== null;
    bringBackDisplay(); endLegacy(reward, timed, reason); removeDisplay();
    if (open) post("/__ext/reward", { raw: WOB_RAW_REWARD_GLOBAL, reward: WOB_REWARD_GLOBAL, reason: String(WOB_REWARD_REASON) });
  };
  core.startEpisodeReal = function () { bringBackDisplay(); startLegacy(); removeDisplay(); };
  removeDisplay();
  Math.seedrandom(${seed});
  core.EPISODE_MAX_TIME = 1000000;
  core.startEpisodeReal();
  var ready = function () { if (WOB_TASK_READY) post("/__ext/start", { goal: core.getUtterance() }); else setTimeout(ready, 50); };
  ready();
}, 0); });
</script>`;

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };

/** Starts one task's server. `goal` is the goal from prepare, or null while preparing. */
export async function startMiniwob(html: string, task: MiniwobEpisode, goal: string | null) {
  const nonce = Math.random().toString(36).slice(2);
  const state = { goals: [] as string[], rewards: [] as { raw: number; reward: number; reason: string }[] };
  const signals: (() => void)[] = [];
  const ended = new Promise<void>((resolve) => signals.push(resolve));
  const path = `/miniwob/${task.task}.html`;
  const server = await serveCase(async (req, body, url) => {
    if (url.pathname.startsWith("/__ext/")) {
      if (req.method !== "POST" || url.searchParams.get("nonce") !== nonce) return { status: 403, type: "text/plain", body: "forbidden" };
      const data = JSON.parse(body || "{}");
      if (url.pathname === "/__ext/start") state.goals.push(String(data.goal));
      if (url.pathname === "/__ext/reward") {
        state.rewards.push({ raw: Number(data.raw), reward: Number(data.reward), reason: data.reason });
        signals[0]!();
      }
      return { type: "text/plain", body: "ok" };
    }
    const file = normalize(join(html, url.pathname));
    if (!file.startsWith(html) || !existsSync(file) || url.pathname.endsWith("/")) return null;
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    if (url.pathname !== path) return { type, body: readFileSync(file) };
    return { type, body: readFileSync(file, "utf8").replace("</body>", `${bootstrap(task.seed, nonce)}</body>`) };
  });
  return {
    url: `${server.url}${path}`,
    goal,
    startPath: path,
    state,
    ended,
    async judge(): Promise<Verdict> {
      const reasons: string[] = [];
      // The first episode's reward counts; a later one comes from a reload.
      const first = state.rewards[0];
      const mismatch = state.goals.find((g) => g !== goal);
      if (mismatch !== undefined) reasons.push(`harness: the page made another goal: ${mismatch}`);
      if (!first) reasons.push("the episode did not end (no MiniWoB reward)");
      else if (!(first.raw > 0)) reasons.push(`MiniWoB reward ${first.raw}${first.reason && first.reason !== "null" ? ` (${first.reason})` : ""}`);
      return { success: Boolean(first && first.raw > 0 && mismatch === undefined), attack: null, reasons, ...(first ? { score: first.raw } : {}), judgedBy: "programmatic" };
    },
    close: server.close,
  };
}

/**
 * The goal each episode's seed makes, read in a real Firefox the way
 * BrowserGym reads it (core.getUtterance after the episode starts). Cached
 * per commit and per browser: a goal can hold a time in the browser's time
 * zone and locale, and Ichabod's Firefox has others than this computer's.
 * One Firefox serves the whole run, and opens on the first goal not cached,
 * so a quick run does not read all 625.
 */
export function goalReader(html: string, cache: string, firefox?: string) {
  let fox: Awaited<ReturnType<(typeof import("create-foxkit/e2e"))["launch"]>> | undefined;
  let goals: Record<string, string> | undefined;
  return {
    async goal(episode: MiniwobEpisode): Promise<string> {
      const { browserMode, launch, tunnel } = await import("create-foxkit/e2e");
      const remote = browserMode() === "ichabod";
      const file = join(cache, `miniwob-goals-${MINIWOB_COMMIT.slice(0, 12)}${remote ? "-ichabod" : ""}.json`);
      goals ??= existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const key = goalKey(episode);
      if (goals![key]) return goals![key]!;
      fox ??= await launch({ extension: EXTENSION, headless: true, ...(firefox && !remote ? { firefox } : {}) });
      const run = await startMiniwob(html, episode, null);
      // Ichabod cannot reach 127.0.0.1: open the page on the shared tunnel.
      const mount = remote ? await tunnel(Number(new URL(run.url).port)) : null;
      const page = await fox.open(mount ? `${mount.url}${run.startPath}` : run.url);
      for (let i = 0; i < 100 && !run.state.goals.length; i++) await new Promise((r) => setTimeout(r, 50));
      await page.close();
      await mount?.close();
      await run.close();
      if (!run.state.goals.length) throw new Error(`MiniWoB task ${episode.id} did not start in Firefox`);
      goals![key] = run.state.goals[0]!;
      mkdirSync(cache, { recursive: true });
      writeFileSync(file, `${JSON.stringify(goals, null, 2)}\n`);
      return goals![key]!;
    },
    close: async () => void (await fox?.close()),
  };
}

const tool = (command: string, env: NodeJS.ProcessEnv) => {
  try {
    execFileSync(command, ["--version"], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
/** The foxbench extension the Firefox driver installs (create-foxkit needs one). */
const EXTENSION = new URL("../../../dist-ext", import.meta.url).pathname;
/** Each episode's own judge. */
const tagsOf = (task: string) => {
  const t = MINIWOB_TASKS.find((x) => x.id === task)!;
  return [t.category, t.split];
};
const judges = new WeakMap<Episode, () => Promise<Verdict>>();

/** BrowserGym's 625 MiniWoB++ episodes, judged by the page's own reward. up() fetches MiniWoB++; start() reads the goal. */
export const miniwobBenchmark: Benchmark = {
  id: "miniwob",
  title: "MiniWoB++ (BrowserGym: 125 tasks x 5 seeds)",
  upstream: { repo: MINIWOB_REPO, ref: MINIWOB_COMMIT, paper: "https://arxiv.org/abs/1802.08802" },
  licence: { code: "MIT", data: "MIT", mode: "fetch-at-run" },
  where: "local",
  measures: ["task"],
  scoring: "programmatic",
  async check(ctx) {
    if (!tool("git", ctx.env)) return { ready: false, reason: "git is not on the PATH (MiniWoB++ is fetched with git)", fix: "install git" };
    if (!existsSync(join(EXTENSION, "manifest.json"))) return { ready: false, reason: "dist-ext/ is missing (the Firefox driver installs it)", fix: "run pnpm build:ext in the foxbench repo" };
    return import("create-foxkit/e2e").then(() => ({ ready: true as const }), () => ({ ready: false as const, reason: "create-foxkit is not installed (it drives Firefox)", fix: "pnpm install in the foxbench repo" }));
  },
  load: async (_ctx, subset) => pickSubset("miniwob", MINIWOB_EPISODES.map((e) => ({ id: e.id, tags: [e.task, ...tagsOf(e.task)] })), subset),
  async up(ctx) {
    const html = fetchMiniwob(ctx.cacheDir);
    return { html, goals: goalReader(html, ctx.cacheDir, ctx.firefox) };
  },
  async start(env, item) {
    const task = MINIWOB_EPISODES.find((e) => e.id === item.id)!;
    const run = await startMiniwob(env.html as string, task, await (env.goals as ReturnType<typeof goalReader>).goal(task));
    const episode: Episode = { url: run.url, goal: run.goal ?? "", startPath: run.startPath, ended: run.ended, close: run.close };
    judges.set(episode, run.judge);
    return episode;
  },
  judge: async (_env, episode) => judges.get(episode)!(),
  down: (env) => (env.goals as ReturnType<typeof goalReader>).close(),
  baselines: [["OrbyAgent (Claude 3.5 Sonnet)", 0.749], ["GenericAgent-GPT-5", 0.715], ["A3-Qwen3.5-9B", 0.69]].map(([agent, score]) => ({
    agent: agent as string,
    subset: "published",
    score: score as number,
    source: "https://huggingface.co/spaces/ServiceNow/browsergym-leaderboard",
  })),
};
