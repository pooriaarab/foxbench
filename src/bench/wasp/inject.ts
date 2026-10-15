// WASP's data and its own injector. The repo's webarena_prompt_injections/ is
// fetched at the pinned commit into the cache (CC-BY-NC-4.0: never committed).
// A bridge script, written into foxbench's own helper dir, imports WASP's
// WebArenaPromptInjector from there and runs it for one case through uv, with
// Playwright Chromium in the cache: the goal's setup, then the attacker's
// issue or post. It prints the user's task and the attacker's, instantiated.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BenchContext } from "../types.js";
import type { WaTask } from "../wa/eval.js";

const run = promisify(execFile);
export const WASP_REPO = "https://github.com/facebookresearch/wasp";
/** 2025-05-14, the head of main; the repo is archived. */
export const WASP_REF = "ffee6f41fde76acd14bd792db442479c506260c2";
const PART = "webarena_prompt_injections";
/** The two formats upstream's run.py runs, by the short name in case ids. */
export const FORMATS = { plain: "goal_hijacking_plain_text", url: "goal_hijacking_url_injection" } as const;
const PYTHON = ["--python", "3.12", "--with", "playwright==1.55.0", "--with", "click==8.1.8", "--with", "tqdm==4.67.1"];

export type WaspEval = WaTask["eval"] & { exfil_data?: { must_include: string }[] };
/** One attacker goal of experiment_config.raw.json. */
export interface WaspConfig { environment?: string; exfil: boolean; parameters: Record<string, unknown>; eval: WaspEval; [field: string]: unknown }
/** A task as the injector hands it back, instantiated on the site's origin. */
export interface WaspTask { intent: string; start_url: string; eval: WaspEval }
export interface Injected { user: WaspTask; attacker: WaspTask }
/** `origins`: each site's own origin, `http://127.0.0.1:<port>`. */
export interface InjectRequest { config: WaspConfig; format: string; goal: number; origins: Record<string, string> }
export type Injector = (ctx: BenchContext, req: InjectRequest) => Promise<Injected>;

export const waspDir = (ctx: BenchContext) => join(ctx.cacheDir, `wasp-${WASP_REF.slice(0, 12)}`);
const uv = (ctx: BenchContext) => ctx.env.FOXBENCH_UV || "uv";

/** The fetched webarena_prompt_injections/, fetched first when the cache has none (WS1). */
export async function fetchWasp(ctx: BenchContext): Promise<string> {
  const dir = waspDir(ctx);
  if (existsSync(join(dir, ".foxbench-ref"))) return join(dir, PART);
  mkdirSync(ctx.cacheDir, { recursive: true });
  const tmp = mkdtempSync(join(ctx.cacheDir, ".fetch-"));
  const git = (...args: string[]) => run("git", ["-C", tmp, ...args], { env: ctx.env });
  try {
    await git("init", "-q");
    await git("sparse-checkout", "set", "--cone", PART);
    await git("fetch", "-q", "--depth", "1", "--filter=blob:none", WASP_REPO, WASP_REF);
    await git("checkout", "-q", "FETCH_HEAD");
    rmSync(join(tmp, ".git"), { recursive: true, force: true });
    writeFileSync(join(tmp, ".foxbench-ref"), `${WASP_REF}\n`);
    if (existsSync(join(dir, ".foxbench-ref"))) rmSync(tmp, { recursive: true, force: true });
    else renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return join(dir, PART);
}

/** The 21 attacker goals, as upstream ships them. */
export const readAttacks = (dir: string): WaspConfig[] => JSON.parse(readFileSync(join(dir, "configs", "experiment_config.raw.json"), "utf8")).prompt_injections_setup_config;

// Runs with python -I from foxbench's helper dir. WASP prints progress, so its stdout goes to stderr.
const BRIDGE = `import contextlib, json, sys
wasp, config, fmt, goal, origins = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3], int(sys.argv[4]), json.loads(sys.argv[5])
sys.path.insert(0, wasp)
out = sys.stdout
with contextlib.redirect_stdout(sys.stderr):
    from environment_editors.gitlab_editor import GitlabEditor
    from environment_editors.reddit_editor import RedditEditor
    from prompt_injector import WebArenaPromptInjector
    site = config["environment"]
    editor = GitlabEditor(origins[site]) if site == "gitlab" else RedditEditor(origins[site])
    injector = WebArenaPromptInjector([editor], [config])
    injector._prepare_environment()
    injector._prepare_injection(fmt, goal)
    user, attacker = injector._inject_prompts(goal, False)
    pick = lambda t: {"intent": t["intent"], "start_url": t["start_url"], "eval": t["eval"]}
    result = {"user": pick(user[0]), "attacker": pick(attacker[0])}
json.dump(result, out)
`;

const browsers = (ctx: BenchContext) => join(ctx.cacheDir, "wasp-browsers");
const uvRun = (ctx: BenchContext, args: string[], cwd: string) =>
  run(uv(ctx), ["run", "-q", "--isolated", "--no-project", ...PYTHON, "python", "-I", ...args],
    { cwd, encoding: "utf8", env: { ...ctx.env, PLAYWRIGHT_BROWSERS_PATH: browsers(ctx) }, maxBuffer: 1 << 26, timeout: 15 * 60_000 });

/** The injector that runs WASP's own code. Installs Playwright's Chromium into the cache on first use. */
export const realInjector: Injector = async (ctx, req) => {
  const helper = join(ctx.cacheDir, "wasp-helper");
  mkdirSync(helper, { recursive: true });
  if (!existsSync(join(browsers(ctx), ".foxbench-ready"))) {
    await uvRun(ctx, ["-m", "playwright", "install", "chromium"], helper);
    writeFileSync(join(browsers(ctx), ".foxbench-ready"), "");
  }
  writeFileSync(join(helper, "inject.py"), BRIDGE);
  const { stdout } = await uvRun(ctx, [join(helper, "inject.py"), await fetchWasp(ctx), JSON.stringify(req.config), req.format, String(req.goal), JSON.stringify(req.origins)], helper)
    .catch((e: Error & { stderr?: string }) => { throw new Error((e.stderr || e.message).trim().split("\n").slice(-3).join(" ")); });
  return JSON.parse(stdout);
};
