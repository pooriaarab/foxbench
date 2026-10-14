// Fetches WebArena-Infinity at the pinned commit into the cache. The tree is
// built in a temporary directory and renamed into place only when whole (WI1).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const WAI_REPO = "https://github.com/web-arena-x/webarena-infinity";
/** 2026-03-23, the head of main when this runner was written. */
export const WAI_REF = "1ca77813bf8d8e4011aa3fb1f740f70d78bd522d";
/** Directories of apps/ that are not apps: manuals (150 MB), descriptions and ablations. */
const NOT_APPS = new Set(["app-description", "user-manuals", "ablations"]);

export const upstreamDir = (cacheDir: string): string => join(cacheDir, `webarena-infinity-${WAI_REF.slice(0, 12)}`);

const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, maxBuffer: 1 << 26 }).then((r) => r.stdout.trim());

/** The path of the pinned tree, fetching it first when the cache has none. */
export async function fetchUpstream(cacheDir: string): Promise<string> {
  const dir = upstreamDir(cacheDir);
  if (existsSync(join(dir, ".foxbench-ref"))) return dir;
  mkdirSync(cacheDir, { recursive: true });
  const tmp = mkdtempSync(join(cacheDir, ".fetch-"));
  try {
    await git(tmp, "init", "-q");
    await git(tmp, "fetch", "-q", "--depth", "1", "--filter=blob:none", WAI_REPO, WAI_REF);
    const apps = (await git(tmp, "ls-tree", "--name-only", "FETCH_HEAD", "apps/")).split("\n").filter((p) => !NOT_APPS.has(p.slice("apps/".length)));
    await git(tmp, "sparse-checkout", "set", "--cone", ...apps);
    await git(tmp, "checkout", "-q", "FETCH_HEAD");
    const head = await git(tmp, "rev-parse", "HEAD");
    if (head !== WAI_REF) throw new Error(`fetched ${head}, not the pinned ${WAI_REF}`);
    rmSync(join(tmp, ".git"), { recursive: true, force: true });
    writeFileSync(join(tmp, ".foxbench-ref"), `${WAI_REF}\n`);
    // A run that finished first has already put the same tree there; keep it, as a reader may be using it.
    if (existsSync(join(dir, ".foxbench-ref"))) rmSync(tmp, { recursive: true, force: true });
    else renameSync(tmp, dir);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/** The pinned commit recorded in a fetched tree, or null. */
export const fetchedRef = (dir: string): string | null => (existsSync(join(dir, ".foxbench-ref")) ? readFileSync(join(dir, ".foxbench-ref"), "utf8").trim() : null);
