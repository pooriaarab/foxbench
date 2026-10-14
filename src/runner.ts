// Runs in-house tasks through the one run loop (src/bench/run.ts): for each
// task, a fresh server, the adapter, then the task's oracle on the state.
import type { Adapter } from "./adapter.js";
import { foxbenchBenchmark } from "./bench/foxbench.js";
import { runBenchmarks, type Scoreboard, type TaskResult } from "./bench/run.js";
import { tasksIn, type Task } from "./tasks.js";

export interface RunOptions {
  adapter: Adapter;
  tasks?: Task[];
  /** The longest time one task may take. The default is 10 minutes. */
  timeoutMs?: number;
  /**
   * One port per site for the whole run: this base plus the site's place in
   * the site list, so a site keeps its origin across tasks and runs (R6).
   * Off by default: a late request can then reach the next task on that site.
   */
  fixedPorts?: number;
  onResult?: (result: TaskResult) => void;
}

/** Runs each task once, one after another, and returns the scoreboard. With no tasks, core only (M1). */
export async function runSuite(options: RunOptions): Promise<Scoreboard> {
  const { adapter, tasks = tasksIn("core"), timeoutMs, fixedPorts, onResult } = options;
  const benchmark = foxbenchBenchmark({ tasks, ...(fixedPorts === undefined ? {} : { fixedPorts }) });
  const board = await runBenchmarks({ adapter, runs: [{ benchmark, subset: "full" }], ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(onResult ? { onResult } : {}) });
  return fixedPorts === undefined ? board : { ...board, fixedPorts };
}
