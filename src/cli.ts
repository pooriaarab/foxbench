#!/usr/bin/env node
// The foxbench command: run the suite against an agent, serve the mock
// sites, or list the tasks.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { noopAdapter, type Adapter } from "./adapter.js";
import { mcpAdapter } from "./mcp.js";
import { runSuite } from "./runner.js";
import { toMarkdown, writeScore } from "./score.js";
import { startServer } from "./server.js";
import { sites } from "./sites/index.js";
import { judge, taskById, tasks } from "./tasks.js";

const USAGE = `Usage:
  foxbench run --agent noop [--tasks id,id] [--out artifacts] [--timeout <s>] [--min-success <0-1>]
  foxbench run --agent mcp [--name <label>] [--tool run_task] [--arg key=json] [options] -- <command> [args...]
  foxbench serve [--port 4173] [--key <control key>]
  foxbench list [--json]`;

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" }, tasks: { type: "string" }, out: { type: "string" }, timeout: { type: "string" },
      "min-success": { type: "string" }, name: { type: "string" }, tool: { type: "string" }, arg: { type: "string", multiple: true }, port: { type: "string" }, key: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { positionals, values } = parsed;
const [command] = positionals;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function adapterFor(name: string | undefined): Adapter {
  if (name === "noop") return noopAdapter();
  if (name === "mcp") {
    const [, program, ...args] = positionals;
    if (!program) fail("Give the MCP server command after --, for example: -- node foxpilot/bin/foxpilot.mjs mcp");
    const extra: Record<string, unknown> = {};
    for (const pair of values.arg ?? []) {
      const at = pair.indexOf("=");
      if (at < 1) fail(`--arg must look like key=value, not ${pair}.`);
      const raw = pair.slice(at + 1);
      try {
        extra[pair.slice(0, at)] = JSON.parse(raw);
      } catch {
        extra[pair.slice(0, at)] = raw;
      }
    }
    return mcpAdapter({ command: program, args, tool: values.tool, name: values.name, extra, timeoutMs: Number(values.timeout ?? 600) * 1000 });
  }
  return fail(name ? `Unknown agent "${name}".` : "Give an agent with --agent.");
}

if (command === "list") {
  if (values.json) console.log(JSON.stringify(tasks.map(({ id, site, path, goal, trap }) => ({ id, site, path, goal, trap: trap ?? null })), null, 2));
  else for (const t of tasks) console.log(`${t.id.padEnd(18)} ${t.trap ? "trap " : "     "}${t.goal}`);
} else if (command === "serve") {
  const port = Number(values.port ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, not ${values.port}.`);
  // Only people get the key. An agent you test on these sites must not see it.
  const key = values.key ?? randomBytes(12).toString("hex");
  const server = await startServer({ sites, tasks, port, controlKey: key, judge: (id, state) => {
    const task = taskById(id);
    return task ? judge(task, state) : null;
  } });
  console.log(`foxbench sites on ${server.url}`);
  console.log(`Control key: ${key} (for people and the demo extension; do not give it to the agent you test)`);
  for (const t of tasks) console.log(`  ${server.url}/__fbn/start/${t.id}?key=${key}`);
  console.log(`Open a start link to reset the state and begin that task. The verdict is at ${server.url}/__fbn/result?key=${key}. Press Ctrl+C to stop.`);
} else if (command === "run") {
  const adapter = adapterFor(values.agent);
  const wanted = values.tasks?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted?.filter((id) => !tasks.some((t) => t.id === id)) ?? [];
  if (unknown.length) fail(`Unknown task: ${unknown.join(", ")}.`);
  const timeout = Number(values.timeout ?? 600);
  if (!(timeout > 0)) fail(`--timeout must be a number of seconds, not ${values.timeout}.`);
  const minSuccess = values["min-success"] === undefined ? null : Number(values["min-success"]);
  if (minSuccess !== null && !(minSuccess >= 0 && minSuccess <= 1)) fail("--min-success must be between 0 and 1.");
  const board = await runSuite({
    adapter,
    tasks: wanted ? tasks.filter((t) => wanted.includes(t.id)) : tasks,
    timeoutMs: timeout * 1000,
    onResult: (r) => console.error(`${r.success ? "pass" : "fail"} ${r.id} (${(r.ms / 1000).toFixed(1)} s)${r.attack ? ` attack ${r.attack}` : ""}`),
  });
  const paths = writeScore(board, values.out ?? "artifacts");
  console.log(toMarkdown(board));
  console.log(`Wrote ${paths.json} and ${paths.md}`);
  if (board.tasks > 0 && board.adapterErrors === board.tasks) {
    const first = board.results[0]?.log ?? "";
    console.error(`The agent did not run: every task ended in an adapter error. The first one: ${first}`);
    process.exitCode = 1;
  } else if (minSuccess !== null && board.successRate < minSuccess) {
    console.error(`Success rate ${board.successRate.toFixed(2)} is below --min-success ${minSuccess}.`);
    process.exitCode = 1;
  }
} else {
  fail(command ? `Unknown command "${command}".` : "Give a command.");
}
