// A benchmark of WebArena tasks on the WebArena-Verified sites, scored with
// WebArena's own evaluators (eval.ts). WebArena-Lite and WebChoreArena are each
// a task list and a few settings; this builds the Benchmark around them. Cases
// start through wavStart, so resets, logins, proxies and HAR recorders are
// WebArena-Verified's.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startProxy, type RecordingProxy } from "../proxy.js";
import { pickSubset } from "../subsets.js";
import type { Baseline, Benchmark, BenchContext, Case, Env } from "../types.js";
import type { HarEntry } from "../wav/har.js";
import { wavDown, wavFinish, wavLogin, wavReady, wavStart, wavUp, type WavEnv } from "../wav/index.js";
import { scoreWa, type WaTask } from "./eval.js";
import { judgeBrowser, type JudgeBrowser } from "./page.js";

/** One task of a list: WebArena's config shape. */
export interface WaListTask extends WaTask {
  task_id: number;
  sites: string[];
  start_url: string;
}

export interface WaSpec {
  id: string;
  title: string;
  upstream: Benchmark["upstream"];
  licence: Benchmark["licence"];
  baselines: Baseline[];
  /** Where the task list is, and the directory in the cache it is kept in. */
  source: { url: string; dir: string };
  /** The tasks, from the fetched file. */
  tasks(ctx: BenchContext, file: string): Promise<WaListTask[]>;
  /** `func:` helpers that need a site, by name. `site(id)` has the origin the judge browser reaches the site on, and the one the agent saw. */
  helpers?: (site: (id: string) => { origin: string; canonical: string }) => NonNullable<Parameters<typeof scoreWa>[1]["helpers"]>;
}

export interface WaOptions {
  offset?: number;
  portOffset?: number;
  harDir?: string;
  resetWaitMs?: number;
  /** The judge browser; tests pass a fake. */
  browser?: (ctx: BenchContext, origins: Record<string, string>) => JudgeBrowser;
  settleMs?: number;
}

interface WaEnv extends WavEnv {
  tasks: Map<string, WaListTask>;
  origins: Record<string, string>;
  browser: JudgeBrowser;
}

/** The task file at the pinned commit: fetched once into the cache, written whole (LI1). */
export async function fetchTasks(ctx: BenchContext, source: WaSpec["source"]): Promise<string> {
  const file = join(ctx.cacheDir, source.dir, "tasks.json");
  if (!existsSync(file)) {
    const res = await fetch(source.url);
    if (!res.ok) throw new Error(`${source.url}: ${res.status}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.${process.pid}`, await res.text());
    renameSync(`${file}.${process.pid}`, file);
  }
  return file;
}

const isPage = (e: HarEntry) => {
  if (e.response.redirectURL || e.response.status >= 400) return false;
  const dest = e.request.headers.find((h) => h.name === "sec-fetch-dest")?.value;
  return dest ? dest === "document" : e.request.method === "GET" && e.response.content.mimeType.includes("text/html");
};
/** The page the agent ended on: the last page load in the HAR that did not redirect (LI4). A browser marks its page loads `sec-fetch-dest: document`; a client that sends no such header is read by its HTML GETs. */
export const finalUrl = (entries: HarEntry[]): string | undefined => entries.findLast(isPage)?.request.url;

export const waGoal = (intent: string, startUrls: string[]) =>
  `${intent}\n\nStart at ${startUrls[0]}.${startUrls.length > 1 ? ` The task also uses ${startUrls.slice(1).join(" and ")}.` : ""}\nIf the task asks a question, finish with the answer as plain text. If the task cannot be done, finish with N/A and the reason.`;

const hasFuzzy = (t: WaTask) => JSON.stringify(t.eval).includes('"fuzzy_match"');

export function waBenchmark(spec: WaSpec, options: WaOptions = {}): Benchmark {
  const listed = async (ctx: BenchContext) => spec.tasks(ctx, await fetchTasks(ctx, spec.source));
  return {
    id: spec.id, title: spec.title, upstream: spec.upstream, licence: spec.licence, baselines: spec.baselines,
    where: "vm", measures: ["task"], scoring: "mixed",
    check: (ctx) => wavReady(ctx, options.offset, options.portOffset),
    async load(ctx, subset) {
      const cases: Case[] = (await listed(ctx)).map((t) => ({
        id: String(t.task_id), goal: t.intent, tags: [...t.sites, ...t.eval.eval_types, ...(new Set(t.sites).size > 1 ? ["multi-site"] : [])],
        ...(hasFuzzy(t) ? { judge: "llm" as const } : {}),
      }));
      return pickSubset(spec.id, cases, subset);
    },
    async up(ctx) {
      const tasks = await listed(ctx);
      const origins: Record<string, string> = {};
      const env: WaEnv = { ...(await wavUp(ctx, options)), tasks: new Map(tasks.map((t) => [String(t.task_id), t])), origins, browser: (options.browser ?? judgeBrowser)(ctx, origins) };
      return env as unknown as Env;
    },
    async start(env, item) {
      const wav = env as unknown as WaEnv;
      const task = wav.tasks.get(item.id);
      if (!task) throw new Error(`${spec.id} has no task ${item.id}`);
      const startUrls = task.start_url.split(" |AND| ");
      return wavStart(wav, { id: task.task_id, sites: task.sites, startUrls, intent: task.intent }, (urls) => waGoal(task.intent, urls), options.resetWaitMs);
    },
    async judge(env, episode, output) {
      const wav = env as unknown as WaEnv;
      const { ctx, entries, task: started, urls } = wavFinish(wav, episode);
      const task = wav.tasks.get(String(started.id))!;
      // The reference URLs and targets name sites as __SHOPPING__ and the like; they are the origins the agent saw.
      const resolved: WaTask = { ...task, eval: JSON.parse(JSON.stringify(task.eval).replace(/__[A-Z_]+__/g, (m) => urls[m] ?? m)) };
      // The judge browser reaches each site through its own proxy, which adds the login (LI6). Only a case with program_html starts them.
      const proxies: RecordingProxy[] = [];
      try {
        const canonical: Record<string, string> = {};
        if (task.eval.eval_types.includes("program_html")) {
          for (const id of task.sites) {
            const { url, port, headers } = await wavLogin(wav, id);
            const proxy = await startProxy(url, { headers });
            proxies.push(proxy);
            canonical[id] = `http://127.0.0.1:${port}`;
            wav.origins[canonical[id]] = proxy.origin;
          }
        }
        const site = (id: string) => ({ canonical: canonical[id]!, origin: wav.origins[canonical[id]!]! });
        const score = await scoreWa(resolved, { answer: output.answer, finalUrl: finalUrl(entries), judges: ctx.judges ?? [], page: () => wav.browser.page(), ...(spec.helpers ? { helpers: spec.helpers(site) } : {}), ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }) });
        const first = score.judges?.[0];
        return { success: score.success, attack: null, reasons: score.reasons.slice(0, 5).map((r) => r.slice(0, 400)), judgedBy: score.llm && first ? `llm:${first.model}` : "programmatic", ...(score.judges ? { judges: score.judges } : {}) };
      } finally {
        await Promise.all(proxies.map((p) => p.close()));
        await wav.browser.closePages();
      }
    },
    async down(env) {
      await (env as unknown as WaEnv).browser.close();
      wavDown(env as unknown as WaEnv);
    },
  };
}

