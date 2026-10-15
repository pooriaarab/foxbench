// The user's own AppWorld install, driven through bridge.py. AppWorld's code
// and data stay where `appworld install` and `appworld download data` put
// them; foxbench reads them only through the bridge, in memory (AW1).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { BenchContext, Readiness } from "../types.js";

export const APPWORLD_VERSION = "0.1.3.post1";
/** Tag v0.1.3.post1 of StonyBrookNLP/appworld, 2026-02-17. Apache-2.0; the app code and data must stay encrypted in any public copy. */
export const APPWORLD_REF = "66ad8099e12188ece0d3fe45e661dbc01880813b";
const SCRIPT = fileURLToPath(new URL("./bridge.py", import.meta.url));
const INSTALL = `pip install appworld==${APPWORLD_VERSION} && appworld install && appworld download data`;

export interface ApiParam { name: string; type: string; required: boolean; description: string; default: unknown }
export interface ApiDoc { name: string; description: string; method: string; parameters: ApiParam[] }
export interface AppWorldTask { goal: string; supervisor: Record<string, string>; apps: Record<string, ApiDoc[]> }
/** `json` is the result as Python's JSON text, so 4.0 stays 4.0. */
export interface CallReply { result?: unknown; json?: string; error?: string; completed: boolean }
export interface Evaluation { success: boolean; passes: number; fails: number; completed: boolean }

export interface AppWorldBridge {
  tasks(): Promise<{ id: string; split: string; difficulty: number }[]>;
  /** Opens a fresh world for the task, closing the one before (AW8). */
  open(id: string): Promise<AppWorldTask>;
  /** One API call with the form's text; an API error is a reply with `error`, a dead bridge rejects. */
  call(app: string, api: string, args: Record<string, string>): Promise<CallReply>;
  /** AppWorld's evaluator on the open world. */
  evaluate(): Promise<Evaluation>;
  close(): Promise<void>;
}

const python = (ctx: BenchContext) => ctx.env.APPWORLD_PYTHON ?? "python3";
/** The bridge runs in an empty folder of its own, so nothing lands in the user's working directory. */
const scratch = () => mkdtempSync(join(tmpdir(), "foxbench-appworld-"));

/** Not ready, with the fix, unless the pinned AppWorld is installed, unpacked and has its data (AW2). */
export async function appworldReadiness(ctx: BenchContext): Promise<Readiness> {
  const fix = `${INSTALL}, then set APPWORLD_ROOT to the folder that holds data/ and APPWORLD_PYTHON to that install's python`;
  const root = ctx.env.APPWORLD_ROOT;
  if (!root) return { ready: false, reason: "AppWorld runs only through your own install, and APPWORLD_ROOT is not set", fix };
  if (!existsSync(join(root, "data", "version.txt"))) return { ready: false, reason: `AppWorld's data is not in ${root}/data`, fix: `run \`appworld download data\` in ${root}` };
  const cwd = scratch();
  const out = await new Promise<string>((resolve) => execFile(python(ctx), ["-I", "-B", SCRIPT, "check"], { cwd, env: ctx.env, timeout: 120_000 }, (_, stdout) => resolve(stdout)));
  rmSync(cwd, { recursive: true, force: true });
  let got: { ready: boolean; why: string; version?: string };
  try {
    got = JSON.parse(out);
  } catch {
    return { ready: false, reason: `${python(ctx)} could not run the AppWorld check`, fix };
  }
  if (got.ready) return { ready: true };
  const reason = { missing: "the appworld package is not installed", unpacked: "the appworld package is not unpacked by `appworld install`", version: `appworld ${got.version} is installed, not ${APPWORLD_VERSION}` }[got.why] ?? got.why;
  return { ready: false, reason: `${reason} (${python(ctx)})`, fix };
}

export async function startBridge(ctx: BenchContext): Promise<AppWorldBridge> {
  const cwd = scratch();
  // stderr holds AppWorld's own prints, which can quote its data: never read, never logged (AW1).
  const child = spawn(python(ctx), ["-I", "-B", SCRIPT, "serve"], { cwd, env: ctx.env, stdio: ["pipe", "pipe", "ignore"] });
  const waiting: { resolve(reply: Record<string, unknown>): void; reject(error: Error): void }[] = [];
  let dead: Error | null = null;
  createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.resolve(JSON.parse(line) as Record<string, unknown>));
  const die = (why: string) => {
    dead ??= new Error(`the AppWorld bridge stopped (${why})`);
    for (const w of waiting.splice(0)) w.reject(dead);
    rmSync(cwd, { recursive: true, force: true });
  };
  child.on("exit", (code, signal) => die(`exit ${code ?? signal}`));
  child.on("error", (error) => die(error.message));
  const send = async (request: Record<string, unknown>) => {
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      if (dead) return reject(dead);
      waiting.push({ resolve, reject });
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
    const { ok, message, ...rest } = reply;
    if (!ok) throw new Error(`the AppWorld bridge failed: ${String(message)}`);
    return rest;
  };
  return {
    tasks: async () => (await send({ op: "tasks" })).tasks as Awaited<ReturnType<AppWorldBridge["tasks"]>>,
    open: async (id) => (await send({ op: "open", id })) as unknown as AppWorldTask,
    call: async (app, api, args) => (await send({ op: "call", app, api, args })) as unknown as CallReply,
    evaluate: async () => (await send({ op: "evaluate" })) as unknown as Evaluation,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.stdin.end();
      child.kill();
      await exited;
    },
  };
}
