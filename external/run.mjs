#!/usr/bin/env node
// Scores an agent on an external benchmark with that benchmark's own check.
//   node external/run.mjs miniwob   --agent noop|perfect|wrong   [options]
//   node external/run.mjs <suite>   --agent mcp [--name <label>] -- <command> [args...]
// Options: --tasks id,id  --out <dir> (default artifacts/external/<suite>)
//          --timeout <s> (default 600)  --headed  --firefox <path>
// Needs: pnpm build, pnpm build:ext and git.
import { parseArgs } from "node:util";
import { mcpAdapter, noopAdapter, toMarkdown, writeScore } from "../dist/index.js";
import { miniwobSuite } from "./miniwob.mjs";
import { runExternal } from "./runner.mjs";
import { miniwobScripted, SCRIPTED_MINIWOB } from "./scripted.mjs";

/** The numbers each benchmark reports, beside foxbench's own board. */
export function summary(board) {
  const line = [`${board.agent}: ${board.passed}/${board.tasks} passed (${Math.round(board.successRate * 100)}%), median ${(board.medianMs / 1000).toFixed(1)} s per task, ${board.adapterErrors} adapter errors.`];
  if (board.agentTotals) line.push(`Agent-reported totals: ${Object.entries(board.agentTotals).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  return line.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { agent: { type: "string", default: "noop" }, name: { type: "string" }, tasks: { type: "string" }, out: { type: "string" },
      timeout: { type: "string", default: "600" }, headed: { type: "boolean", default: false }, firefox: { type: "string" } },
  });
  const [which, ...command] = positionals;
  const firefox = values.firefox ?? process.env.FIREFOX;
  const suite = which === "miniwob" ? await miniwobSuite({ firefox }) : null;
  if (!suite) {
    console.error("The first argument must be miniwob.");
    process.exit(2);
  }
  let cases = suite.cases;
  if (values.tasks) cases = cases.filter((c) => values.tasks.split(",").includes(c.id));
  else if (which === "miniwob" && values.agent !== "noop" && values.agent !== "mcp") cases = cases.filter((c) => SCRIPTED_MINIWOB.includes(c.id));
  const agents = {
    noop: () => noopAdapter(),
    mcp: () => mcpAdapter({ command: command[0], args: command.slice(1), ...(values.name ? { name: values.name } : {}) }),
    perfect: () => miniwobScripted("perfect", { headless: !values.headed, firefox }),
    wrong: () => miniwobScripted("wrong", { headless: !values.headed, firefox }),
  };
  if (!agents[values.agent] || (values.agent === "mcp" && !command.length)) {
    console.error(`--agent must be one of ${Object.keys(agents).join(", ")}; mcp needs a command after --.`);
    process.exit(2);
  }
  const board = await runExternal({
    adapter: await agents[values.agent](), suite, cases, timeoutMs: Number(values.timeout) * 1000,
    onResult: (r) => console.log(`${r.success ? "pass" : "fail"} ${r.id}${r.attack ? ` (attack ${r.attack})` : ""}${r.reasons.length ? ` - ${r.reasons.join("; ")}` : ""}`),
  });
  console.log(toMarkdown(board));
  console.log(summary(board));
  const paths = writeScore(board, values.out ?? `artifacts/external/${which}`);
  console.log(`Wrote ${paths.json}`);
}
