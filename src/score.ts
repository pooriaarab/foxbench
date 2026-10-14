// Writes a scoreboard as JSON and as a Markdown table.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scoreboard } from "./bench/run.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function toMarkdown(board: Scoreboard): string {
  const rows = board.results.map((r) =>
    `| ${r.id} | ${r.suite} | ${r.success ? "pass" : "fail"} | ${r.attack ?? "-"} | ${secs(r.ms)} | ${r.requests} | ${r.reasons.join("; ").replaceAll("|", "\\|") || "-"} |`);
  const suites = Object.entries(board.suites).map(([name, s]) => `${name} ${s.passed}/${s.tasks}`).join(", ");
  const benchmarks = Object.entries(board.benchmarks).map(([name, b]) => `${name} ${b.passed}/${b.tasks}`).join(", ");
  const skipped = board.skipped.map((s) => `${s.benchmark} (${s.reason}${s.fix ? `; fix: ${s.fix}` : ""})`).join(", ");
  const f = board.fingerprint;
  const speedRows = Object.entries(board.speed.byBenchmark).map(([id, s]) =>
    `| ${id} | ${s.passed}/${s.cases} | ${secs(s.medianMs)} | ${s.p90Ms === null ? "-" : secs(s.p90Ms)} | ${s.medianPassedMs === null ? "-" : secs(s.medianPassedMs)} | ${s.medianFirstActionMs === null ? "-" : secs(s.medianFirstActionMs)} | ${s.tokensPerPass ?? "-"} |`);
  const said = Object.entries(f.reported).map(([k, v]) => `${k} ${v ?? "not reported"}`).join(", ");
  const reported = board.agentTotals ? Object.entries(board.agentTotals).map(([k, v]) => `${k} ${v}`).join(", ") : "not reported";
  return [
    `# foxbench score: ${board.agent}`,
    "",
    `Run on ${board.date}.`,
    "",
    "| Agent | Success rate | Median time per task | Attacks blocked | Secure trap passes |",
    "|---|---|---|---|---|",
    `| ${board.agent} | ${pct(board.successRate)} (${board.passed}/${board.tasks}) | ${secs(board.medianMs)} | ${board.attacksBlocked}/${board.traps} | ${board.secureTrapPasses}/${board.traps} |`,
    "",
    `Adapter errors (the agent threw, failed or timed out): ${board.adapterErrors}/${board.tasks}.`,
    "",
    `Passed per benchmark: ${benchmarks || "none"}. Skipped: ${skipped || "none"}.`,
    "",
    `Passed per suite: ${suites || "none"}. Utility under attack (trap tasks passed): ${board.utilityUnderAttack}/${board.traps}.`,
    "",
    `Median requests per task: ${board.medianRequests}. Median time to the first action: ${board.medianFirstActionMs === null ? "none" : secs(board.medianFirstActionMs)}. Questions to the user: ${board.asks}.`,
    `Egress (requests to other hosts through the proxy): ${board.egress.requests} requests, ${board.egress.bytes} bytes.`,
    `Agent-reported totals: ${reported}.`,
    "",
    "| Benchmark | Passed | Median time | p90 | Median time (passed) | Median first action | Tokens per pass |",
    "|---|---|---|---|---|---|---|",
    ...speedRows,
    "",
    `Run on: ${f.machine ?? "unknown machine"}, ${f.chip ?? "unknown chip"}, ${f.ramGb} GB RAM, ${f.os}, ${f.firefox ?? "Firefox unknown"}, foxbench ${f.foxbench}, ${f.serial ? "serial" : `parallel (${f.workers} workers): this board does not support speed claims`}.`,
    `Operator-reported: ${said}.`,
    "",
    "| Task | Suite | Result | Attack | Time | Requests | Why it failed |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** Writes `<dir>/score-<agent>-<YYYY-MM-DD>.json` and `.md`, and returns both paths. */
export function writeScore(board: Scoreboard, dir = "artifacts"): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `score-${board.agent.replace(/[^a-z0-9._-]+/gi, "-")}-${board.date.slice(0, 10)}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(board, null, 2)}\n`);
  writeFileSync(`${base}.md`, toMarkdown(board));
  return { json: `${base}.json`, md: `${base}.md` };
}
