#!/usr/bin/env node
// The E2E check for the public benchmarks: scripted agents through the run
// loop and the proxy, scored by each benchmark's own check.
//   MiniWoB++   noop 0/30; perfect passes and wrong fails the six scripted
//               tasks, and the page's end of the episode stops the agent
//   AgentDojo   noop 10/34 with every attack blocked (E7); perfect 34/34
//               with 0 followed (E8); gullible follows 17/18 (E9)
// Writes artifacts/bench/<id>/score-*.{json,md}.
// Usage: pnpm e2e:bench [--headed]. Needs git, uv and Firefox (FIREFOX).
import { benchContext, benchmarkById, noopAdapter, runBenchmarks, writeScore } from "../dist/index.js";
import { prepareCases } from "../dist/bench/agentdojo/index.js";
import { agentdojoScripted, miniwobScripted, SCRIPTED_MINIWOB } from "./scripted-bench.mjs";

const headless = !process.argv.includes("--headed");
const firefox = process.env.FIREFOX;
const checks = [];
const check = (name, ok, actual) => checks.push({ name, ok: Boolean(ok), actual });

async function run(id, adapter, ids) {
  const board = await runBenchmarks({ adapter, runs: [{ benchmark: benchmarkById(id), subset: "full" }], ...(ids ? { ids } : {}),
    onResult: (r) => console.log(`${r.success ? "pass" : "fail"} ${id} ${r.id}${r.attack ? ` (attack ${r.attack})` : ""}${r.reasons.length ? ` - ${r.reasons.join("; ")}` : ""}`) });
  writeScore(board, `artifacts/bench/${id}`);
  if (board.skipped.length) throw new Error(`${id} was skipped: ${board.skipped[0].reason}`);
  return board;
}

try {
  const noop = await run("miniwob", noopAdapter());
  check("miniwob noop passes no task", noop.passed === 0 && noop.tasks === 30, `${noop.passed}/${noop.tasks}`);
  const perfect = await run("miniwob", await miniwobScripted("perfect", { headless, firefox }), SCRIPTED_MINIWOB);
  check("miniwob perfect passes each scripted task", perfect.passed === SCRIPTED_MINIWOB.length, `${perfect.passed}/${perfect.tasks}`);
  check("miniwob ends each episode at the reward", perfect.results.every((r) => r.endedEarly), perfect.results.filter((r) => !r.endedEarly).map((r) => r.id));
  const wrong = await run("miniwob", await miniwobScripted("wrong", { headless, firefox }), SCRIPTED_MINIWOB);
  check("miniwob wrong fails each scripted task", wrong.passed === 0 && wrong.tasks === SCRIPTED_MINIWOB.length, `${wrong.passed}/${wrong.tasks}`);

  const cases = prepareCases(benchContext().cacheDir);
  const dojoNoop = await run("agentdojo", noopAdapter());
  check("agentdojo noop gets 10/34 with every attack blocked", dojoNoop.passed === 10 && dojoNoop.attacksBlocked === 18, `${dojoNoop.passed}/${dojoNoop.tasks}, blocked ${dojoNoop.attacksBlocked}`);
  const dojoPerfect = await run("agentdojo", agentdojoScripted("perfect", cases));
  check("agentdojo perfect passes 34/34 with 0 followed", dojoPerfect.passed === 34 && dojoPerfect.attacksFollowed === 0, `${dojoPerfect.passed}/${dojoPerfect.tasks}`);
  const gullible = await run("agentdojo", agentdojoScripted("gullible", cases));
  check("agentdojo gullible follows 17/18", gullible.attacksFollowed === 17, `${gullible.attacksFollowed}/${gullible.traps}`);
} catch (error) {
  check("the run finished", false, error instanceof Error ? error.message : String(error));
}
for (const c of checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
const passed = checks.length === 7 && checks.every((c) => c.ok);
console.log(passed ? "PASS" : "FAIL");
process.exitCode = passed ? 0 : 1;
