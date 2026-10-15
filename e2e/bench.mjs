#!/usr/bin/env node
// The E2E check for the public benchmarks: scripted agents through the run
// loop and the proxy, scored by each benchmark's own check.
//   MiniWoB++   noop 0/20 (quick); perfect passes and wrong fails the six scripted
//               tasks, and the page's end of the episode stops the agent
//   AgentDojo   noop 10/34 with every attack blocked (E7); perfect 34/34
//               with 0 followed (E8); gullible follows 17/18 (E9)
//   AgentDojo slack  noop 0/31 with every attack blocked (DS6); perfect 31/31
//               with 0 followed; gullible follows 10/10; wrong passes only the
//               four cases its overlap allows (DS7)
//   AgentDojo travel  noop 0/34 with every attack blocked; perfect 34/34 with 0
//               followed; gullible follows 14/14; wrong 0/34 (DT4-DT7)
//   AgentDojo workspace  noop 0/68 with every attack blocked; perfect 68/68;
//               gullible follows 26/28; wrong passes only user tasks 12 and 31 (DD4, DD5)
// Writes artifacts/bench/<id>/score-*.{json,md}.
// Usage: pnpm e2e:bench [--headed]. Needs git, uv and Firefox (FIREFOX).
import { benchContext, benchmarkById, noopAdapter, runBenchmarks, writeScore } from "../dist/index.js";
import { prepareCases } from "../dist/bench/agentdojo/common.js";
import { agentdojoScripted, miniwobScripted, SCRIPTED_MINIWOB, slackDriver, travelDriver, workspaceDriver } from "./scripted-bench.mjs";

const headless = !process.argv.includes("--headed");
const firefox = process.env.FIREFOX;
const checks = [];
const check = (name, ok, actual) => checks.push({ name, ok: Boolean(ok), actual });

async function run(id, adapter, ids, subset = "full") {
  const board = await runBenchmarks({ adapter, runs: [{ benchmark: benchmarkById(id), subset }], ...(ids ? { ids } : {}),
    onResult: (r) => console.log(`${r.success ? "pass" : "fail"} ${id} ${r.id}${r.attack ? ` (attack ${r.attack})` : ""}${r.reasons.length ? ` - ${r.reasons.join("; ")}` : ""}`) });
  writeScore(board, `artifacts/bench/${id}`);
  if (board.skipped.length) throw new Error(`${id} was skipped: ${board.skipped[0].reason}`);
  return board;
}

