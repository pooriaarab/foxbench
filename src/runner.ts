// Runs the suite: for each task, reset the server, hand the task to the
// adapter, then judge the server state.
import { randomBytes } from "node:crypto";
import { parseMetrics, type Adapter, type AgentMetrics } from "./adapter.js";
import { startServer } from "./server.js";
import { sites } from "./sites/index.js";
import { serverMetrics } from "./state.js";
import { judge, tasksIn, type Suite, type Task, type Tier } from "./tasks.js";

export interface TaskResult {
  id: string;
  suite: Suite;
  tier: Tier;
  site: string;
  trap: string | null;
  success: boolean;
  attack: "followed" | "blocked" | null;
  secure: boolean;
  reasons: string[];
  ms: number;
  /** What the agent claimed. Kept for the record only. */
  done: boolean;
  /** The adapter threw or timed out, so the agent may not have run. */
  adapterError: boolean;
  log: string;
  /** Page loads and form posts that the server saw. */
  requests: number;
  posts: number;
  /** Time to the first request that is not a load of the start page, or null. */
  firstActionMs: number | null;
  /** Questions to the Ask Sam chat. */
  asks: number;
  /** What the agent reported about itself, or null. Never used in the score. */
  agentMetrics: AgentMetrics | null;
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
  suites: Partial<Record<Suite, { tasks: number; passed: number }>>;
  medianRequests: number;
  /** Questions sent to the Ask Sam chat, over all tasks. */
  asks: number;
  /** The median over tasks with a first action, or null when none had one. */
  medianFirstActionMs: number | null;
  /** The sum of each agent-reported metric over the tasks that reported it, or null. */
  agentTotals: AgentMetrics | null;
  results: TaskResult[];
}

export interface RunOptions {
  adapter: Adapter;
  tasks?: Task[];
  /** The longest time one task may take. The default is 10 minutes. */
  timeoutMs?: number;
  onResult?: (result: TaskResult) => void;
}

export function median(values: number[]): number {
  const s = values.toSorted((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function perSuite(results: TaskResult[]): Scoreboard["suites"] {
  const out: Scoreboard["suites"] = {};
  for (const r of results) {
    const s = (out[r.suite] ??= { tasks: 0, passed: 0 });
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

/** Runs each task once, one after another, and returns the scoreboard. */
export async function runSuite(options: RunOptions): Promise<Scoreboard> {
  const { adapter, tasks = tasksIn("core"), timeoutMs = 600_000 } = options;
  const results: TaskResult[] = [];
  try {
    for (const task of tasks) {
      // One server per task, on its own port: a late request from a timed-out
      // task finds a closed port and cannot touch the next task's state.
      // The control endpoints need a key that no one gets.
      const server = await startServer({ sites, tasks, controlKey: randomBytes(24).toString("hex") });
      const url = server.reset(task);
      const started = Date.now();
      let output: { done: boolean; log: string; metrics?: AgentMetrics } = { done: false, log: "" };
      let adapterError = false;
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      try {
        output = await Promise.race([
          adapter.runTask({ url, goal: task.goal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`timed out after ${timeoutMs} ms`));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        output = { done: false, log: `adapter error: ${error instanceof Error ? error.message : String(error)}` };
        adapterError = true;
        if (timedOut) await adapter.abort?.().catch(() => {});
      } finally {
        clearTimeout(timer);
      }
      const ms = Date.now() - started;
      const verdict = judge(task, server.state);
      await server.close();
      const result = { id: task.id, suite: task.suite, tier: task.tier, site: task.site, trap: task.trap ?? null, ...verdict, ms, done: output.done,
        adapterError, log: output.log.slice(0, 4000), ...serverMetrics(server.state), agentMetrics: parseMetrics(output.metrics) };
      results.push(result);
      options.onResult?.(result);
    }
  } finally {
    await adapter.close?.();
  }
  const trapped = results.filter((r) => r.trap);
  const passed = results.filter((r) => r.success).length;
  const firsts = results.flatMap((r) => (r.firstActionMs === null ? [] : [r.firstActionMs]));
  return {
    agent: adapter.name,
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
    suites: perSuite(results),
    medianRequests: median(results.map((r) => r.requests)),
    asks: results.reduce((n, r) => n + r.asks, 0),
    medianFirstActionMs: firsts.length ? median(firsts) : null,
    agentTotals: totals(results),
    results,
  };
}
