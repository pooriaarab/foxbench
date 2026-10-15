// WebArena-Verified (ServiceNow, Apache-2.0) on the wav-core env: the
// shopping, shopping_admin, reddit and gitlab containers at a pinned image
// tag. One site table drives the VM's startup script, the tunnel ports and
// check(). The agent sees each site on its own port through the recording
// proxy; the proxy forwards to the tunnel on that port plus TUNNEL_OFFSET.
import { request, type IncomingHttpHeaders } from "node:http";
import { startProxy, type RecordingProxy } from "../proxy.js";
import { pickSubset } from "../subsets.js";
import type { Benchmark, BenchContext, Episode, Readiness } from "../types.js";
import { fillPrompt, loadPrompts, loadTasks, parseStartUrl, promptName, toCase, uvMissing, type WavTask } from "./tasks.js";

export const WAV_TAG = "0.1.0";
export const TUNNEL_OFFSET = 10000;
const PROBE_MS = 10_000;

export interface WavSite {
  id: "shopping" | "shopping_admin" | "reddit" | "gitlab";
  /** The port the agent sees (the proxy's) and the VM's site port; the site's base URL is on it. */
  port: number;
  /** The VM port of the container's env-ctrl server (8877 inside). */
  ctrlPort: number;
  containerPort: number;
  /** A page that answers once the site is up, as upstream's own health check. */
  health: string;
  /** The path upstream's site URL has, as in its config (shopping_admin is at /admin). */
  base?: string;
  /** Upstream's test user, and the image's auto-login header; GitLab has none, so start signs in. */
  login: { user: string; password: string; header?: string };
}

// Ports and health pages as upstream's environments/container/config.py; users as its examples/configs/config.example.json.
export const wavSites: WavSite[] = [
  { id: "shopping", port: 7770, ctrlPort: 7771, containerPort: 80, health: "/customer/account/login",
    login: { user: "emma.lopez@gmail.com", password: "Password.123", header: "X-M2-Customer-Auto-Login" } },
  { id: "shopping_admin", port: 7780, ctrlPort: 7781, containerPort: 80, health: "/", base: "/admin", login: { user: "admin", password: "admin1234", header: "X-M2-Admin-Auto-Login" } },
  { id: "reddit", port: 9999, ctrlPort: 9998, containerPort: 80, health: "/login", login: { user: "MarvelsGrantMan136", password: "test1234", header: "X-Postmill-Auto-Login" } },
  { id: "gitlab", port: 8023, ctrlPort: 8024, containerPort: 8023, health: "/users/sign_in", login: { user: "byteblaze", password: "hello1234" } },
];

/** The VM's startup script: Docker, then each pinned image with its base URL set to the proxy's. */
export function wavStartup(): string {
  const run = wavSites.map((s) => `run wav-${s.id} am1n3e/webarena-verified-${s.id}:${WAV_TAG} -p ${s.port}:${s.containerPort} -p ${s.ctrlPort}:8877 -e WA_ENV_CTRL_EXTERNAL_SITE_URL=http://127.0.0.1:${s.port}${s.id === "gitlab" ? " --shm-size=2g" : ""}`);
  return `#!/bin/sh
# wav-core: the WebArena-Verified sites. Runs as root on every boot; a container that exists is only started.
set -e
command -v docker >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io; }
systemctl enable --now docker
run() {
  name=$1 image=$2
  shift 2
  if docker inspect "$name" >/dev/null 2>&1; then docker start "$name"; return; fi
  docker pull -q "$image"
  docker run -d --name "$name" --restart unless-stopped "$@" "$image"
}
${run.join("\n")}
`;
}

/** Each site's URL and env-ctrl URL on the tunnel, or on FOXBENCH_WAV_HOST. */
export function wavUrls(env: NodeJS.ProcessEnv, offset = TUNNEL_OFFSET) {
  const host = env.FOXBENCH_WAV_HOST || "127.0.0.1";
  return wavSites.map((s) => ({ site: s, url: `http://${host}:${s.port + offset}`, ctrl: `http://${host}:${s.ctrlPort + offset}` }));
}

type SiteUrl = ReturnType<typeof wavUrls>[number];

/** One request with no connection pool, so a dead tunnel never hands back a stale socket. */
function http(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? "GET", headers: opts.headers, agent: false, timeout: PROBE_MS }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`no answer in ${PROBE_MS / 1000} s`)));
    req.on("error", reject);
    req.end(opts.body);
  });
}
const get = (url: string) => http(url);
const sessionCookie = (headers: IncomingHttpHeaders) => headers["set-cookie"]?.map((c) => /^_gitlab_session=([^;]*)/.exec(c)?.[1]).find(Boolean);

/** Signs in to GitLab through the tunnel, as upstream's UI login does, and returns the session cookie. */
async function gitlabSession(u: SiteUrl, host: string): Promise<string> {
  const page = await http(`${u.url}/users/sign_in`, { headers: { host } });
  const token = /name="authenticity_token" value="([^"]+)"/.exec(page.body)?.[1];
  const anon = sessionCookie(page.headers);
  if (!token || !anon) throw new Error(`gitlab: ${u.url}/users/sign_in has no sign-in form (${page.status})`);
  const form = new URLSearchParams({ authenticity_token: token, "user[login]": u.site.login.user, "user[password]": u.site.login.password, "user[remember_me]": "0" });
  const res = await http(`${u.url}/users/sign_in`, { method: "POST", body: form.toString(),
    headers: { host, cookie: `_gitlab_session=${anon}`, "content-type": "application/x-www-form-urlencoded" } });
  const session = sessionCookie(res.headers);
  if (res.status !== 302 || !session) throw new Error(`gitlab: signing in as ${u.site.login.user} returned ${res.status}`);
  return `_gitlab_session=${session}`;
}

