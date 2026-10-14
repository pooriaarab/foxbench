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
import type { Benchmark, Episode, Verdict } from "../types.js";

export const MINIWOB_REPO = "https://github.com/Farama-Foundation/miniwob-plusplus.git";
export const MINIWOB_COMMIT = "33c3b4ddef8c6eb67c57a29663d844b1eda7e614";

/** 30 tasks over five kinds of web work. The seed of each is fixed, so two runs see the same problem. */
export const MINIWOB_TASKS = [
  ...["click-button", "click-button-sequence", "click-checkboxes", "click-collapsible", "click-dialog", "click-link", "click-option", "click-tab-2", "click-widget", "navigate-tree"].map((id) => [id, "click"]),
  ...["enter-text", "enter-password", "focus-text", "login-user", "login-user-popup", "form-sequence-2", "use-spinner", "choose-list"].map((id) => [id, "form"]),
  ...["search-engine", "use-autocomplete", "phone-book", "social-media"].map((id) => [id, "search"]),
  ...["choose-date-easy", "choose-date", "enter-date", "enter-time"].map((id) => [id, "date"]),
  ...["book-flight", "email-inbox", "multi-orderings", "social-media-some"].map((id) => [id, "multi-step"]),
].map(([id = "", kind = ""], i) => ({ id, kind, seed: 1000 + i }));
type MiniwobTask = (typeof MINIWOB_TASKS)[number];

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
export async function startMiniwob(html: string, task: MiniwobTask, goal: string | null) {
  const nonce = Math.random().toString(36).slice(2);
  const state = { goals: [] as string[], rewards: [] as { raw: number; reward: number; reason: string }[] };
  const signals: (() => void)[] = [];
  const ended = new Promise<void>((resolve) => signals.push(resolve));
  const path = `/miniwob/${task.id}.html`;
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
 * The goal each task's seed makes, read in a real Firefox the way BrowserGym
 * reads it (core.getUtterance after the episode starts). Cached per commit
 * and per browser: a goal can hold a time in the browser's time zone and
 * locale, and Ichabod's Firefox has others than this computer's.
 */
export async function prepareGoals(html: string, cache: string, firefox?: string): Promise<Record<string, string>> {
  const { browserMode, launch, tunnel } = await import("create-foxkit/e2e");
  const remote = browserMode() === "ichabod";
  const file = join(cache, `miniwob-goals-${MINIWOB_COMMIT.slice(0, 12)}${remote ? "-ichabod" : ""}.json`);
  const cached = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const missing = MINIWOB_TASKS.filter((t) => !cached[`${t.id}#${t.seed}`]);
  if (missing.length) {
    const fox = await launch({ extension: EXTENSION, headless: true, ...(firefox && !remote ? { firefox } : {}) });
    try {
      for (const task of missing) {
        const run = await startMiniwob(html, task, null);
        // Ichabod cannot reach 127.0.0.1: open the page on the shared tunnel.
        const mount = remote ? await tunnel(Number(new URL(run.url).port)) : null;
        const page = await fox.open(mount ? `${mount.url}${run.startPath}` : run.url);
        for (let i = 0; i < 100 && !run.state.goals.length; i++) await new Promise((r) => setTimeout(r, 50));
        await page.close();
        await mount?.close();
        await run.close();
        if (!run.state.goals.length) throw new Error(`MiniWoB task ${task.id} did not start in Firefox`);
        cached[`${task.id}#${task.seed}`] = run.state.goals[0];
      }
    } finally {
      await fox.close();
    }
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, `${JSON.stringify(cached, null, 2)}\n`);
  }
  return cached;
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
const judges = new WeakMap<Episode, () => Promise<Verdict>>();

/** 30 MiniWoB++ tasks, judged by the page's own reward. Fetches MiniWoB++ and prepares the goals in up(). */
export const miniwobBenchmark: Benchmark = {
  id: "miniwob",
  title: "MiniWoB++ (30 tasks)",
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
  load: async (_ctx, subset) => pickSubset("miniwob", MINIWOB_TASKS.map((t) => ({ id: t.id, tags: [t.kind] })), subset),
  async up(ctx) {
    const html = fetchMiniwob(ctx.cacheDir);
    return { html, goals: await prepareGoals(html, ctx.cacheDir, ctx.firefox) };
  },
  async start(env, item) {
    const task = MINIWOB_TASKS.find((t) => t.id === item.id)!;
    const run = await startMiniwob(env.html as string, task, (env.goals as Record<string, string>)[`${task.id}#${task.seed}`] ?? null);
    const episode: Episode = { url: run.url, goal: run.goal ?? "", startPath: run.startPath, ended: run.ended, close: run.close };
    judges.set(episode, run.judge);
    return episode;
  },
  judge: async (_env, episode) => judges.get(episode)!(),
  down: async () => {},
  baselines: [],
};
