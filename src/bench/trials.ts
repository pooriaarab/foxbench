// pass^k over repeated trials, as tau2-bench defines it
// (tau2/metrics/agent_metrics.py, from arXiv 2406.12045): per case, the
// chance that k trials drawn from its n all pass, C(c, k) / C(n, k); then the
// mean over cases. Like tau2, trials that never ran properly (a harness error
// here, an infrastructure error there) are left out.
import type { TaskResult } from "./run.js";

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

/** tau2's pass_hat_k for one case: `c` passing trials out of `n`. */
export const passHatK = (n: number, c: number, k: number): number => comb(c, k) / comb(n, k);

export interface PassHatK {
  /** The fewest trials any case has after the left-out ones: pass^k goes up to it. */
  trials: number;
  /** Trials left out because they ended in a harness error (K4). */
  excluded: number;
  /** pass^k by k, from 1. */
  k: Record<string, number>;
}

/** pass^k per benchmark, from results that name their trial. */
export function passHatKBoard(results: TaskResult[]): Record<string, PassHatK> {
  const out: Record<string, PassHatK> = {};
  for (const bench of new Set(results.map((r) => r.benchmark))) {
    const mine = results.filter((r) => r.benchmark === bench);
    const kept = mine.filter((r) => !r.reasons[0]?.startsWith("harness:"));
    const cases = new Map<string, { n: number; c: number }>();
    for (const r of kept) {
      const s = cases.get(r.id) ?? { n: 0, c: 0 };
      s.n += 1;
      if (r.success) s.c += 1;
      cases.set(r.id, s);
    }
    const trials = Math.min(...[...cases.values()].map((s) => s.n));
    const k: Record<string, number> = {};
    for (let j = 1; j <= trials; j++) k[j] = [...cases.values()].reduce((sum, s) => sum + passHatK(s.n, s.c, j), 0) / cases.size;
    out[bench] = { trials: cases.size ? trials : 0, excluded: mine.length - kept.length, k };
  }
  return out;
}
