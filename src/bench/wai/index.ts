// WebArena-Infinity: generated web apps whose tasks a Python verifier checks
// against the app's state (GET /api/state). The page pushes its state to its
// server, so any browser works. foxbench starts each app's server.py on its
// own port, resets it before each case, and runs the task's own verifier.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import quick from "../subsets/webarena-infinity.json" with { type: "json" };
import { pythonEnv, pythonReadiness } from "../python.js";
import { pickSubset } from "../subsets.js";
import type { BenchContext, Benchmark, Case, Env, Episode, Readiness } from "../types.js";
import { fetchUpstream, WAI_REF, WAI_REPO } from "./fetch.js";
import { resetApp, startApp, stopApp, type AppServer } from "./servers.js";
import { runVerifier, writeHelper } from "./verify.js";

export { WAI_REF } from "./fetch.js";
const run = promisify(execFile);
const KINDS = ["real", "function"] as const;
type Kind = (typeof KINDS)[number];

interface TaskDef { id: string; difficulty?: "easy" | "medium" | "hard"; instruction: string; verify: string }
type WaiEnv = { python: string; upstream: string; helper: string; stage: string; env: NodeJS.ProcessEnv; servers: Map<string, Promise<AppServer>> };
const running = new WeakMap<Episode, { app: string; verify: string; port: number }>();

const apps = (upstream: string) => readdirSync(join(upstream, "apps")).filter((a) => KINDS.every((k) => existsSync(join(upstream, "apps", a, `${k}-tasks.json`)))).toSorted();
const tasksOf = (upstream: string, app: string, kind: Kind): TaskDef[] => JSON.parse(readFileSync(join(upstream, "apps", app, `${kind}-tasks.json`), "utf8"));

/** Case ids are `<app>/<real|function>/<task id>`. Only real tasks have a tier upstream (WL2). */
const toCase = (app: string, kind: Kind, t: TaskDef): Case => ({ id: `${app}/${kind}/${t.id}`, tags: [app, kind, ...(t.difficulty ? [t.difficulty] : [])], ...(t.difficulty ? { tier: t.difficulty } : {}), goal: t.instruction });

async function tool(env: NodeJS.ProcessEnv, cmd: string, ...args: string[]): Promise<string | null> {
  return run(cmd, args, { env }).then((r) => r.stdout, () => null);
}

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
    const python = await pythonReadiness(ctx.env);
    if (!python.ready) return python;
    if ((await tool(ctx.env, "git", "--version")) === null) return { ready: false, reason: "git is not installed, so the pinned upstream cannot be fetched", fix: "install git" };
    return { ready: true };
  },
  async load(ctx: BenchContext, subset) {
    const upstream = await fetchUpstream(ctx.cacheDir);
    const all = apps(upstream).flatMap((app) => KINDS.flatMap((kind) => tasksOf(upstream, app, kind).map((t) => toCase(app, kind, t))));
    return pickSubset("webarena-infinity", all, subset, { "webarena-infinity": quick });
  },
  async up(ctx): Promise<Env> {
    const upstream = await fetchUpstream(ctx.cacheDir);
    return { python: await pythonEnv(ctx), upstream, helper: writeHelper(ctx.cacheDir), stage: mkdtempSync(join(ctx.cacheDir, "wai-run-")), env: ctx.env, servers: new Map() } satisfies WaiEnv;
  },
  async start(raw, item) {
    const env = raw as WaiEnv;
    const [app, kind, taskId] = item.id.split("/") as [string, Kind, string];
    const task = tasksOf(env.upstream, app, kind).find((t) => t.id === taskId);
    if (!task) throw new Error(`webarena-infinity has no task ${item.id}`);
    // The verifier must be a file inside its own app (WI7).
    const appDir = resolve(env.upstream, "apps", app);
    if (!resolve(appDir, task.verify).startsWith(appDir + sep)) throw new Error(`the verifier of ${item.id} is outside its app: ${task.verify}`);
    if (!env.servers.has(app)) env.servers.set(app, startApp(env.python, env.upstream, env.stage, app, env.env, options.startTimeoutMs ?? 10_000));
    const server = await env.servers.get(app)!.catch((error) => { env.servers.delete(app); throw error; });
    await resetApp(server);
    // The run loop puts a proxy on a new port in front of each case, so the agent's browser gets a new origin and a page's
    // localStorage from an earlier case cannot be pushed over the reset (WI4).
    const url = `http://127.0.0.1:${server.port}/`;
    const episode: Episode = { url, goal: task.instruction, startPath: "/" };
    running.set(episode, { app, verify: task.verify, port: server.port });
    return episode;
  },
  async judge(raw, episode) {
    const env = raw as WaiEnv;
    const started = running.get(episode);
    if (!started) throw new Error("webarena-infinity did not start this episode");
    const { passed, message } = await runVerifier(env.python, env.helper, join(env.upstream, "apps", started.app), started.verify, `http://127.0.0.1:${started.port}`, env.env);
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
