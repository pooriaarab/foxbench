// WebGames (Convergence): 150 client-side challenges for web agents. Each shows
// a password when it is solved; a case passes when the agent's answer holds it,
// which is upstream's own scorer (`password in answer`). The upstream repo is
// fetched at a pinned commit into the cache, built with Vite and served from
// 127.0.0.1, one server per case. Nothing upstream is committed.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { pickSubset } from "./subsets.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness } from "./types.js";

const run = promisify(execFile);

export const WEBGAMES_REPO = "https://github.com/convergence-ai/webgames.git";
/** The commit of 2025-06-02. */
export const WEBGAMES_REF = "309866f64642b864414ca2c7ff956e59e01d3317";

/** One challenge as upstream's routes declare it. */
export interface WebgamesCase {
  id: string;
  title: string;
  description: string;
  password: string;
  tags: string[];
  difficulty?: "easy" | "medium" | "hard";
  hidden: boolean;
}

export const webgamesDir = (ctx: BenchContext) => join(ctx.cacheDir, `webgames-${WEBGAMES_REF.slice(0, 12)}`);
const appDir = (ctx: BenchContext) => join(webgamesDir(ctx), "webgames");

/** The reCAPTCHA tasks load Google's widget, so they cannot run offline. */
const needsInternet = (id: string) => id.startsWith("robo-check");

// Upstream's prompt names the page's URL. Here the agent gets the start page as its url, and the proxy's address is not the site's (P1).
const TASK_PROMPT = (description: string) =>
  `Your task is: ${description}. You must go to the start page you were given and obtain the password for the game. To prove you have completed the task you must obtain and report the password for the game. If you do not have the password, you have not managed to complete the task.`;

