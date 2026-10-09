// The E2E test. It runs the foxbench CLI three times, the way a user would,
// and checks each scoreboard:
//   noop      does nothing and must score 0, so no oracle passes by default;
//   perfect   scripted steps in a real Firefox; must pass every task and
//             block every attack, so every task is solvable and every oracle
//             accepts a correct run;
//   gullible  the same steps, but it obeys each injection; every attack must
//             show as followed.
// Writes artifacts/score-<agent>-<date>.{json,md} and artifacts/e2e-<date>.json.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeArtifact } from "create-foxkit/e2e";

const headed = process.argv.includes("--headed") ? ["--headed"] : [];
const record = { startedAt: new Date().toISOString(), runs: {}, checks: [] };
const check = (name, ok, actual) => record.checks.push({ name, ok: Boolean(ok), actual });

function run(agent, extra) {
  const out = execFileSync(process.execPath, ["dist/cli.js", "run", "--agent", ...extra, "--timeout", "120"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const path = /Wrote (\S+\.json)/.exec(out)?.[1];
  const board = JSON.parse(readFileSync(path, "utf8"));
  record.runs[agent] = { path, passed: board.passed, tasks: board.tasks, attacksBlocked: board.attacksBlocked, attacksFollowed: board.attacksFollowed, medianMs: board.medianMs };
  return board;
}
const scripted = (mode) => ["mcp", "--name", mode, "--", process.execPath, "e2e/scripted-mcp.mjs", mode, ...headed];

try {
  const noop = run("noop", ["noop"]);
  check("noop passes no task", noop.passed === 0 && noop.tasks >= 10, `${noop.passed}/${noop.tasks}`);
  check("noop has no secure trap pass", noop.secureTrapPasses === 0, noop.secureTrapPasses);

  const perfect = run("perfect", scripted("perfect"));
  check("perfect passes every task", perfect.passed === perfect.tasks, `${perfect.passed}/${perfect.tasks}`);
  check("perfect blocks every attack", perfect.traps >= 3 && perfect.attacksBlocked === perfect.traps, `${perfect.attacksBlocked}/${perfect.traps}`);
  check("perfect claims done on every task", perfect.results.every((r) => r.done), perfect.results.filter((r) => !r.done).map((r) => r.id));

  const gullible = run("gullible", scripted("gullible"));
  check("gullible follows every attack", gullible.attacksFollowed === gullible.traps, `${gullible.attacksFollowed}/${gullible.traps}`);
  check("gullible passes every task with no trap", gullible.results.filter((r) => !r.trap).every((r) => r.success),
    gullible.results.filter((r) => !r.trap && !r.success).map((r) => r.id));
  check("gullible has no secure trap pass", gullible.secureTrapPasses === 0, gullible.secureTrapPasses);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
}
record.passed = !record.error && record.checks.length === 8 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
