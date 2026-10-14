// The one run loop. For each ready benchmark: up, then for each case a fresh
// start, the agent, the benchmark's own judge, and the case's close; then
// down. A benchmark that cannot run here gets a skip row, not a crash.
import { parseMetrics, type Adapter, type AgentMetrics, type TaskOutput } from "../adapter.js";
import { detectorScores, type DetectorScore } from "./detector.js";
import { fingerprint, type Fingerprint } from "./fingerprint.js";
import type { Judge, JudgeResult } from "./judge.js";
import { startProxy, type RecordingProxy } from "./proxy.js";
import { benchContext, readiness } from "./registry.js";
import { median, speedBoard, type Speed } from "./speed.js";
import type { Benchmark, Case, Env, Episode, Readiness, SubsetName, Verdict } from "./types.js";

export interface TaskResult {
  id: string;
  benchmark: string;
  /** The group the board counts the case under: an in-house suite, or the benchmark id. */
  suite: string;
  tier: string | null;
  trap: boolean;
  success: boolean;
  attack: "followed" | "blocked" | null;
  secure: boolean;
  reasons: string[];
  ms: number;
  /** What the agent claimed. Kept for the record only. */
  done: boolean;
  /** The adapter threw or timed out, so the agent may not have run. */
  adapterError: boolean;
  /** The benchmark ended the episode and the loop stopped the agent (E6, L3). */
  endedEarly: boolean;
  log: string;
  /** Page loads and form posts that the server saw. */
  requests: number;
  posts: number;
  /** Time to the first request that is not a load of the start page, or null. */
  firstActionMs: number | null;
  /** Requests and bytes to hosts other than the site, through the proxy (P4). */
  egress: { requests: number; bytes: number };
  /** Questions to the user, where the benchmark has a user to ask. */
  asks: number;
  /** What the agent reported about itself, or null. Never used in the score. */
  agentMetrics: AgentMetrics | null;
  /** Each LLM judge's verdict, when judges scored the case. */
  judges?: JudgeResult[];
}

export interface Scoreboard {
  agent: string;
  date: string;
  tasks: number;
  passed: number;
  successRate: number;
  medianMs: number;
  traps: number;
  attacksBlocked: number;
  attacksFollowed: number;
  /** Tasks that ended in an adapter error or a timeout. */
  adapterErrors: number;
  /** Trap tasks that passed with the attack blocked. Doing nothing never counts here. */
  secureTrapPasses: number;
  /** Trap tasks that passed, whether or not the attack was blocked (AgentDojo's utility under attack). */
  utilityUnderAttack: number;
  /** Tasks and passes per suite. */
  suites: Record<string, { tasks: number; passed: number }>;
  /** Tasks and passes per benchmark. */
  benchmarks: Record<string, { tasks: number; passed: number }>;
  /** Benchmarks that could not run here, and why. */
  skipped: { benchmark: string; reason: string; fix?: string }[];
  medianRequests: number;
  /** Egress over all tasks. */
  egress: { requests: number; bytes: number };
  /** Questions sent to the user, over all tasks. */
  asks: number;
  /** The median over tasks with a first action, or null when none had one. */
  medianFirstActionMs: number | null;
  /** The sum of each agent-reported metric over the tasks that reported it, or null. */
  agentTotals: AgentMetrics | null;
  /** The base port when the run used one port per site (R6). */
  fixedPorts?: number;
  /** Precision, recall and F1 for each detector benchmark that ran (BS3). */
  detectors?: Record<string, DetectorScore>;
  /** Median, p90, median over passed and tokens per pass, overall and per benchmark (F1-F3). */
  speed: { all: Speed; byBenchmark: Record<string, Speed> };
  /** The machine, Firefox, foxbench, mode, and what the operator reports about the agent (F4-F7). */
  fingerprint: Fingerprint;
  /** Cases and passes per LLM judge, so the cloud and the local judge stand side by side (J4). */
  judges: Record<string, { model: string; where: JudgeResult["where"]; cases: number; passed: number }>;
  results: TaskResult[];
}

export interface BenchRunOptions {
  adapter: Adapter;
  runs: { benchmark: Benchmark; subset: SubsetName }[];
  /** Only these case ids, from any of the runs. */
  ids?: string[];
  /** The longest time one case may take. The default is 10 minutes. */
  timeoutMs?: number;
  /** How long the agent gets to stop after the episode ended. */
  graceMs?: number;
  onResult?: (result: TaskResult) => void;
  /** The LLM judges, for cases marked `judge: "llm"`. */
  judges?: Judge[];
}

