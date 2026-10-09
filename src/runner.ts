// Runs the suite: for each task, reset the server, hand the task to the
// adapter, then judge the server state.
import { randomBytes } from "node:crypto";
import type { Adapter } from "./adapter.js";
import { startServer } from "./server.js";
import { sites } from "./sites/index.js";
import { judge, tasks as allTasks, type Task } from "./tasks.js";

export interface TaskResult {
  id: string;
  site: string;
  trap: string | null;
  success: boolean;
  attack: "followed" | "blocked" | null;
  secure: boolean;
  reasons: string[];
  ms: number;
  /** What the agent claimed. Kept for the record only. */
  done: boolean;
  log: string;
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
  /** Trap tasks that passed with the attack blocked. Doing nothing never counts here. */
  secureTrapPasses: number;
  results: TaskResult[];
}

export interface RunOptions {
  adapter: Adapter;
  tasks?: Task[];
  /** The longest time one task may take. The default is 10 minutes. */
  timeoutMs?: number;
  port?: number;
  onResult?: (result: TaskResult) => void;
}

export function median(values: number[]): number {
  const s = values.toSorted((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Runs each task once, one after another, and returns the scoreboard. */
export async function runSuite(options: RunOptions): Promise<Scoreboard> {
  const { adapter, tasks = allTasks, timeoutMs = 600_000 } = options;
  // The control endpoints need a key that no one gets, so the agent cannot reset a task or read the state.
  const server = await startServer({ sites, tasks, port: options.port, controlKey: randomBytes(24).toString("hex") });
  const results: TaskResult[] = [];
  try {
    for (const task of tasks) {
      const url = server.reset(task);
      const started = Date.now();
      let output = { done: false, log: "" };
      let timer: NodeJS.Timeout | undefined;
      try {
        output = await Promise.race([
          adapter.runTask({ url, goal: task.goal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
      } catch (error) {
        output = { done: false, log: `adapter error: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        clearTimeout(timer);
      }
      const ms = Date.now() - started;
      const verdict = judge(task, server.state);
      const result = { id: task.id, site: task.site, trap: task.trap ?? null, ...verdict, ms, done: output.done, log: output.log.slice(0, 4000) };
      results.push(result);
      options.onResult?.(result);
    }
  } finally {
    await server.close();
    await adapter.close?.();
  }
  const trapped = results.filter((r) => r.trap);
  const passed = results.filter((r) => r.success).length;
  return {
    agent: adapter.name,
    date: new Date().toISOString(),
    tasks: results.length,
    passed,
    successRate: results.length ? passed / results.length : 0,
    medianMs: median(results.map((r) => r.ms)),
    traps: trapped.length,
    attacksBlocked: trapped.filter((r) => r.attack === "blocked").length,
    attacksFollowed: trapped.filter((r) => r.attack === "followed").length,
    secureTrapPasses: trapped.filter((r) => r.secure).length,
    results,
  };
}
