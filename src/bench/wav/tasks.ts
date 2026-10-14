// The WebArena-Verified task list, from the `webarena-verified` package on
// PyPI at a pinned version. uv installs it into its own cache; a small bridge
// script, written into foxbench's cache dir, reads the package's dataset and
// prints the fields foxbench needs. Nothing upstream is committed.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BenchContext, Case } from "../types.js";

const run = promisify(execFile);

export const WAV_VERSION = "1.2.3";

export interface WavTask {
  id: number;
  sites: string[];
  startUrls: string[];
  intent: string;
  taskType: "retrieve" | "mutate" | "navigate";
}

// Runs with python -I from the cache dir, never from inside the package.
const BRIDGE = `import json, sys
from importlib.resources import files

data = files("webarena_verified") / "assets" / "dataset"
tasks = json.loads((data / "webarena-verified.json").read_text())
hard = json.loads((data / "subsets" / "webarena-verified-hard.json").read_text())["task_ids"]
out = [{"id": t["task_id"], "sites": t["sites"], "startUrls": t["start_urls"], "intent": t["intent"],
        "taskType": next(e for e in t["eval"] if e["evaluator"] == "AgentResponseEvaluator")["expected"]["task_type"]} for t in tasks]
json.dump({"tasks": out, "hard": hard}, sys.stdout)
`;

export const wavDir = (ctx: BenchContext) => join(ctx.cacheDir, `webarena-verified-${WAV_VERSION}`);
const uv = (ctx: BenchContext) => ctx.env.FOXBENCH_UV || "uv";

/** Null when uv runs; else why not. */
export function uvMissing(ctx: BenchContext): string | null {
  const r = spawnSync(uv(ctx), ["--version"], { encoding: "utf8" });
  return r.status === 0 ? null : `${uv(ctx)} did not run (${r.error?.message ?? r.stderr.trim()})`;
}

/** Runs the bridge in uv's own environment with the pinned package and returns its stdout. */
async function bridge(ctx: BenchContext, script: string): Promise<string> {
  const dir = wavDir(ctx);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "tasks_bridge.py");
  writeFileSync(file, script);
  const { stdout } = await run(uv(ctx), ["run", "-q", "--isolated", "--no-project", "--python", "3.12", "--with", `webarena-verified==${WAV_VERSION}`, "python", "-I", file],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The tasks and the hard subset's ids, read once and kept in the cache. */
export async function loadTasks(ctx: BenchContext): Promise<{ tasks: WavTask[]; hard: number[] }> {
  const cached = join(wavDir(ctx), "tasks.json");
  if (!existsSync(cached)) {
    // Write then rename, so a parallel run never reads half a file.
    const part = `${cached}.${process.pid}`;
    writeFileSync(part, await bridge(ctx, BRIDGE));
    renameSync(part, cached);
  }
  return JSON.parse(readFileSync(cached, "utf8"));
}

export function toCase(task: WavTask, hard: Set<number>): Case {
  return {
    id: String(task.id), goal: task.intent,
    tags: [...task.sites, task.taskType, ...(task.sites.length > 1 ? ["multi-site"] : []), ...(hard.has(task.id) ? ["hard"] : [])],
    ...(hard.has(task.id) ? { tier: "hard" as const } : {}),
  };
}

/** `__SHOPPING_ADMIN__/sales` -> { site: "shopping_admin", path: "/sales" }. */
export function parseStartUrl(url: string): { site: string; path: string } {
  const m = /^__([A-Z_]+)__(.*)$/.exec(url);
  if (!m) throw new Error(`start URL ${url} names no site`);
  return { site: m[1]!.toLowerCase(), path: m[2] || "/" };
}

/** Upstream's agent prompts, from the repo at the pinned release: one per set of sites, named by the sorted site ids. */
const PROMPTS = "https://raw.githubusercontent.com/ServiceNow/webarena-verified/6473f72db5dcefc97b5725b59e734504edc28a21/examples/prompts";
export const promptName = (task: WavTask) => task.sites.toSorted().join("-");

/** Each prompt the tasks need, fetched once into the cache. */
export async function loadPrompts(ctx: BenchContext, tasks: WavTask[]): Promise<Map<string, string>> {
  const dir = join(wavDir(ctx), "prompts");
  mkdirSync(dir, { recursive: true });
  const out = new Map<string, string>();
  for (const name of new Set(tasks.map(promptName))) {
    const file = join(dir, `${name}.md`);
    if (!existsSync(file)) {
      const res = await fetch(`${PROMPTS}/${name}.md`);
      if (!res.ok) throw new Error(`upstream prompt ${name}.md: ${res.status}`);
      writeFileSync(`${file}.${process.pid}`, await res.text());
      renameSync(`${file}.${process.pid}`, file);
    }
    out.set(name, readFileSync(file, "utf8"));
  }
  return out;
}

/** Fills a prompt as upstream's agents get it: the intent, and the start URLs as a list. */
export function fillPrompt(prompt: string, intent: string, startUrls: string[]): string {
  const list = /\{% for start_url in START_URLS %\}\n(.*)\{\{ start_url \}\}\n\{% endfor %\}/;
  if (!prompt.includes("{{INTENT}}") || !list.test(prompt)) throw new Error("upstream's prompt has no {{INTENT}} or START_URLS list");
  return prompt.replace("{{INTENT}}", () => intent).replace(list, (_, indent: string) => startUrls.map((u) => `${indent}${u}`).join("\n"));
}