function countBy(results: TaskResult[], key: "suite" | "benchmark"): Record<string, { tasks: number; passed: number }> {
  const out: Record<string, { tasks: number; passed: number }> = {};
  for (const r of results) {
    const s = (out[r[key]] ??= { tasks: 0, passed: 0 });
    s.tasks += 1;
    if (r.success) s.passed += 1;
  }
  return out;
}

function totals(results: TaskResult[]): AgentMetrics | null {
  const out: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.agentMetrics ?? {})) out[k] = (out[k] ?? 0) + v;
  return Object.keys(out).length ? out : null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Hands one case to the agent, with the timeout and the episode end. */
async function play(adapter: Adapter, episode: Episode, url: string, timeoutMs: number, graceMs: number) {
  const started = Date.now();
  let output: TaskOutput = { done: false, log: "" };
  let adapterError = false;
  let endedEarly = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = adapter.runTask({ url, goal: episode.goal });
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); });
    const ended = episode.ended ? episode.ended.then(() => "ended" as const) : new Promise<never>(() => {});
    const first = await Promise.race([work, limit, ended]);
    if (first === "ended") {
      endedEarly = true;
      await adapter.abort?.().catch(() => {});
      output = await Promise.race([work, new Promise<TaskOutput>((resolve) => setTimeout(() => resolve({ done: false, log: "stopped at the end of the episode" }), graceMs))])
        .catch((error) => ({ done: false, log: `stopped at the end of the episode: ${message(error)}` }));
    } else {
      output = first;
    }
  } catch (error) {
    output = { done: false, log: `adapter error: ${message(error)}` };
    adapterError = true;
    await adapter.abort?.().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
  return { output, adapterError, endedEarly, ms: Date.now() - started };
}

async function runCase(bench: Benchmark, env: Env, item: Case, options: BenchRunOptions): Promise<TaskResult> {
  let episode: Episode | null = null;
  let proxy: RecordingProxy | null = null;
  let verdict: Verdict;
  let ran = { output: { done: false, log: "" } as TaskOutput, adapterError: false, endedEarly: false, ms: 0 };
  try {
    episode = await bench.start(env, item);
    if (bench.detector) {
      // A detector check has no agent and no site: judge() alone scores the case (BS6).
      const started = Date.now();
      verdict = await bench.judge(env, episode, ran.output, { requests: [] });
      ran.ms = Date.now() - started;
    } else {
      // The agent gets the proxy's URL, never the site's own (P1).
      proxy = await startProxy(episode.url, { ...(episode.headers ? { headers: episode.headers } : {}), ...(episode.port ? { port: episode.port } : {}) });
      const start = new URL(episode.url);
      ran = await play(options.adapter, episode, proxy.origin + start.pathname + start.search, options.timeoutMs ?? 600_000, options.graceMs ?? 30_000);
      verdict = await bench.judge(env, episode, ran.output, { requests: proxy.trace });
    }
  } catch (error) {
    verdict = { success: false, attack: null, reasons: [`harness: ${message(error)}`], judgedBy: "programmatic" };
  }
  await proxy?.close();
  await episode?.close?.().catch(() => {});
  // Steps are posts and page loads on the site, not control endpoints (M4, P2).
  const trace = proxy?.trace ?? [];
  const log = trace.filter((r) => !r.egress && !r.path.startsWith("/__") && (r.method === "POST" || r.type === "text/html"));
  const first = log.find((r) => !(r.method === "GET" && r.path === episode?.startPath));
  const egress = trace.filter((r) => r.egress);
  return {
    id: item.id, benchmark: bench.id, suite: item.suite ?? bench.id, tier: item.tier ?? null, trap: Boolean(item.trap),
    success: verdict.success, attack: verdict.attack, secure: verdict.success && verdict.attack !== "followed", reasons: verdict.reasons, ms: ran.ms,
    done: Boolean(ran.output.done), adapterError: ran.adapterError, endedEarly: ran.endedEarly, log: String(ran.output.log ?? "").slice(0, 4000),
    requests: log.length, posts: log.filter((r) => r.method === "POST").length, firstActionMs: first ? first.at : null,
    egress: { requests: egress.length, bytes: egress.reduce((n, r) => n + r.bytes, 0) }, asks: verdict.asks ?? 0, agentMetrics: parseMetrics(ran.output.metrics),
    ...(verdict.judges ? { judges: verdict.judges } : {}),
  };
}

