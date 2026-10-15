#!/usr/bin/env node
// The foxbench command: run benchmarks against an agent, serve the mock
// sites, list the benchmarks and their cases, or check what can run here.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { noopAdapter, type Adapter } from "./adapter.js";
import { benchContext, benchmarks, readiness, resolveSuites } from "./bench/registry.js";
import { mcpAdapter } from "./mcp.js";
import { foxbenchBenchmark } from "./bench/foxbench.js";
import { judgesFrom } from "./bench/judge.js";
import { loadPresets } from "./bench/presets.js";
import { missingRequired, runBenchmarks } from "./bench/run.js";
import type { Readiness, SubsetName } from "./bench/types.js";
import { toMarkdown, writeScore } from "./score.js";
import { startServer } from "./server.js";
import { sites } from "./sites/index.js";
import { judge, taskById, tasks } from "./tasks.js";

const USAGE = `Usage:
  foxbench run --agent noop [--suite core] [--subset quick|published|full|tag:<t>] [--require id,id] [--tasks id,id] [--out artifacts] [--timeout <s>] [--min-success <0-1>] [--fixed-ports <base>] [--user-model claude-sonnet-5-5]
  foxbench run --agent mcp [--name <label>] [--tool run_task] [--arg key=json] [options] -- <command> [args...]
  foxbench run --agent <preset> [options]   (a preset in foxbench.agents.json, here or in ~/.config/foxbench/)
  foxbench serve [--port 4173] [--key <control key>]
  foxbench list [--suite <name>] [--json]   (no --suite: every benchmark and whether it is ready)
  foxbench doctor [--require id,id]         (each benchmark's check, with the fix)
  foxbench env up|down|status <env>         (a GCP VM per environment; foxbench env --help)
Suites: core (the default), hard, security+, all, or benchmark ids, comma-separated.
LLM-judged cases: --judge claude,local (default: every judge that is set up) [--judge-model claude-sonnet-5-5|claude-haiku-5-5]
  [--local-judge-url <llama-server URL>] [--local-judge-model <name>]. claude reads ANTHROPIC_API_KEY from the environment.`;

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