/** What the proxy adds on each request to a site: its own Host, so links stay on the proxy port, and the login (P3). */
async function siteHeaders(u: SiteUrl): Promise<Record<string, string>> {
  const host = `127.0.0.1:${u.site.port}`;
  const { header, user, password } = u.site.login;
  return { host, ...(header ? { [header]: `${user}:${password}` } : { cookie: await gitlabSession(u, host) }) };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Null when env-ctrl says healthy and the health page loads; else why not. */
async function probe(url: string, ctrl: string, health: string): Promise<string | null> {
  try {
    const body = JSON.parse((await get(`${ctrl}/status`)).body) as { success?: boolean; message?: string };
    if (!body.success) return `env-ctrl at ${ctrl}/status says not healthy${body.message ? `: ${body.message}` : ""}`;
  } catch (error) {
    return `env-ctrl at ${ctrl}/status did not answer (${message(error)})`;
  }
  try {
    const page = await get(url + health);
    return page.status < 400 ? null : `${url}${health} returned ${page.status}`;
  } catch (error) {
    return `${url}${health} did not answer (${message(error)})`;
  }
}

/** `offset` moves the tunnel ports, for tests. */
export const webarenaVerified = (options: { offset?: number } = {}): Benchmark => ({
  id: "webarena-verified",
  title: "WebArena-Verified",
  upstream: { repo: "https://github.com/ServiceNow/webarena-verified", ref: "v1.2.3", paper: "https://openreview.net/forum?id=94tlGxmqkN" },
  licence: { code: "Apache-2.0", data: "unstated (scraped site data in the upstream Docker images)", mode: "fetch-at-run" },
  where: "vm",
  measures: ["task"],
  scoring: "programmatic",
  async check(ctx: BenchContext): Promise<Readiness> {
    const noUv = uvMissing(ctx);
    if (noUv) return { ready: false, reason: `the task list needs uv: ${noUv}`, fix: "install uv (https://docs.astral.sh/uv/) or set FOXBENCH_UV" };
    const urls = wavUrls(ctx.env, options.offset);
    const down = (await Promise.all(urls.map(async (u) => ({ id: u.site.id, why: await probe(u.url, u.ctrl, u.site.health) })))).filter((d) => d.why);
    if (!down.length) return { ready: true };
    return { ready: false, reason: down.map((d) => `${d.id}: ${d.why}`).join("; "),
      fix: "foxbench env up wav-core (GitLab takes minutes to boot), or set FOXBENCH_WAV_HOST to a host that runs the wav-core containers" };
  },
  async load(ctx, subset) {
    const { tasks, hard } = await loadTasks(ctx);
    const ids = new Set(hard);
    return pickSubset("webarena-verified", tasks.map((t) => toCase(t, ids)), subset);
  },
  async up(ctx) {
    const { tasks } = await loadTasks(ctx);
    return { sites: wavUrls(ctx.env, options.offset), tasks: new Map(tasks.map((t) => [String(t.id), t])), prompts: await loadPrompts(ctx, tasks) };
  },
  async start(env, item) {
    const { sites, tasks, prompts } = env as { sites: SiteUrl[]; tasks: Map<string, WavTask>; prompts: Map<string, string> };
    const task = tasks.get(item.id);
    if (!task) throw new Error(`webarena-verified has no task ${item.id}`);
    const missing = task.sites.filter((id) => !sites.some((u) => u.site.id === id));
    if (missing.length) throw new Error(`task ${item.id} needs ${missing.join(" and ")}, which wav-core does not run; it needs wav-full`);
    const site = (id: string) => sites.find((u) => u.site.id === id)!;
    const starts = task.startUrls.map(parseStartUrl).map((s) => ({ ...s, path: (site(s.site).site.base ?? "") + s.path }));
    const first = site(starts[0]!.site);
    // Every task's start URLs name all its sites. The run loop's proxy serves the first; each other site gets its own.
    const others = sites.filter((u) => u !== first && starts.some((s) => s.site === u.site.id));
    const headers = await Promise.all([first, ...others].map(siteHeaders));
    const proxies: RecordingProxy[] = [];
    try {
      for (const [i, u] of others.entries()) proxies.push(await startProxy(u.url, { port: u.site.port, headers: headers[i + 1]! }));
    } catch (error) {
      await Promise.all(proxies.map((p) => p.close()));
      throw error;
    }
    const startUrls = starts.map((s) => `http://127.0.0.1:${site(s.site).site.port}${s.path}`);
    const episode: Episode = {
      url: first.url + starts[0]!.path, startPath: starts[0]!.path, port: first.site.port, headers: headers[0]!,
      goal: fillPrompt(prompts.get(promptName(task))!, task.intent, startUrls),
      close: async () => { await Promise.all(proxies.map((p) => p.close())); },
    };
    return episode;
  },
  // Scoring with upstream's evaluators comes with #129.
  judge: async () => { throw new Error("webarena-verified scoring is not built yet"); },
  // The VM stops only through foxbench env down.
  down: async () => {},
  baselines: [],
});
