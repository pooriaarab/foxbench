// WebArena-Verified (ServiceNow, Apache-2.0) on the wav-core env: the
// shopping, shopping_admin, reddit and gitlab containers at a pinned image
// tag. One site table drives the VM's startup script, the tunnel ports and
// check(). The agent sees each site on its own port through the recording
// proxy; the proxy forwards to the tunnel on that port plus TUNNEL_OFFSET.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { startProxy, type RecordingProxy } from "../proxy.js";
import { pickSubset } from "../subsets.js";
import type { Benchmark, BenchContext, Env, Episode, Readiness } from "../types.js";
import { startHar, type HarRecorder } from "./har.js";
import { judgeCase } from "./judge.js";
import { fillPrompt, loadPrompts, loadTasks, parseStartUrl, promptName, toCase, uvMissing, wavDir, type WavTask } from "./tasks.js";

export const WAV_TAG = "0.1.0";
export const TUNNEL_OFFSET = 10000;
/** The VM port of the reset service, which recreates a site's container from its image (WJ6). */
export const RESET_PORT = 8870;
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
mkdir -p /opt/foxbench
cat > /opt/foxbench/wav-reset.py <<'PY'
${RESET_SERVICE}PY
systemctl is-active --quiet wav-reset || systemd-run --unit=wav-reset python3 /opt/foxbench/wav-reset.py
`;
}

// POST /reset/<site> recreates wav-<site> with the ports, base URL and shm size it ran with.
// The sites keep their data in the image, so a new container is the start state.
const RESET_SERVICE = `import http.server, json, subprocess

def recreate(name):
    info = json.loads(subprocess.run(["docker", "inspect", name], check=True, capture_output=True, text=True).stdout)[0]
    args = ["docker", "run", "-d", "--name", name, "--restart", "unless-stopped", "--shm-size", str(info["HostConfig"]["ShmSize"])]
    for port, binds in (info["HostConfig"]["PortBindings"] or {}).items():
        args += [a for b in binds for a in ("-p", f"{b['HostPort']}:{port.split('/')[0]}")]
    args += [a for e in info["Config"]["Env"] if e.startswith("WA_ENV_CTRL_EXTERNAL_SITE_URL=") for a in ("-e", e)]
    subprocess.run(["docker", "rm", "-f", name], check=True, capture_output=True)
    subprocess.run(args + [info["Config"]["Image"]], check=True, capture_output=True)

class Reset(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        site = self.path.removeprefix("/reset/")
        if site not in (${wavSites.map((s) => `"${s.id}"`).join(", ")}):
            return self.send_error(404)
        try:
            recreate("wav-" + site)
            self.send_response(200)
        except Exception as e:
            self.send_response(500, str(e)[:200])
        self.end_headers()

http.server.ThreadingHTTPServer(("0.0.0.0", ${RESET_PORT}), Reset).serve_forever()
`;

/** Each site's URL and env-ctrl URL on the tunnel, or on FOXBENCH_WAV_HOST, and `port`, where its proxy listens. */
export function wavUrls(env: NodeJS.ProcessEnv, offset = TUNNEL_OFFSET, portOffset = 0) {
  const host = env.FOXBENCH_WAV_HOST || "127.0.0.1";
  return wavSites.map((s) => ({ site: s, port: s.port + portOffset, url: `http://${host}:${s.port + offset}`, ctrl: `http://${host}:${s.ctrlPort + offset}`, reset: `http://${host}:${RESET_PORT + offset}/reset/${s.id}` }));
}

