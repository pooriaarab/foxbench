// The Python that benchmarks run: a virtualenv of foxbench's own in the cache,
// so no benchmark depends on what the system python has installed (a Mac's
// /usr/bin/python3 has no `requests`). It is built beside the final name and
// renamed into place only when whole, so a killed run leaves nothing to reuse
// and two runs building at once do not share a half-built tree (PY3, PY4).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BenchContext, Readiness } from "./types.js";

const run = promisify(execFile);
/** What the benchmarks' Python code imports. WebArena-Infinity's verifiers use requests. */
export const REQUIREMENTS = ["requests==2.32.5"];
const READY = ".ready";
const STALE_MS = 60 * 60 * 1000;

/** `<cache>/python/<hash of the requirement list>` (PY6). */
export const pythonDir = (cacheDir: string, requirements = REQUIREMENTS): string =>
  join(cacheDir, "python", createHash("sha256").update(requirements.join("\n")).digest("hex").slice(0, 12));

/** Runs a tool; null when it works, else the tail of what it said. */
const tool = (env: NodeJS.ProcessEnv, cmd: string, ...args: string[]): Promise<string | null> =>
  run(cmd, args, { env, maxBuffer: 1 << 24 }).then(() => null, (e: NodeJS.ErrnoException & { stderr?: string }) => (e.code === "ENOENT" ? `${cmd} was not found` : `${cmd} ${args.slice(0, 2).join(" ")} failed: ${(e.stderr || e.message).trim().slice(-400)}`));

/** Whether an environment can be made here. Makes nothing (PY8). */
export async function pythonReadiness(env: NodeJS.ProcessEnv): Promise<Readiness> {
  if ((await tool(env, "python3", "--version")) !== null) return { ready: false, reason: "python3 is not installed", fix: "install python3 (3.10 or later)" };
  if ((await tool(env, "uv", "--version")) === null) return { ready: true };
  if ((await tool(env, "python3", "-c", "import venv, ensurepip")) !== null) return { ready: false, reason: "python3 cannot make a virtualenv (venv or ensurepip is missing)", fix: "install the venv package for python3, for example `apt install python3-venv`, or install uv" };
  return { ready: true };
}

/** The interpreter of the environment for `requirements`, built first when the cache has none. */
export async function pythonEnv(ctx: Pick<BenchContext, "cacheDir" | "env">, requirements = REQUIREMENTS): Promise<string> {
  const dir = pythonDir(ctx.cacheDir, requirements);
  const python = join(dir, "bin", "python");
  if (existsSync(join(dir, READY))) return python;
  const missing = await tool(ctx.env, "python3", "--version");
  if (missing !== null) throw new Error(`python3 is not installed (${missing})`);
  const root = join(ctx.cacheDir, "python");
  mkdirSync(root, { recursive: true });
  for (const name of readdirSync(root)) if (name.startsWith(".build-") && Date.now() - statSync(join(root, name)).mtimeMs > STALE_MS) rmSync(join(root, name), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true }); // here without READY: not one of ours
  const tmp = mkdtempSync(join(root, ".build-"));
  try {
    const uv = (await tool(ctx.env, "uv", "--version")) === null;
    const made = uv ? await tool(ctx.env, "uv", "venv", tmp) : await tool(ctx.env, "python3", "-m", "venv", tmp);
    if (made !== null) throw new Error(`cannot make the Python environment: ${made}`);
    const tmpPython = join(tmp, "bin", "python");
    const installed = uv
      ? await tool(ctx.env, "uv", "pip", "install", "--python", tmpPython, ...requirements)
      : await tool(ctx.env, tmpPython, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...requirements);
    if (installed !== null) throw new Error(`cannot install ${requirements.join(" ")}: ${installed}`);
    writeFileSync(join(tmp, READY), "");
    try {
      renameSync(tmp, dir);
    } catch (error) {
      if (!existsSync(join(dir, READY))) throw error; // another run won; use its tree
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return python;
}
