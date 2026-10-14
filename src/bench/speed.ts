// Speed per benchmark: what a speed claim needs beside the pass rate. Failed
// cases often run to the step cap or the timeout, so the median over passed
// cases stands apart from the median over all of them (plan section 7.1).
import type { TaskResult } from "./run.js";

export interface Speed {
  cases: number;
  passed: number;
  medianMs: number;
  p90Ms: number | null;
  /** The median wall time over passed cases, or null when nothing passed. */
  medianPassedMs: number | null;
  medianFirstActionMs: number | null;
  /** Every reported token, in and out, over the passes; null with no pass or no tokens. */
  tokensPerPass: number | null;
}

export function median(values: number[]): number {
  const s = values.toSorted((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** The nearest-rank 90th percentile: the value at rank ceil(0.9 n), or null for no values. */
export function p90(values: number[]): number | null {
  const s = values.toSorted((a, b) => a - b);
  return s.length ? s[Math.ceil(0.9 * s.length) - 1]! : null;
}

export function speedOf(results: TaskResult[]): Speed {
  const passed = results.filter((r) => r.success);
  const firsts = results.flatMap((r) => (r.firstActionMs === null ? [] : [r.firstActionMs]));
  const reported = results.filter((r) => r.agentMetrics?.tokensIn !== undefined || r.agentMetrics?.tokensOut !== undefined);
  const tokens = reported.reduce((n, r) => n + (r.agentMetrics?.tokensIn ?? 0) + (r.agentMetrics?.tokensOut ?? 0), 0);
  return {
    cases: results.length,
    passed: passed.length,
    medianMs: median(results.map((r) => r.ms)),
    p90Ms: p90(results.map((r) => r.ms)),
    medianPassedMs: passed.length ? median(passed.map((r) => r.ms)) : null,
    medianFirstActionMs: firsts.length ? median(firsts) : null,
    tokensPerPass: passed.length && reported.length ? Math.round(tokens / passed.length) : null,
  };
}

/** Speed over all results and per benchmark. */
export function speedBoard(results: TaskResult[]): { all: Speed; byBenchmark: Record<string, Speed> } {
  const ids = [...new Set(results.map((r) => r.benchmark))];
  return { all: speedOf(results), byBenchmark: Object.fromEntries(ids.map((id) => [id, speedOf(results.filter((r) => r.benchmark === id))])) };
}