export type SiteUrl = ReturnType<typeof wavUrls>[number];

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
export async function siteHeaders(u: SiteUrl): Promise<Record<string, string>> {
  const host = `127.0.0.1:${u.port}`;
  const { header, user, password } = u.site.login;
  return { host, ...(header ? { [header]: `${user}:${password}` } : { cookie: await gitlabSession(u, host) }) };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Null when env-ctrl says healthy and the health page loads; else why not. */
export async function probe(url: string, ctrl: string, health: string): Promise<string | null> {
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

interface WavEnv {
  ctx: BenchContext;
  sites: SiteUrl[];
  tasks: Map<string, WavTask>;
  prompts: Map<string, string>;
  /** Sites a case sent a request to that may change them; the next case on one resets it first (WJ6). */
  dirty: Set<string>;
  /** The marks live in the cache, per host, so the next run resets too. */
  dirtyFile: string;
}
const saveDirty = (env: WavEnv) => writeFileSync(env.dirtyFile, JSON.stringify([...env.dirty]));
/** Each episode's task and HAR recorders, for its judge. */
const running = new WeakMap<Episode, { task: WavTask; hars: { site: string; har: HarRecorder }[] }>();
const READS = ["GET", "HEAD", "OPTIONS"];

/** Recreates a site's container through the env's reset service, then waits for its probe. */
export async function reset(u: SiteUrl, waitMs: number): Promise<void> {
  const res = await http(u.reset, { method: "POST" });
  if (res.status !== 200) throw new Error(`${u.site.id}: the reset service returned ${res.status}`);
  const deadline = Date.now() + waitMs;
  for (let why = await probe(u.url, u.ctrl, u.site.health); why; why = await probe(u.url, u.ctrl, u.site.health)) {
    if (Date.now() > deadline) throw new Error(`${u.site.id}: the site was not up ${Math.round(waitMs / 1000)} s after its reset (${why})`);
    await new Promise((r) => setTimeout(r, Math.min(3000, waitMs / 4)));
  }
}

/** The file of the sites to reset before their next case, per host and tunnel offset (WJ6). */
export const wavDirtyFile = (ctx: BenchContext, offset = TUNNEL_OFFSET) => join(wavDir(ctx), `dirty-${ctx.env.FOXBENCH_WAV_HOST || "127.0.0.1"}-${offset}.json`);

/** For tests: `offset` moves the tunnel ports, `portOffset` the sites' own (the proxies') ports, and `resetWaitMs` shortens the wait for a reset. */
export const webarenaVerified = (options: { offset?: number; portOffset?: number; resetWaitMs?: number } = {}): Benchmark => ({
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
    const urls = wavUrls(ctx.env, options.offset, options.portOffset);
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
    const dirtyFile = wavDirtyFile(ctx, options.offset);
    const dirty = new Set<string>(existsSync(dirtyFile) ? JSON.parse(readFileSync(dirtyFile, "utf8")) : []);
    const env: WavEnv = { ctx, sites: wavUrls(ctx.env, options.offset, options.portOffset), tasks: new Map(tasks.map((t) => [String(t.id), t])), prompts: await loadPrompts(ctx, tasks), dirty, dirtyFile };
    return env as unknown as Env;
  },
  async start(env, item) {
    const wav = env as unknown as WavEnv;
    const { sites, tasks, prompts, dirty } = wav;
    const task = tasks.get(item.id);
    if (!task) throw new Error(`webarena-verified has no task ${item.id}`);
    const missing = task.sites.filter((id) => !sites.some((u) => u.site.id === id));
    if (missing.length) throw new Error(`task ${item.id} needs ${missing.join(" and ")}, which wav-core does not run; it needs wav-full`);
    const site = (id: string) => sites.find((u) => u.site.id === id)!;
    const starts = task.startUrls.map(parseStartUrl).map((s) => ({ ...s, path: (site(s.site).site.base ?? "") + s.path }));
    const first = site(starts[0]!.site);
    // Every task's start URLs name all its sites. The run loop's proxy serves the first; each other site gets its own.
    const others = sites.filter((u) => u !== first && starts.some((s) => s.site === u.site.id));
    for (const u of [first, ...others]) {
      if (!dirty.has(u.site.id)) continue;
      await reset(u, options.resetWaitMs ?? 10 * 60_000);
      dirty.delete(u.site.id);
      saveDirty(wav);
    }
    const headers = await Promise.all([first, ...others].map(siteHeaders));
    // A HAR recorder sits behind each site's proxy and logs the requests as upstream's evaluator reads them (WJ2).
    const hars: { site: string; har: HarRecorder }[] = [];
    const proxies: RecordingProxy[] = [];
    const stop = () => Promise.all([...proxies.map((p) => p.close()), ...hars.map((h) => h.har.close())]);
    try {
      for (const u of [first, ...others]) hars.push({ site: u.site.id, har: await startHar(u.url, `http://127.0.0.1:${u.port}`) });
      for (const [i, u] of others.entries()) proxies.push(await startProxy(hars[i + 1]!.har.origin, { port: u.port, headers: headers[i + 1]! }));
    } catch (error) {
      await stop();
      throw error;
    }
    const startUrls = starts.map((s) => `http://127.0.0.1:${site(s.site).port}${s.path}`);
    const episode: Episode = {
      url: hars[0]!.har.origin + starts[0]!.path, startPath: starts[0]!.path, port: first.port, headers: headers[0]!,
      goal: fillPrompt(prompts.get(promptName(task))!, task.intent, startUrls),
      close: async () => { await stop(); },
    };
    running.set(episode, { task, hars });
    return episode;
  },
  async judge(env, episode, output) {
    const wav = env as unknown as WavEnv;
    const { ctx, sites, dirty } = wav;
    const run = running.get(episode);
    if (!run) throw new Error("webarena-verified did not start this episode");
    for (const { site, har } of run.hars) if (har.entries.some((e) => !READS.includes(e.request.method))) dirty.add(site);
    saveDirty(wav);
    const entries = run.hars.flatMap((h) => h.har.entries).toSorted((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
    const urls = Object.fromEntries(sites.map((u) => [`__${u.site.id.toUpperCase()}__`, `http://127.0.0.1:${u.port}${u.site.base ?? ""}`]));
    const score = await judgeCase(ctx, run.task.id, entries, output.answer, urls);
    const success = score.status === "success";
    return { success, score: score.score, attack: null, judgedBy: "programmatic",
      reasons: success ? [] : (score.messages.length ? score.messages : [`upstream's evaluator says ${score.status}`]).slice(0, 5).map((m) => m.slice(0, 400)) };
  },
  // The VM stops only through foxbench env down.
  down: async () => {},
  baselines: [],
});
