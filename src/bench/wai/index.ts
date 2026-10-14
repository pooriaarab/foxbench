// WebArena-Infinity: generated web apps whose tasks a Python verifier checks
// against the app's state (GET /api/state). The page pushes its state to its
// server, so any browser works. foxbench starts each app's server.py on its
// own port, resets it before each case, and runs the task's own verifier.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pickSubset } from "../subsets.js";
import type { BenchContext, Benchmark, Case, Env, Episode, Readiness } from "../types.js";
import { fetchUpstream, WAI_REF, WAI_REPO } from "./fetch.js";
import { resetApp, startApp, stopApp, type AppServer } from "./servers.js";
import { runVerifier, writeHelper } from "./verify.js";

export { WAI_REF } from "./fetch.js";
const run = promisify(execFile);
const KIND = "real";

interface TaskDef { id: string; difficulty?: "easy" | "medium" | "hard"; instruction: string; verify: string }
type WaiEnv = { upstream: string; helper: string; stage: string; env: NodeJS.ProcessEnv; servers: Map<string, Promise<AppServer>> };
const running = new WeakMap<Episode, { app: string; verify: string; port: number }>();

const apps = (upstream: string) => readdirSync(join(upstream, "apps")).filter((a) => existsSync(join(upstream, "apps", a, `${KIND}-tasks.json`))).sort();
const tasksOf = (upstream: string, app: string): TaskDef[] => JSON.parse(readFileSync(join(upstream, "apps", app, `${KIND}-tasks.json`), "utf8"));

/** Case ids are `<app>/real/<task id>`. */
const toCase = (app: string, t: TaskDef): Case => ({ id: `${app}/${KIND}/${t.id}`, tags: [app, KIND, ...(t.difficulty ? [t.difficulty] : [])], ...(t.difficulty ? { tier: t.difficulty } : {}), goal: t.instruction });

async function tool(env: NodeJS.ProcessEnv, cmd: string, ...args: string[]): Promise<string | null> {
  return run(cmd, args, { env }).then((r) => r.stdout, () => null);
}

let counter = 0;

/** `startTimeoutMs` is how long an app server gets to answer. */
export const waiBenchmark = (options: { startTimeoutMs?: number } = {}): Benchmark => ({
  id: "webarena-infinity",
  title: "WebArena-Infinity",
  upstream: { repo: WAI_REPO, ref: WAI_REF },
  licence: { code: "MIT", data: "MIT (tasks and verifiers live in the same repo)", mode: "fetch-at-run" },
  where: "local",
  measures: ["task"],
  scoring: "programmatic",
  async check(ctx): Promise<Readiness> {
    if ((await tool(ctx.env, "python3", "--version")) === null) return { ready: false, reason: "python3 is not installed", fix: "install python3 (3.10 or later)" };
    if ((await tool(ctx.env, "python3", "-I", "-c", "import requests")) === null) return { ready: false, reason: "python3 cannot import requests, which the task verifiers use", fix: "install requests for the system python3, for example `apt install python3-requests`" };
    if ((await tool(ctx.env, "git", "--version")) === null) return { ready: false, reason: "git is not installed, so the pinned upstream cannot be fetched", fix: "install git" };
    return { ready: true };
  },
  async load(ctx: BenchContext, subset) {
    const upstream = await fetchUpstream(ctx.cacheDir);
    return pickSubset("webarena-infinity", apps(upstream).flatMap((app) => tasksOf(upstream, app).map((t) => toCase(app, t))), subset);
  },
  async up(ctx): Promise<Env> {
    const upstream = await fetchUpstream(ctx.cacheDir);
    return { upstream, helper: writeHelper(ctx.cacheDir), stage: mkdtempSync(join(ctx.cacheDir, "wai-run-")), env: ctx.env, servers: new Map() } satisfies WaiEnv;
  },
  async start(raw, item) {
    const env = raw as WaiEnv;
    const [app, , taskId] = item.id.split("/") as [string, string, string];
    const task = tasksOf(env.upstream, app).find((t) => t.id === taskId);
    if (!task) throw new Error(`webarena-infinity has no task ${item.id}`);
    // The verifier must be a file inside its own app (WI7).
    const appDir = resolve(env.upstream, "apps", app);
    if (!resolve(appDir, task.verify).startsWith(appDir + sep)) throw new Error(`the verifier of ${item.id} is outside its app: ${task.verify}`);
    if (!env.servers.has(app)) env.servers.set(app, startApp(env.upstream, env.stage, app, env.env, options.startTimeoutMs ?? 10_000));
    const server = await env.servers.get(app)!.catch((error) => { env.servers.delete(app); throw error; });
    await resetApp(server);
    // A new origin per case, so the page's localStorage from an earlier case cannot be pushed over the reset (WI4).
    const url = `http://wai-${++counter}.localhost:${server.port}/`;
    const episode: Episode = { url, goal: task.instruction, startPath: "/" };
    running.set(episode, { app, verify: task.verify, port: server.port });
    return episode;
  },
  async judge(raw, episode) {
    const env = raw as WaiEnv;
    const run = running.get(episode);
    if (!run) throw new Error("webarena-infinity did not start this episode");
    const { passed, message } = await runVerifier(env.helper, join(env.upstream, "apps", run.app), run.verify, `http://127.0.0.1:${run.port}`, env.env);
    return { success: passed, attack: null, reasons: passed ? [] : [message], judgedBy: "programmatic" };
  },
  async down(raw) {
    const env = raw as WaiEnv;
    const started = await Promise.allSettled(env.servers.values());
    await Promise.all(started.flatMap((s) => (s.status === "fulfilled" ? [stopApp(s.value)] : [])));
    rmSync(env.stage, { recursive: true, force: true });
  },
  baselines: [],
});
