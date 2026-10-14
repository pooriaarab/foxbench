// tau2-bench at a pinned commit in the cache, and the Python bridge that runs
// its tools (bridge.py). Only the paths the benchmarks need are checked out:
// the package source and the retail and airline data. Nothing is committed.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BenchContext } from "../types.js";
import { locked } from "../webgames.js";

const run = promisify(execFile);

export const TAU2_REPO = "https://github.com/sierra-research/tau2-bench.git";
/** Tag v1.0.1, 2026-07-16. MIT. */
export const TAU2_REF = "fc0055dc4e0a316c3f83133267fbd6faaa770992";
const PATHS = ["/src/", "/pyproject.toml", "/README.md", "/LICENSE", "/data/tau2/domains/retail/", "/data/tau2/domains/airline/", "/data/tau2/user_simulator/"];

export const tau2Dir = (ctx: BenchContext) => join(ctx.cacheDir, `tau2-${TAU2_REF.slice(0, 12)}`);

/** The pinned commit in the cache, fetched once (T1). */
export const fetchTau2 = (ctx: BenchContext): Promise<string> => locked(tau2Dir(ctx), async () => {
  const dir = tau2Dir(ctx);
  if (!existsSync(join(dir, "pyproject.toml"))) {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => run("git", ["-C", dir, ...args], { env: ctx.env });
    await git("init", "-q");
    await git("sparse-checkout", "set", "--no-cone", ...PATHS);
    await git("fetch", "-q", "--depth", "1", "--filter=blob:none", TAU2_REPO, TAU2_REF);
    await git("checkout", "-q", "FETCH_HEAD");
  }
  return dir;
});

export interface Tau2Reply { content: string; error: boolean }

export interface Tau2Bridge {
  /** A fresh environment from the start database (T5). */
  reset(): Promise<void>;
  /** One tool call, run by tau2. A tool error is a reply with `error`; a dead bridge rejects. */
  call(name: string, args: Record<string, unknown>): Promise<Tau2Reply>;
  close(): Promise<void>;
}

/** Starts bridge.py for a domain under uv, from a directory foxbench owns, never inside the fetched tree. */
export async function startBridge(ctx: BenchContext, domain: "retail" | "airline"): Promise<Tau2Bridge> {
  const dir = await fetchTau2(ctx);
  const script = fileURLToPath(new URL("./bridge.py", import.meta.url));
  const work = join(ctx.cacheDir, "tau2-run");
  mkdirSync(work, { recursive: true });
  const child = spawn("uv", ["run", "--isolated", "--no-project", "--python", "3.12", "--with", dir, "python", "-I", script, "serve", domain],
    { cwd: work, env: { ...ctx.env, TAU2_DATA_DIR: join(dir, "data") }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-4000); });
  const waiting: { resolve(reply: Record<string, unknown>): void; reject(error: Error): void }[] = [];
  let dead: Error | null = null;
  createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.resolve(JSON.parse(line)));
  const die = (why: string) => {
    dead ??= new Error(`the tau2 bridge stopped (${why}): ${stderr.trim().split("\n").at(-1) ?? ""}`);
    for (const w of waiting.splice(0)) w.reject(dead);
  };
  child.on("exit", (code, signal) => die(`exit ${code ?? signal}`));
  child.on("error", (error) => die(error.message));
  // Replies come back in order, so a queue of waiters pairs them (T7).
  const send = (request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (dead) return reject(dead);
    waiting.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }).then((reply) => {
    if (!reply.ok) throw new Error(`tau2 bridge: ${String(reply.message)}`);
    return reply;
  });
  await send({ op: "reset" });
  return {
    reset: async () => { await send({ op: "reset" }); },
    call: async (name, args) => {
      const reply = await send({ op: "call", name, arguments: args });
      return { content: String(reply.content), error: Boolean(reply.error) };
    },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      child.stdin.end();
      child.kill();
      await exited;
    },
  };
}
