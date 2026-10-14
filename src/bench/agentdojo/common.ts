// What every AgentDojo suite shares: the pinned versions, the bridge to
// AgentDojo's Python, the judge process, and the Benchmark that serves one
// suite's environment as a web app. AgentDojo (MIT) makes the cases, places
// the "important_instructions" injections, and judges utility and security
// (bridge.py). foxbench writes none of the checks.
import { execFileSync, spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskOutput } from "../../adapter.js";
import { serveCase } from "../serve.js";
import { pickSubset } from "../subsets.js";
import type { Baseline, Benchmark, Episode, Verdict } from "../types.js";

export const AGENTDOJO_VERSION = "0.1.35";
export const SUITE_VERSION = "v1.2.2";
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "bridge.py");

/** One case as AgentDojo's prepare makes it (bridge.py). */
export interface Item<E = unknown> { id: string; user_task: string; injection_task: string | null; goal: string; env: E; ground_truth?: Call[]; injection_ground_truth?: Call[] | null }
/** A tool call as AgentDojo's stack trace holds it. */
export interface Call { function: string; args: Record<string, unknown> }
export interface JudgeInput { user_task: string; injection_task: string | null; pre: unknown; post: unknown; traces: Call[]; output: string }
export type Judgement = { utility: boolean; security: boolean | null };
export type Form = Record<string, string>;
export type Page = string | { status: number; body: string } | null;

/** One suite's environment as a web app. */
export interface SuiteApp<E> {
  /** One sentence that names the app and its pages, before the task. Empty when the task says enough. */
  intro: string;
  startPath: string;
  /** The page for a request, or null for a 404. Records the tool calls that AgentDojo reads from the trace. */
  page(env: E, calls: Call[], req: IncomingMessage, form: Form, url: URL): Page;
}

const UV = (suite: string, command: string) => ["run", "-q", "--no-project", "--python", "3.12", "--with", `agentdojo==${AGENTDOJO_VERSION}`, "python", "-I", BRIDGE, command, SUITE_VERSION, suite];

/** One AgentDojo judge process for a suite: one JSON line in, one verdict line out. */
export function startJudge(suite: string) {
  const child = spawn("uv", UV(suite, "judge"), { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const waiting: { resolve: (v: Judgement) => void; reject: (e: Error) => void }[] = [];
  lines.on("line", (line) => waiting.shift()?.resolve(JSON.parse(line)));
  child.on("exit", (code) => { for (const w of waiting.splice(0)) w.reject(new Error(`the AgentDojo judge exited with ${code}`)); });
  return {
    judge: (input: JudgeInput) => new Promise<Judgement>((resolve, reject) => { waiting.push({ resolve, reject }); child.stdin.write(`${JSON.stringify(input)}\n`); }),
    close: () => { child.stdin.end(); },
  };
}

export const casesFile = (cache: string, suite: string) => join(cache, `agentdojo-${suite}-${AGENTDOJO_VERSION}-${SUITE_VERSION}.json`);

/** The user tasks alone, then the attacked pairs, as AgentDojo makes them. Cached per suite and version. */
export function prepareCases(cache: string, suite: string): Item[] {
  const file = casesFile(cache, suite);
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, execFileSync("uv", UV(suite, "prepare"), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Starts one case's app. The verdict is AgentDojo's, from the start and end environments and the calls. */
export async function startApp<E>(item: Item<E>, app: SuiteApp<E>, judge: (input: JudgeInput) => Promise<Judgement>) {
  const env = structuredClone(item.env);
  const calls: Call[] = [];
  const server = await serveCase(async (req, body, url) => {
    const page = app.page(env, calls, req, Object.fromEntries(new URLSearchParams(body)), url);
    return page === null ? null : typeof page === "string" ? { body: page } : page;
  });
  return {
    url: `${server.url}${app.startPath}`,
    goal: app.intro ? `${app.intro} ${item.goal}` : item.goal,
    startPath: app.startPath,
    env,
    calls,
    async judge(output: TaskOutput): Promise<Verdict> {
      const verdict = await judge({ user_task: item.user_task, injection_task: item.injection_task, pre: item.env, post: env, traces: calls, output: String(output.answer ?? output.log ?? "") });
      const reasons: string[] = [];
      if (!verdict.utility) reasons.push(`AgentDojo utility false (${item.user_task})`);
      if (verdict.security) reasons.push(`AgentDojo security true: the attack ${item.injection_task} worked`);
      return { success: verdict.utility, attack: item.injection_task ? (verdict.security ? "followed" : "blocked") : null, reasons, judgedBy: "programmatic" };
    },
    close: server.close,
  };
}

const hasUv = (env: NodeJS.ProcessEnv) => {
  try {
    execFileSync("uv", ["--version"], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export interface SuiteSpec<E> {
  /** The foxbench id: "agentdojo", "agentdojo-slack". */
  id: string;
  /** AgentDojo's name for the suite. */
  suite: string;
  title: string;
  app: SuiteApp<E>;
  /** Which cases the app can do: one whose calls the app has no page for would be unfair to the agent, and "blocked" would mean nothing. The default is all. */
  supports?: (item: Item<E>) => boolean;
  baselines?: Baseline[];
}

/** One AgentDojo suite as a benchmark: the user tasks alone, then the attacked pairs. */
export function suiteBenchmark<E>(spec: SuiteSpec<E>): Benchmark {
  const runs = new WeakMap<Episode, (output: TaskOutput) => Promise<Verdict>>();
  let judge: ReturnType<typeof startJudge> | null = null;
  return {
    id: spec.id,
    title: spec.title,
    upstream: { repo: "https://pypi.org/project/agentdojo/", ref: `${AGENTDOJO_VERSION} suite ${SUITE_VERSION}`, paper: "https://arxiv.org/abs/2406.13352" },
    licence: { code: "MIT", data: "MIT", mode: "fetch-at-run" },
    where: "local",
    measures: ["task", "injection"],
    scoring: "programmatic",
    check: async (ctx) => (hasUv(ctx.env) ? { ready: true } : { ready: false, reason: "uv is not on the PATH (AgentDojo runs through uv)", fix: "install uv: https://docs.astral.sh/uv/" }),
    load: async (ctx, subset) => pickSubset(spec.id, prepareCases(ctx.cacheDir, spec.suite).filter((c) => spec.supports?.(c as Item<E>) ?? true).map((c) => ({ id: c.id, tags: [spec.suite], suite: `agentdojo-${spec.suite}`, trap: Boolean(c.injection_task), goal: c.goal })), subset),
    up: async (ctx) => ({ cases: prepareCases(ctx.cacheDir, spec.suite) }),
    async start(env, item) {
      const run = await startApp((env.cases as Item<E>[]).find((c) => c.id === item.id)!, spec.app, (input) => (judge ??= startJudge(spec.suite)).judge(input));
      const episode: Episode = { url: run.url, goal: run.goal, startPath: run.startPath, close: run.close };
      runs.set(episode, run.judge);
      return episode;
    },
    judge: async (_env, episode, output) => runs.get(episode)!(output),
    async down() {
      judge?.close();
      judge = null;
    },
    baselines: spec.baselines ?? [],
  };
}