if (process.argv[2] === "env") {
  // foxbench env has its own options; see src/env/cli.ts.
  const { envCli } = await import("./env/cli.js");
  await envCli(process.argv.slice(3));
  process.exit();
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" }, suite: { type: "string" }, tasks: { type: "string" }, out: { type: "string" }, timeout: { type: "string" },
      "min-success": { type: "string" }, name: { type: "string" }, tool: { type: "string" }, arg: { type: "string", multiple: true }, port: { type: "string" }, "fixed-ports": { type: "string" }, subset: { type: "string" }, require: { type: "string" }, "user-model": { type: "string" }, key: { type: "string" }, json: { type: "boolean" }, judge: { type: "string" }, "judge-model": { type: "string" }, "local-judge-url": { type: "string" }, "local-judge-model": { type: "string" }, help: { type: "boolean", short: "h" },
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
  let loaded;
  try {
    loaded = loadPresets();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
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
  const preset = name ? loaded.presets[name] : undefined;
  if (preset) return mcpAdapter({ command: preset.command, args: preset.args ?? [], tool: preset.tool, name: preset.name ?? name, extra: preset.arg ?? {}, timeoutMs: Number(values.timeout ?? 600) * 1000 });
  const found = Object.entries(loaded.presets).map(([n, p]) => `${n} (from ${p.file})`).join(", ");
  return fail(name ? `Unknown agent "${name}". Presets: ${found || "none"}; read ${loaded.files.join(" and ")}.` : "Give an agent with --agent.");
}

const status = (r: Readiness) => (r.ready ? "ready" : `skipped: ${r.reason}${r.fix ? ` (fix: ${r.fix})` : ""}`);

/** The --require ids; each must be a benchmark id. */
function requireList(): string[] {
  const ids = values.require?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const unknown = ids.filter((id) => !benchmarks.some((b) => b.id === id));
  if (unknown.length) fail(`--require names no benchmark: ${unknown.join(", ")}. The benchmarks are ${benchmarks.map((b) => b.id).join(", ")}.`);
  return ids;
}

if (command === "list") {
  const ctx = benchContext();
  if (values.suite === undefined) {
    // Every benchmark, whether it can run here, and why not.
    const rows = await Promise.all(benchmarks.map(async (b) => {
      const ready = await readiness(b, ctx);
      const cases = ready.ready ? (await b.load(ctx, "full").catch(() => [])).length : 0;
      return { id: b.id, title: b.title, where: b.where, licence: b.licence, measures: b.measures, scoring: b.scoring, ...ready, cases };
    }));
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.id.padEnd(20)} ${status(r)}  ${r.cases} cases  ${r.title}`);
  } else {
    let picked;
    try {
      picked = resolveSuites(values.suite);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    const cases = (await Promise.all(picked.map(async ({ benchmark, subset }) => (await benchmark.load(ctx, subset)).map((c) => ({ benchmark: benchmark.id, ...c }))))).flat();
    if (values.json) console.log(JSON.stringify(cases, null, 2));
    else for (const c of cases) console.log(`${c.id.padEnd(24)} ${c.benchmark.padEnd(10)} ${c.tags.join(",").padEnd(28)} ${c.goal ?? ""}`);
  }
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
} else if (command === "doctor") {
  const required = requireList();
  const rows = await Promise.all(benchmarks.map(async (b) => ({ id: b.id, ...(await readiness(b, benchContext())) })));
  for (const r of rows) console.log(`${r.id.padEnd(20)} ${status(r)}`);
  if (rows.some((r) => !r.ready && required.includes(r.id))) process.exitCode = 1;
} else if (command === "run") {
  const subset = values.subset ?? "full";
  if (!/^(quick|published|full|tag:.+)$/.test(subset)) fail(`--subset must be quick, published, full or tag:<tag>, not ${subset}.`);
  const required = requireList();
  let judges;
  try {
    judges = judgesFrom(process.env, {
      ...(values.judge ? { names: values.judge.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(values["judge-model"] ? { model: values["judge-model"] } : {}),
      ...(values["local-judge-url"] ? { localUrl: values["local-judge-url"] } : {}),
      ...(values["local-judge-model"] ? { localModel: values["local-judge-model"] } : {}),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const adapter = adapterFor(values.agent);
  const wanted = values.tasks?.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted?.filter((id) => !tasks.some((t) => t.id === id)) ?? [];
  if (unknown.length) fail(`Unknown task: ${unknown.join(", ")}.`);
  const timeout = Number(values.timeout ?? 600);
  if (!(timeout > 0)) fail(`--timeout must be a number of seconds, not ${values.timeout}.`);
  const fixedPorts = values["fixed-ports"] === undefined ? undefined : Number(values["fixed-ports"]);
  if (fixedPorts !== undefined && !(Number.isInteger(fixedPorts) && fixedPorts >= 1024 && fixedPorts <= 65000)) fail(`--fixed-ports must be a port from 1024 to 65000, not ${values["fixed-ports"]}.`);
  const minSuccess = values["min-success"] === undefined ? null : Number(values["min-success"]);
  if (minSuccess !== null && !(minSuccess >= 0 && minSuccess <= 1)) fail("--min-success must be between 0 and 1.");
  // --tasks with no --suite picks from every foxbench task, as before.
  let runs;
  try {
    runs = resolveSuites(values.suite ?? (wanted ? "foxbench" : "core"), subset as SubsetName);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (fixedPorts !== undefined) runs = runs.map((r) => (r.benchmark.id === "foxbench" ? { ...r, benchmark: foxbenchBenchmark({ fixedPorts }) } : r));
  const ran = await runBenchmarks({
    adapter,
    judges,
    runs,
    ...(wanted ? { ids: wanted } : {}),
    timeoutMs: timeout * 1000,
    ...(values["user-model"] ? { userModel: values["user-model"] } : {}),
    onResult: (r) => console.error(`${r.success ? "pass" : "fail"} ${r.id} (${(r.ms / 1000).toFixed(1)} s)${r.attack ? ` attack ${r.attack}` : ""}`),
  });
  const board = fixedPorts === undefined ? ran : { ...ran, fixedPorts };
  const paths = writeScore(board, values.out ?? "artifacts");
  console.log(toMarkdown(board));
  console.log(`Wrote ${paths.json} and ${paths.md}`);
  const missing = missingRequired(board, required);
  if (missing.length) {
    console.error(`Required benchmarks were skipped: ${missing.join(", ")}.`);
    process.exitCode = 1;
  } else if (board.tasks > 0 && board.adapterErrors === board.tasks) {
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
