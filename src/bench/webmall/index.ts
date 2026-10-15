// WebMall (Peeters et al., University of Mannheim): 91 shopping tasks over four WooCommerce
// shops. It runs on the webmall env (`foxbench env up webmall`). Each shop gets its own
// recording proxy on the port that is also the shop's own URL, so links stay on the proxy.
// Scores are not published until the authors agree: the repo has no licence.
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startProxy, type RecordingProxy } from "../proxy.js";
import { pickSubset } from "../subsets.js";
import type { Benchmark, Episode, Readiness, Trace } from "../types.js";
import { TUNNEL_OFFSET, WEBMALL_REF, webmallSites } from "./env.js";
import { scoreTask, visitedPages, type ShopState } from "./judge.js";
import { loadTasks, toCase, type WebmallTask } from "./tasks.js";

const shops = webmallSites.filter((s) => s.id !== "frontend");
const TIMEOUT_MS = 30_000;

/** The control plugin's key, as `foxbench env up webmall` made it. Read only: check() must not write files. */
const keyFile = (env: NodeJS.ProcessEnv) => join(env.HOME ?? homedir(), ".foxbench", "env", "webmall.key");
const knownKey = (env: NodeJS.ProcessEnv) => env.FOXBENCH_WEBMALL_KEY || (existsSync(keyFile(env)) ? readFileSync(keyFile(env), "utf8").trim() : undefined);

type Shop = { port: number; url: string; origin: string };
const urls = (env: NodeJS.ProcessEnv, offset: number): Shop[] =>
  shops.map((s) => ({ port: s.port, url: `http://${env.FOXBENCH_WEBMALL_HOST || "127.0.0.1"}:${s.port + offset}`, origin: `http://127.0.0.1:${s.port}` }));

/** A call to a shop's control plugin, direct, with the shop's own Host so WordPress does not redirect (fetch cannot set Host). */
function control(shop: Shop, key: string, what: "state" | "reset"): Promise<ShopState> {
  return new Promise((resolve, reject) => {
    const req = request(`${shop.url}/wp-json/foxbench/v1/${what}`, { method: what === "reset" ? "POST" : "GET", agent: false, timeout: TIMEOUT_MS,
      headers: { host: `127.0.0.1:${shop.port}`, "x-foxbench-key": key } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk; });
      res.on("end", () => (res.statusCode === 200 ? resolve(JSON.parse(body) as ShopState) : reject(new Error(`${shop.url} control ${what} returned ${res.statusCode}`))));
    });
    req.on("timeout", () => req.destroy(new Error(`${shop.url} did not answer in ${TIMEOUT_MS / 1000} s`)));
    req.on("error", reject);
    req.end();
  });
}

const sessions = new WeakMap<Episode, { task: WebmallTask; proxies: RecordingProxy[]; shops: Shop[]; key: string }>();

/** `offset` moves the tunnel ports, for tests. */
export const webmallBenchmark = (options: { offset?: number } = {}): Benchmark => {
  const offset = options.offset ?? TUNNEL_OFFSET;
  return {
    id: "webmall",
    title: "WebMall",
    upstream: { repo: "https://github.com/wbsg-uni-mannheim/WebMall", ref: WEBMALL_REF, paper: "https://arxiv.org/abs/2508.13024" },
    licence: { code: "none stated in the repo (the tasks' metadata says Apache-2.0)", data: "unstated (product data from Common Crawl)", mode: "fetch-at-run" },
    where: "vm",
    measures: ["task", "info-seeking"],
    scoring: "programmatic",
    async check(ctx): Promise<Readiness> {
      const key = knownKey(ctx.env);
      const fix = "foxbench env up webmall (or --provider docker), then set FOXBENCH_WEBMALL_HOST if the shops are on another host";
      if (!key) return { ready: false, reason: "no control key: the webmall env has not been started on this machine", fix };
      const down = (await Promise.all(urls(ctx.env, offset).map((s) => control(s, key, "state").then(() => null, (e: Error) => `${s.url}: ${e.message}`)))).filter(Boolean);
      return down.length ? { ready: false, reason: down.join("; "), fix } : { ready: true };
    },
    async load(ctx, subset) {
      return pickSubset("webmall", (await loadTasks(ctx)).map(toCase), subset);
    },
    async up(ctx) {
      const key = knownKey(ctx.env);
      if (!key) throw new Error("no control key: run foxbench env up webmall first");
      return { tasks: new Map((await loadTasks(ctx)).map((t) => [t.id, t])), shops: urls(ctx.env, offset), key };
    },
    async start(env, item) {
      const { tasks, shops: sites, key } = env as { tasks: Map<string, WebmallTask>; shops: Shop[]; key: string };
      const task = tasks.get(item.id);
      if (!task) throw new Error(`webmall has no task ${item.id}`);
      // The shops hold the authors' old carts and orders: every case starts from none.
      await Promise.all(sites.map((s) => control(s, key, "reset")));
      const proxies: RecordingProxy[] = [];
      try {
        for (const s of sites.slice(1)) proxies.push(await startProxy(s.url, { port: s.port, headers: { host: `127.0.0.1:${s.port}` } }));
      } catch (error) {
        await Promise.all(proxies.map((p) => p.close()));
        throw error;
      }
      const episode: Episode = {
        url: `${sites[0]!.url}/`, startPath: "/", port: sites[0]!.port, headers: { host: `127.0.0.1:${sites[0]!.port}` }, goal: task.goal,
        close: async () => { await Promise.all(proxies.map((p) => p.close())); },
      };
      sessions.set(episode, { task, proxies, shops: sites, key });
      return episode;
    },
    async judge(_env, episode, output, trace: Trace) {
      const session = sessions.get(episode);
      if (!session) throw new Error("webmall did not start this episode");
      const states = await Promise.all(session.shops.map((s) => control(s, session.key, "state")));
      const state: ShopState = { carts: states.flatMap((s) => s.carts), orders: states.flatMap((s) => s.orders) };
      const visited = visitedPages([{ origin: session.shops[0]!.origin, requests: trace.requests }, ...session.proxies.map((p, i) => ({ origin: session.shops[i + 1]!.origin, requests: p.trace }))]);
      const { success, score, reasons } = scoreTask(session.task, output.answer ?? "", state, visited);
      return { success, score, attack: null, reasons, judgedBy: "programmatic" };
    },
    down: async () => {},
    baselines: [
      { agent: "GPT-5.4, AX-tree (specific search, 128 s and $0.40 per task)", subset: "the paper's specific-search tasks", score: 0.69, source: "https://arxiv.org/html/2508.13024v3" },
    ],
  };
};