/** Reads the challenges from upstream's router and pages: `routes.ts` names each page's task id and password by constant. */
export function parseCases(dir: string): WebgamesCase[] {
  const pages = join(dir, "webgames", "src", "pages");
  const consts: Record<string, string> = {};
  for (const file of readdirSync(pages).filter((f) => f.endsWith(".tsx"))) {
    for (const m of readFileSync(join(pages, file), "utf8").matchAll(/export const ((?:TASK_ID|PASSWORD)_\w+) = ("(?:[^"\\]|\\.)*");/g)) consts[m[1]!] = JSON.parse(m[2]!);
  }
  // A path is a constant, a string, or a template over constants; a trailing /* (the maze) is a wildcard, not part of the case id.
  const value = (v: string) => (v.startsWith('"') ? JSON.parse(v) : v.startsWith("`") ? v.slice(1, -1).replace(/\$\{(\w+)\}/g, (_, name: string) => consts[name]!) : consts[v]);
  const routes = readFileSync(join(dir, "webgames", "src", "router", "routes.ts"), "utf8").split("export const routes: RouteConfig[] = [")[1] ?? "";
  const str = String.raw`("(?:[^"\\]|\\.)*")`;
  const out: WebgamesCase[] = [];
  for (const [, body = ""] of routes.matchAll(/\n {2}\{\n([\s\S]*?)\n {2}\},/g)) {
    const field = (name: string, shape: string) => new RegExp(`\\b${name}:\\s*${shape}`).exec(body)?.[1];
    const password = field("password", String.raw`(PASSWORD_\w+)`);
    const path = field("path", String.raw`(TASK_ID_\w+|${str}|`+"`[^`]*`)");
    if (!password || !path) continue;
    const difficulty = field("difficulty", String.raw`"(easy|medium|hard)"`) as WebgamesCase["difficulty"];
    out.push({
      id: value(path)!.replace(/\/\*$/, ""), title: value(field("title", str) ?? '""')!, description: value(field("description", str) ?? '""')!, password: consts[password]!,
      tags: [...(field("tags", String.raw`\[([^\]]*)\]`) ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]!),
      ...(difficulty ? { difficulty } : {}), hidden: /\bhidden:\s*true/.test(body),
    });
  }
  return out;
}

/** One writer at a time per cache dir, across processes: parallel runs and test files share the cache (G13). */
async function locked<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const lock = `${dir}.lock`;
  mkdirSync(join(dir, ".."), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // A lock that is 20 minutes old belongs to a run that died.
      if (Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 20 * 60_000) rmSync(lock, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** The pinned commit in the cache, fetched once. */
const fetchSource = (ctx: BenchContext): Promise<string> => locked(webgamesDir(ctx), async () => {
  const dir = webgamesDir(ctx);
  if (!existsSync(join(appDir(ctx), "src", "router", "routes.ts"))) {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => run("git", ["-C", dir, ...args], { env: ctx.env });
    await git("init", "-q");
    await git("fetch", "-q", "--depth", "1", WEBGAMES_REPO, WEBGAMES_REF);
    await git("checkout", "-q", "FETCH_HEAD");
  }
  return dir;
});

/** `vite build` of the pinned source into its dist/, once. The lockfile pins the packages, and no install script runs. */
async function build(ctx: BenchContext): Promise<string> {
  await fetchSource(ctx);
  const app = appDir(ctx);
  await locked(`${webgamesDir(ctx)}-build`, async () => {
    if (existsSync(join(app, "dist", "index.html"))) return;
    await run("pnpm", ["--dir", app, "install", "--frozen-lockfile", "--ignore-scripts"], { env: ctx.env, maxBuffer: 1 << 26 });
    await run("pnpm", ["--dir", app, "exec", "vite", "build"], { env: ctx.env, maxBuffer: 1 << 26 });
  });
  return join(app, "dist");
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".json": "application/json", ".png": "image/png" };

/** Serves dist/ with the single-page fallback, and answers upstream's two analytics calls. */
async function serve(dist: string) {
  const server = createServer((req: IncomingMessage, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (path.startsWith("/api/")) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end('{"success":true}');
      return;
    }
    const file = join(dist, normalize(path));
    const known = file.startsWith(dist + sep) && extname(path) && existsSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(known ? file : "x.html")] ?? "application/octet-stream" }).end(readFileSync(known ? file : join(dist, "index.html")));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Each episode's password, for its judge. */
const passwords = new WeakMap<Episode, { password: string; all: string[] }>();

export const webgamesBenchmark = (): Benchmark => {
  let cases: WebgamesCase[] = [];
  return {
    id: "webgames",
    title: "WebGames",
    upstream: { repo: "https://github.com/convergence-ai/webgames", ref: WEBGAMES_REF, paper: "https://arxiv.org/abs/2502.18356" },
    licence: { code: "Apache-2.0", data: "MIT", mode: "fetch-at-run" },
    where: "local",
    measures: ["task"],
    scoring: "programmatic",
    async check(ctx): Promise<Readiness> {
      const have = (cmd: string) => spawnSync(cmd, ["--version"], { env: ctx.env }).status === 0;
      for (const [cmd, fix] of [["git", "install git"], ["pnpm", "install pnpm (corepack enable)"]] as const) {
        if (!have(cmd)) return { ready: false, reason: `${cmd} is not installed`, fix };
      }
      if (existsSync(join(appDir(ctx), "dist", "index.html"))) return { ready: true };
      const net = spawnSync("git", ["ls-remote", "--exit-code", WEBGAMES_REPO, "HEAD"], { env: ctx.env, timeout: 30_000 });
      return net.status === 0 ? { ready: true } : { ready: false, reason: "github.com is not reachable, and WebGames is not in the cache", fix: "connect to the network once; the cache is used after that" };
    },
    async load(ctx, subset) {
      cases = parseCases(await fetchSource(ctx)).filter((c) => !c.hidden);
      const all: Case[] = cases.map((c) => ({
        id: c.id, tags: [...c.tags, ...(needsInternet(c.id) ? ["recaptcha"] : [])], ...(c.difficulty ? { tier: c.difficulty } : {}), goal: TASK_PROMPT(c.description),
      }));
      return pickSubset("webgames", all, subset);
    },
    async up(ctx) {
      const dist = await build(ctx);
      cases = parseCases(await fetchSource(ctx)).filter((c) => !c.hidden);
      return { dist };
    },
    async start(env, item) {
      const found = cases.find((c) => c.id === item.id);
      if (!found) throw new Error(`webgames has no case ${item.id}`);
      if (needsInternet(found.id)) throw new Error("skipped: needs the internet (reCAPTCHA)");
      const site = await serve(env.dist as string);
      const episode: Episode = { url: `${site.origin}/${found.id}`, goal: TASK_PROMPT(found.description), startPath: `/${found.id}`, close: site.close };
      passwords.set(episode, { password: found.password, all: cases.map((c) => c.password) });
      return episode;
    },
    async judge(_env, episode, output) {
      const want = passwords.get(episode);
      if (!want) throw new Error("webgames did not start this episode");
      // Upstream's `password in answer` finds CircleMaster2024 inside EasyCircleMaster2024, so clear the longer ones first (G6).
      let answer = String(output.log ?? "");
      for (const other of want.all) if (other !== want.password && other.includes(want.password)) answer = answer.split(other).join(" ");
      const success = answer.includes(want.password);
      return { success, attack: null, reasons: success ? [] : ["the answer does not hold the password"], judgedBy: "programmatic" };
    },
    down: async () => {},
    baselines: [
      { agent: "human", subset: "full", score: 0.957, source: "https://github.com/convergence-ai/webgames" },
      { agent: "Gemini 2.5 Pro preview (about 50%)", subset: "full", score: 0.5, source: "https://github.com/convergence-ai/webgames" },
    ],
  };
};
