// ARE and the Gaia2 validation data at pinned revisions in the cache, and the
// Python bridge that runs ARE in-process (bridge.py). Nothing is committed.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BenchContext } from "../types.js";
import { locked } from "../webgames.js";

const run = promisify(execFile);
export const ARE_REPO = "https://github.com/facebookresearch/meta-agents-research-environments.git";
/** ARE 1.2.0 (MIT), main of 2026-09-30. */
export const ARE_REF = "a9fd2edccb4bc7e22fbf45c8482a5fef30a2a5a4";
/** The `meta-agents-research-environments/gaia2` dataset revision of 2025-09-25. */
export const DATA_REF = "78ea3bdbdeec2bdcd6afa5420915d8a22f23ed99";
export const CONFIGS = ["execution", "search", "adaptability", "ambiguity", "time"] as const;
/** Kept beside the data in the cache (G1). */
export const NOTICE = "Gaia2 data: CC-BY-4.0, \"for benchmarking purposes only\". Made with Llama, so the Llama terms apply: a model trained on it and released must have a name that starts with \"Llama\". foxbench fetches it at run time and never commits or trains on it. ARE code: MIT.\n";

export const areDir = (ctx: BenchContext) => join(ctx.cacheDir, `gaia2-${ARE_REF.slice(0, 12)}`);
export const dataDir = (ctx: BenchContext) => join(ctx.cacheDir, `gaia2-data-${DATA_REF.slice(0, 12)}`);

/** ARE at the pinned commit, without its GUI and datasets. */
export const fetchAre = (ctx: BenchContext): Promise<string> => locked(areDir(ctx), async () => {
  const dir = areDir(ctx);
  if (!existsSync(join(dir, "pyproject.toml"))) {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => run("git", ["-C", dir, ...args], { env: ctx.env });
    await git("init", "-q");
    await git("sparse-checkout", "set", "--no-cone", "/are/", "/build_hooks/", "/pyproject.toml", "/requirements.txt", "/requirements-dev.txt", "/requirements-gui.txt", "/README.md", "/LICENSE", "!/are/simulation/gui/client/");
    await git("fetch", "-q", "--depth", "1", "--filter=blob:none", ARE_REPO, ARE_REF);
    await git("checkout", "-q", "FETCH_HEAD");
  }
  return dir;
});

/** One capability's validation file (about 160 MB), downloaded once. */
export const fetchData = (ctx: BenchContext, config: string): Promise<string> => locked(dataDir(ctx), async () => {
  const file = join(dataDir(ctx), `${config}.parquet`);
  if (!existsSync(file)) {
    const res = await fetch(`${(ctx.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/+$/, "")}/datasets/meta-agents-research-environments/gaia2/resolve/${DATA_REF}/${config}/validation-00000-of-00001.parquet`);
    mkdirSync(dataDir(ctx), { recursive: true });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for the Gaia2 ${config} file`);
    await pipeline(Readable.from(res.body as AsyncIterable<Uint8Array>), createWriteStream(`${file}.part`));
    renameSync(`${file}.part`, file);
    writeFileSync(join(dataDir(ctx), "NOTICE"), NOTICE);
  }
  return file;
});

export interface Gaia2Tool { app: string; name: string; description: string | null; write: boolean; args: { name: string; type: string; description: string | null; required: boolean }[] }
export interface OracleCall { app: string; tool: string; args: Record<string, unknown>; at: number; /** What ARE's tool returned in its own oracle run: an id there is another id here. */ result: unknown }
export type Gaia2Bridge = Awaited<ReturnType<typeof startBridge>>;

/** Starts bridge.py under uv, from a directory foxbench owns, never inside the fetched tree. */
export async function startBridge(ctx: BenchContext, llm?: (q: { system: string; prompt: string }) => Promise<string>, configs: readonly string[] = CONFIGS) {
  const dir = await fetchAre(ctx);
  const files = Object.fromEntries(await Promise.all(configs.map(async (c) => [c, await fetchData(ctx, c)] as const)));
  const work = join(ctx.cacheDir, "gaia2-run");
  mkdirSync(work, { recursive: true });
  const child = spawn("uv", ["run", "--isolated", "--no-project", "--python", "3.12", "--with", dir, "python", "-I", fileURLToPath(new URL("./bridge.py", import.meta.url))],
    { cwd: work, env: ctx.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-4000); });
  const waiting: { resolve(reply: Record<string, unknown>): void; reject(error: Error): void }[] = [];
  let dead: Error | null = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line) as Record<string, unknown>;
    if (!reply.llm) return waiting.shift()?.resolve(reply);
    // ARE's judge asks from its own threads; each question has an id, and the answer goes back on stdin.
    const q = reply.llm as { id: string; system: string; prompt: string };
    void (llm ? llm(q) : Promise.reject(new Error("no LLM judge"))).then((text) => ({ text }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
      .then((a) => child.stdin.write(`${JSON.stringify({ answer: q.id, ...a })}\n`));
  });
  const die = (why: string) => {
    dead ??= new Error(`the gaia2 bridge stopped (${why}): ${stderr.trim().split("\n").at(-1) ?? ""}`);
    for (const w of waiting.splice(0)) w.reject(dead);
  };
  child.on("exit", (code, signal) => die(`exit ${code ?? signal}`));
  child.on("error", (error) => die(error.message));
  const send = <T>(request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (dead) return reject(dead);
    waiting.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }).then((reply) => {
    if (!reply.ok) throw new Error(`gaia2 bridge: ${String(reply.message)}`);
    return reply as T;
  });
  // A tool error is a reply with `error`; a dead bridge rejects. `oracle` is ARE's own actions, for scripted agents only: no page serves them.
  // `start` begins ARE's scenario in a fresh environment whose clock starts now; `soft` judges with the LLM rubric, and `judge`'s `asked` counts the questions it sent.
  return {
    cases: async () => (await send<{ cases: { id: string; config: string; soft: boolean }[] }>({ op: "cases", files })).cases,
    start: async (id: string, config: string, soft: boolean) => (await send<{ tools: Gaia2Tool[] }>({ op: "start", file: files[config], id, soft })).tools,
    call: (app: string, tool: string, args: Record<string, string>) => send<{ content: string; error: boolean }>({ op: "call", app, tool, args }),
    notifications: async () => (await send<{ notifications: { type: string; message: string; at: number }[] }>({ op: "notifications" })).notifications,
    oracle: async () => (await send<{ events: OracleCall[] }>({ op: "oracle" })).events,
    judge: () => send<{ success: boolean; rationale: string; asked: number }>({ op: "judge" }),
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((r) => child.once("exit", r));
      // uv starts Python as its own child: stop the whole group, or Python outlives uv.
      process.kill(-child.pid!, "SIGKILL");
      await exited;
    },
  };
}