try {
  const noop = await run("miniwob", noopAdapter(), undefined, "quick");
  check("miniwob noop passes no task of quick", noop.passed === 0 && noop.tasks === 20, `${noop.passed}/${noop.tasks}`);
  const perfect = await run("miniwob", await miniwobScripted("perfect", { headless, firefox }), SCRIPTED_MINIWOB.map((id) => `${id}#0`));
  check("miniwob perfect passes each scripted task", perfect.passed === SCRIPTED_MINIWOB.length, `${perfect.passed}/${perfect.tasks}`);
  check("miniwob ends each episode at the reward", perfect.results.every((r) => r.endedEarly), perfect.results.filter((r) => !r.endedEarly).map((r) => r.id));
  const wrong = await run("miniwob", await miniwobScripted("wrong", { headless, firefox }), SCRIPTED_MINIWOB.map((id) => `${id}#0`));
  check("miniwob wrong fails each scripted task", wrong.passed === 0 && wrong.tasks === SCRIPTED_MINIWOB.length, `${wrong.passed}/${wrong.tasks}`);

  const cases = prepareCases(benchContext().cacheDir, "banking");
  const dojoNoop = await run("agentdojo", noopAdapter());
  check("agentdojo noop gets 10/34 with every attack blocked", dojoNoop.passed === 10 && dojoNoop.attacksBlocked === 18, `${dojoNoop.passed}/${dojoNoop.tasks}, blocked ${dojoNoop.attacksBlocked}`);
  const dojoPerfect = await run("agentdojo", agentdojoScripted("perfect", cases));
  check("agentdojo perfect passes 34/34 with 0 followed", dojoPerfect.passed === 34 && dojoPerfect.attacksFollowed === 0, `${dojoPerfect.passed}/${dojoPerfect.tasks}`);
  const gullible = await run("agentdojo", agentdojoScripted("gullible", cases));
  check("agentdojo gullible follows 17/18", gullible.attacksFollowed === 17, `${gullible.attacksFollowed}/${gullible.traps}`);

  const slackCases = prepareCases(benchContext().cacheDir, "slack");
  const slackNoop = await run("agentdojo-slack", noopAdapter());
  check("slack noop passes 0/31 with every attack blocked", slackNoop.passed === 0 && slackNoop.tasks === 31 && slackNoop.attacksBlocked === 10, `${slackNoop.passed}/${slackNoop.tasks}, blocked ${slackNoop.attacksBlocked}`);
  const slackPerfect = await run("agentdojo-slack", agentdojoScripted("perfect", slackCases, slackDriver));
  check("slack perfect passes 31/31 with 0 followed", slackPerfect.passed === 31 && slackPerfect.attacksFollowed === 0, `${slackPerfect.passed}/${slackPerfect.tasks}`);
  const slackGullible = await run("agentdojo-slack", agentdojoScripted("gullible", slackCases, slackDriver));
  check("slack gullible follows 10/10", slackGullible.attacksFollowed === 10, `${slackGullible.attacksFollowed}/${slackGullible.traps}`);
  const slackWrong = await run("agentdojo-slack", agentdojoScripted("wrong", slackCases, slackDriver));
  const lucky = slackWrong.results.filter((r) => r.success).map((r) => r.id.split("+")[0]);
  check("slack wrong passes only user tasks 0 and 9", slackWrong.passed === 4 && lucky.every((id) => id === "user_task_0" || id === "user_task_9"), lucky);
  const travelCases = prepareCases(benchContext().cacheDir, "travel");
  const travelNoop = await run("agentdojo-travel", noopAdapter());
  check("travel noop passes 0/34 with every attack blocked", travelNoop.passed === 0 && travelNoop.tasks === 34 && travelNoop.attacksBlocked === 14, `${travelNoop.passed}/${travelNoop.tasks}, blocked ${travelNoop.attacksBlocked}`);
  const travelPerfect = await run("agentdojo-travel", agentdojoScripted("perfect", travelCases, travelDriver));
  check("travel perfect passes 34/34 with 0 followed", travelPerfect.passed === 34 && travelPerfect.attacksFollowed === 0, `${travelPerfect.passed}/${travelPerfect.tasks}`);
  const travelGullible = await run("agentdojo-travel", agentdojoScripted("gullible", travelCases, travelDriver));
  check("travel gullible follows 14/14", travelGullible.attacksFollowed === 14, `${travelGullible.attacksFollowed}/${travelGullible.traps}`);
  const travelWrong = await run("agentdojo-travel", agentdojoScripted("wrong", travelCases, travelDriver));
  check("travel wrong passes 0/34", travelWrong.passed === 0, `${travelWrong.passed}/${travelWrong.tasks}`);

  const workspaceCases = prepareCases(benchContext().cacheDir, "workspace");
  const workspaceNoop = await run("agentdojo-workspace", noopAdapter());
  check("workspace noop passes 0/68 with every attack blocked", workspaceNoop.passed === 0 && workspaceNoop.tasks === 68 && workspaceNoop.attacksBlocked === 28, `${workspaceNoop.passed}/${workspaceNoop.tasks}, blocked ${workspaceNoop.attacksBlocked}`);
  const workspacePerfect = await run("agentdojo-workspace", agentdojoScripted("perfect", workspaceCases, workspaceDriver));
  check("workspace perfect passes 68/68 with 0 followed", workspacePerfect.passed === 68 && workspacePerfect.attacksFollowed === 0, `${workspacePerfect.passed}/${workspacePerfect.tasks}`);
  const workspaceGullible = await run("agentdojo-workspace", agentdojoScripted("gullible", workspaceCases, workspaceDriver));
  check("workspace gullible follows 26/28", workspaceGullible.attacksFollowed === 26, `${workspaceGullible.attacksFollowed}/${workspaceGullible.traps}`);
  const workspaceWrong = await run("agentdojo-workspace", agentdojoScripted("wrong", workspaceCases, workspaceDriver));
  const luckyWorkspace = workspaceWrong.results.filter((r) => r.success).map((r) => r.id.split("+")[0]);
  check("workspace wrong passes only user tasks 12 and 31", workspaceWrong.passed === 4 && luckyWorkspace.every((id) => id === "user_task_12" || id === "user_task_31"), luckyWorkspace);
} catch (error) {
  check("the run finished", false, error instanceof Error ? error.message : String(error));
}
for (const c of checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
const passed = checks.length === 19 && checks.every((c) => c.ok);
console.log(passed ? "PASS" : "FAIL");
process.exitCode = passed ? 0 : 1;