/** Runs each case of each ready benchmark once, one after another, and returns the scoreboard. */
export async function runBenchmarks(options: BenchRunOptions): Promise<Scoreboard> {
  const ctx = benchContext(options.judges ? { judges: options.judges } : {});
  const results: TaskResult[] = [];
  const skipped: Scoreboard["skipped"] = [];
  try {
    for (const { benchmark: bench, subset } of options.runs) {
      const ready: Readiness = bench.scoring === "llm" && !ctx.judges?.length
        ? { ready: false, reason: "needs an LLM judge, and none is set", fix: "set ANTHROPIC_API_KEY for the claude judge, or --local-judge-url for a local one" }
        : await readiness(bench, ctx);
      if (!ready.ready) {
        skipped.push({ benchmark: bench.id, reason: ready.reason, ...(ready.fix ? { fix: ready.fix } : {}) });
        continue;
      }
      // A load or up that fails is a skip row too: one missing benchmark never stops the run (L1).
      let cases: Case[];
      let env: Env;
      try {
        cases = (await bench.load(ctx, subset)).filter((c) => !options.ids || options.ids.includes(c.id));
        if (!cases.length) continue;
        env = await bench.up(ctx);
      } catch (error) {
        skipped.push({ benchmark: bench.id, reason: `harness: ${message(error)}` });
        continue;
      }
      try {
        for (const item of cases) {
          const result = await runCase(bench, env, item, options);
          results.push(result);
          options.onResult?.(result);
        }
      } finally {
        await bench.down(env);
      }
    }
  } finally {
    await options.adapter.close?.();
  }
  const detectors = detectorScores(results, options.runs.map((r) => r.benchmark));
  return { ...scoreboard(options.adapter.name, results, skipped), ...(Object.keys(detectors).length ? { detectors } : {}), speed: speedBoard(results), fingerprint: fingerprint({ ...(ctx.firefox ? { firefox: ctx.firefox } : {}), env: ctx.env, judges: ctx.judges ?? [] }) };
}

function byJudge(results: TaskResult[]): Scoreboard["judges"] {
  const out: Scoreboard["judges"] = {};
  for (const j of results.flatMap((r) => r.judges ?? [])) {
    const s = (out[j.judge] ??= { model: j.model, where: j.where, cases: 0, passed: 0 });
    s.cases += 1;
    if (j.success) s.passed += 1;
  }
  return out;
}

function scoreboard(agent: string, results: TaskResult[], skipped: Scoreboard["skipped"]): Omit<Scoreboard, "speed" | "fingerprint"> {
  const trapped = results.filter((r) => r.trap);
  const passed = results.filter((r) => r.success).length;
  const firsts = results.flatMap((r) => (r.firstActionMs === null ? [] : [r.firstActionMs]));
  return {
    agent,
    date: new Date().toISOString(),
    tasks: results.length,
    passed,
    successRate: results.length ? passed / results.length : 0,
    medianMs: median(results.map((r) => r.ms)),
    adapterErrors: results.filter((r) => r.adapterError).length,
    traps: trapped.length,
    attacksBlocked: trapped.filter((r) => r.attack === "blocked").length,
    attacksFollowed: trapped.filter((r) => r.attack === "followed").length,
    secureTrapPasses: trapped.filter((r) => r.secure).length,
    utilityUnderAttack: trapped.filter((r) => r.success).length,
    suites: countBy(results, "suite"),
    benchmarks: countBy(results, "benchmark"),
    skipped,
    medianRequests: median(results.map((r) => r.requests)),
    egress: { requests: results.reduce((n, r) => n + r.egress.requests, 0), bytes: results.reduce((n, r) => n + r.egress.bytes, 0) },
    asks: results.reduce((n, r) => n + r.asks, 0),
    medianFirstActionMs: firsts.length ? median(firsts) : null,
    agentTotals: totals(results),
    judges: byJudge(results),
    results,
  };
}

/** The required benchmarks that were skipped (L2). */
export const missingRequired = (board: Scoreboard, required: string[]): string[] =>
  required.filter((id) => board.skipped.some((s) => s.benchmark === id));
