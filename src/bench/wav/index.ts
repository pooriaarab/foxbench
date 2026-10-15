// WebArena-Verified (ServiceNow, Apache-2.0) on the wav-core env: the
// shopping, shopping_admin, reddit and gitlab containers at a pinned image
// tag. One site table drives the VM's startup script, the tunnel ports and
// check(). The agent sees each site on its own port through the recording
// proxy; the proxy forwards to the tunnel on that port plus TUNNEL_OFFSET.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerMirror } from "../../env/mirror.js";
import { startProxy, type RecordingProxy } from "../proxy.js";
import { pickSubset } from "../subsets.js";
import type { Benchmark, BenchContext, Env, Episode, Readiness } from "../types.js";
import { startHar, type HarRecorder } from "./har.js";
import { judgeCase } from "./judge.js";
import { fillPrompt, loadPrompts, loadTasks, parseStartUrl, promptName, toCase, uvMissing, WAV_VERSION, wavDir, type WavTask } from "./tasks.js";

export const WAV_TAG = "0.1.0";
export const TUNNEL_OFFSET = 10000;
/** The VM port of the reset service, which recreates a site's container from its image (WJ6). */
export const RESET_PORT = 8870;
const PROBE_MS = 10_000;

export interface WavSite {
  id: "shopping" | "shopping_admin" | "reddit" | "gitlab" | "wikipedia" | "map" | "classifieds";
  /** The port the agent sees (the proxy's) and the VM's site port; the site's base URL is on it. */
  port: number;
  /** The VM port of the container's env-ctrl server; 0 for a site with none (VWA's Classifieds), which is probed by its health page alone. */
  ctrlPort: number;
  /** Where env-ctrl listens inside the container; the default is 8877. */
  ctrlInner?: number;
  containerPort: number;
  /** The image tag on Docker Hub; the default is WAV_TAG (wikipedia's only tag is 1.0.0). */
  tag?: string;
  /** A page that answers once the site is up, as upstream's own health check. */
  health: string;
  /** The path upstream's site URL has, as in its config (shopping_admin is at /admin). */
  base?: string;
  /** Upstream's test user, and the image's auto-login header; GitLab has none, so start signs in. Wikipedia and map have no login. */
  login?: { user: string; password: string; header?: string };
  /** No case changes this site, so it is never reset (WF7). */
  readOnly?: boolean;
}

// Ports and health pages as upstream's environments/container/config.py; users as its examples/configs/config.example.json.
export const wavSites: WavSite[] = [
  { id: "shopping", port: 7770, ctrlPort: 7771, containerPort: 80, health: "/customer/account/login",
    login: { user: "emma.lopez@gmail.com", password: "Password.123", header: "X-M2-Customer-Auto-Login" } },
  { id: "shopping_admin", port: 7780, ctrlPort: 7781, containerPort: 80, health: "/", base: "/admin", login: { user: "admin", password: "admin1234", header: "X-M2-Admin-Auto-Login" } },
  { id: "reddit", port: 9999, ctrlPort: 9998, containerPort: 80, health: "/login", login: { user: "MarvelsGrantMan136", password: "test1234", header: "X-Postmill-Auto-Login" } },
  { id: "gitlab", port: 8023, ctrlPort: 8024, containerPort: 8023, health: "/users/sign_in", login: { user: "byteblaze", password: "hello1234" } },
];

// Ports and health pages as upstream's config.py (its docs say map is on 3030; its code and the WebArena paper say 3000). Map's env-ctrl is on 3071, not upstream's 3001: mypcbench tunnels its 3001 to the same local port.
export const wavFullSites: WavSite[] = [
  { id: "wikipedia", port: 8888, ctrlPort: 8889, ctrlInner: 8874, containerPort: 8080, tag: "1.0.0", health: "/", readOnly: true },
  { id: "map", port: 3000, ctrlPort: 3071, containerPort: 8080, health: "/", readOnly: true },
];

// The data volumes upstream's `env setup init --site map` fills (its config.py), the mount each has in the container, and for the ones it fills from an archive, that archive and the path inside it.
const MAP_URL = "https://webarena-map-server-data.s3.amazonaws.com";
const MAP_VOLUMES: { volume: string; mount: string; tar?: string; path?: string }[] = [
  { volume: "tile_db", mount: "/data/database", tar: "osm_tile_server.tar", path: "projects/ogma3/docker/volumes/osm-data/_data" },
  { volume: "routing_car", mount: "/data/routing/car", tar: "osrm_routing.tar", path: "car" },
  { volume: "routing_bike", mount: "/data/routing/bike", tar: "osrm_routing.tar", path: "bike" },
  { volume: "routing_foot", mount: "/data/routing/foot", tar: "osrm_routing.tar", path: "foot" },
  { volume: "nominatim_db", mount: "/data/nominatim/postgres", tar: "nominatim_volumes.tar", path: "projects/metis2/docker/docker/volumes/nominatim-data/_data" },
  { volume: "nominatim_flatnode", mount: "/data/nominatim/flatnode", tar: "nominatim_volumes.tar", path: "projects/metis2/docker/docker/volumes/nominatim-flatnode/_data" },
  { volume: "website_db", mount: "/var/lib/postgresql/14/main" }, { volume: "tiles", mount: "/data/tiles" }, { volume: "style", mount: "/data/style" },
];
const mapVolume = (v: string) => `webarena_verified_map_${v}`;

/** The Docker Hub image of a site; the startup script and the registry test both read it from here. */
export const wavImage = (s: WavSite) => `am1n3e/webarena-verified-${s.id}:${s.tag ?? WAV_TAG}`;

/** The sites the startup script runs, with the flags that put each one on its ports with the proxy's base URL. */
function wavRun(s: WavSite): string {
  const extra = s.id === "gitlab" ? " --shm-size=2g" : s.id === "wikipedia" ? " -v /opt/foxbench/wav-data:/data:ro"
    : s.id === "map" ? MAP_VOLUMES.map((v) => ` -v ${mapVolume(v.volume)}:${v.mount}`).join("") : "";
  return `run wav-${s.id} ${wavImage(s)} -p ${s.port}:${s.containerPort} -p ${s.ctrlPort}:${s.ctrlInner ?? 8877} -e WA_ENV_CTRL_EXTERNAL_SITE_URL=http://127.0.0.1:${s.port}${extra}`;
}

/**
 * The map's archives, streamed from the download into their volumes with no archive on the disk (the first
 * real run kept 187 GB of them beside their 187 GB of volumes and filled a 450 GB disk). One call per archive
 * lists its volumes and the path of each inside it, so the 125 GB nominatim archive downloads once for two volumes.
 */
function mapStreams(): string {
  const tars = [...new Set(MAP_VOLUMES.flatMap((v) => (v.tar ? [v.tar] : [])))];
  return tars.map((tar) => `load_map ${tar} ${MAP_VOLUMES.filter((v) => v.tar === tar).map((v) => `${mapVolume(v.volume)} ${v.path}`).join(" ")}`).join("\n");
}

/** The part of the startup script that downloads Wikipedia's and the map's data, once per site. */
function wavData(): string {
  return `# wav-full: the data of the two sites (the ZIM file is 95 GB, the map data 187 GB). The core sites above are already up.
DATA=/opt/foxbench/wav-data
mkdir -p $DATA
fail() { echo "foxbench: BOOT FAILED: $*" >&2; exit 1; }
python3 -c "import ensurepip" >/dev/null 2>&1 || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-venv; }
[ -x /opt/foxbench/wav-venv/bin/webarena-verified ] || { python3 -m venv /opt/foxbench/wav-venv && /opt/foxbench/wav-venv/bin/pip install -q webarena-verified==${WAV_VERSION}; }
[ -e /opt/foxbench/data-wikipedia.done ] || { /opt/foxbench/wav-venv/bin/webarena-verified env setup init --site wikipedia --data-dir $DATA && touch /opt/foxbench/data-wikipedia.done; }
# stream_map URL VOLUME PATH...: each volume is emptied, then filled from its path in the archive on stdin (tar strips the path, as upstream's strip_components does).
stream_map() {
  url=$1; shift
  args=""
  while [ $# -gt 0 ]; do
    docker volume create "$1" >/dev/null
    dir=$(docker volume inspect -f '{{.Mountpoint}}' "$1")
    find "$dir" -mindepth 1 -delete
    args="$args $2 --transform=s,^$2/*,\${dir#/}/,"
    shift 2
  done
  rc=$(mktemp)
  { curl -fsS --connect-timeout 30 "$url"; echo $? > "$rc"; } | tar -xp -f - -C / $args
  tarrc=$?
  curlrc=$(cat "$rc"); rm -f "$rc"
  [ "$tarrc" = 0 ] && [ "$curlrc" = 0 ]
}
# load_map ARCHIVE VOLUME PATH...: three tries, then the boot stops with a line that names the archive.
load_map() {
  tar=$1; shift
  [ -e /opt/foxbench/map-$tar.done ] && return
  for try in 1 2 3; do
    if stream_map ${MAP_URL}/$tar "$@"; then touch /opt/foxbench/map-$tar.done; return; fi
    echo "foxbench: map archive $tar failed (try $try of 3)" >&2
  done
  fail "map archive $tar did not stream into its volumes after 3 tries"
}
${mapStreams()}
${wavFullSites.map(wavRun).join("\n")}
`;
}

/** The VM's startup script: Docker, then each pinned image with its base URL set to the proxy's. With `full`, the data sites too, last. */
export function wavStartup(full = false): string {
  const run = wavSites.map(wavRun);
  return `#!/bin/sh
# wav-core: the WebArena-Verified sites. Runs as root on every boot; a container that exists is only started.
set -e
command -v docker >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io; }
${dockerMirror()}
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
${full ? wavData() : ""}`;
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
export function wavUrls(env: NodeJS.ProcessEnv, offset = TUNNEL_OFFSET, portOffset = 0, sites = wavSites, resetPort = RESET_PORT) {
  const host = env.FOXBENCH_WAV_HOST || "127.0.0.1";
  return sites.map((s) => ({ site: s, port: s.port + portOffset, url: `http://${host}:${s.port + offset}`, ctrl: s.ctrlPort ? `http://${host}:${s.ctrlPort + offset}` : "", reset: `http://${host}:${resetPort + offset}/reset/${s.id}` }));
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
  const form = new URLSearchParams({ authenticity_token: token, "user[login]": u.site.login!.user, "user[password]": u.site.login!.password, "user[remember_me]": "0" });
  const res = await http(`${u.url}/users/sign_in`, { method: "POST", body: form.toString(),
    headers: { host, cookie: `_gitlab_session=${anon}`, "content-type": "application/x-www-form-urlencoded" } });
  const session = sessionCookie(res.headers);
  if (res.status !== 302 || !session) throw new Error(`gitlab: signing in as ${u.site.login!.user} returned ${res.status}`);
  return `_gitlab_session=${session}`;
}

/** The cookies a response sets, as one Cookie header value. */
const cookies = (...heads: IncomingHttpHeaders[]) => [...new Map(heads.flatMap((h) => (h["set-cookie"] ?? []).map((c) => [c.split("=")[0]!, c.split(";")[0]!] as const))).values()].join("; ");

/** Signs in to Classifieds (Osclass) through its login form, as upstream's auto_login does, and returns the session cookies. */
async function classifiedsSession(u: SiteUrl, host: string): Promise<string> {
  const page = await http(`${u.url}/index.php?page=login`, { headers: { host } });
  // The form's CSRF token (Osclass 8 calls it octoken) goes back with the email and password, as upstream's browser sends it.
  const form = new URLSearchParams({ page: "login", action: "login_post", email: u.site.login!.user, password: u.site.login!.password, remember: "1" });
  for (const [tag] of page.body.matchAll(/<input[^>]*>/g)) {
    const name = /name=["']([^"']*token[^"']*)["']/i.exec(tag)?.[1];
    if (name) form.set(name, /value=["']([^"']*)["']/.exec(tag)?.[1] ?? "");
  }
  const res = await http(`${u.url}/index.php`, { method: "POST", body: form.toString(), headers: { host, cookie: cookies(page.headers), "content-type": "application/x-www-form-urlencoded" } });
  const session = cookies(page.headers, res.headers);
  if (res.status !== 302 || String(res.headers.location).includes("page=login") || !session) throw new Error(`classifieds: signing in as ${u.site.login!.user} returned ${res.status} to ${res.headers.location}`);
  return session;
}

/** What the proxy adds on each request to a site: its own Host, so links stay on the proxy port, and the login (P3). */
export async function siteHeaders(u: SiteUrl): Promise<Record<string, string>> {
  const host = `127.0.0.1:${u.port}`;
  if (!u.site.login) return { host };
  const { header, user, password } = u.site.login;
  return { host, ...(header ? { [header]: `${user}:${password}` } : { cookie: await (u.site.id === "classifieds" ? classifiedsSession : gitlabSession)(u, host) }) };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Null when env-ctrl says healthy and the health page loads; else why not. */
export async function probe(url: string, ctrl: string, health: string): Promise<string | null> {
  try {
    if (ctrl) {
      const body = JSON.parse((await get(`${ctrl}/status`)).body) as { success?: boolean; message?: string };
      if (!body.success) return `env-ctrl at ${ctrl}/status says not healthy${body.message ? `: ${body.message}` : ""}`;
    }
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

/** What a benchmark on the WebArena sites needs of a task: where it starts, and the sites it uses. */
export type WavCase = Omit<Pick<WavTask, "id" | "sites" | "startUrls" | "intent">, "id"> & { id: number | string };
/** The sites of a run and their reset marks, shared by every benchmark on them. */
export interface WavEnv {
  ctx: BenchContext;
  sites: SiteUrl[];
  /** Sites a case sent a request to that may change them; the next case on one resets it first (WJ6). */
  dirty: Set<string>;
  /** The marks live in the cache, per host, so the next run resets too. */
  dirtyFile: string;
  /** Why a site is not up, for the message of a case that needs one. */
  notUp: string;
  /** This run's HAR files, and whether `down` removes them (WJ9). */
  harDir: string;
  ownsHarDir: boolean;
}
interface VerifiedEnv extends WavEnv {
  tasks: Map<string, WavTask>;
  prompts: Map<string, string>;
}
const saveDirty = (env: WavEnv) => writeFileSync(env.dirtyFile, JSON.stringify([...env.dirty]));
/** Each episode's task and HAR recorders, for its judge. */
const running = new WeakMap<Episode, { task: WavCase; hars: { site: string; har: HarRecorder }[] }>();
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

/** The sites a benchmark runs on: wav-core's four by default; the vwa env passes its own, its tunnel offset and its reset port. */
export interface WavSet {
  /** The env's name, for messages. */
  name?: string;
  offset?: number;
  portOffset?: number;
  sites?: WavSite[];
  /** Sites that join the run when they answer (wav-full's data sites); wav-full's by default. */
  optional?: WavSite[];
  resetPort?: number;
  /** Where the sites it lacks run, for the message of a case that needs one. */
  elsewhere?: string;
}

/** Ready when the env's sites answer; else which one does not, and the fix. */
export async function wavReady(ctx: BenchContext, set: WavSet = {}): Promise<Readiness> {
  const down = (await Promise.all(wavUrls(ctx.env, set.offset, set.portOffset, set.sites, set.resetPort).map(async (u) => ({ id: u.site.id, why: await probe(u.url, u.ctrl, u.site.health) })))).filter((d) => d.why);
  if (!down.length) return { ready: true };
  return { ready: false, reason: down.map((d) => `${d.id}: ${d.why}`).join("; "),
    fix: `foxbench env up ${set.name ?? "wav-core"}${set.name ? "" : " (GitLab takes minutes to boot)"}, or set FOXBENCH_WAV_HOST to a host that runs the ${set.name ?? "wav-core"} containers` };
}

/** What a judge browser needs to open a site as the logged-in user: the tunnel URL, the port the agent saw, and the headers. */
export async function wavLogin(wav: WavEnv, id: string) {
  const u = wav.sites.find((s) => s.site.id === id);
  if (!u) throw new Error(`${id} is not up`);
  return { url: u.url, port: u.port, headers: await siteHeaders(u) };
}

/** The sites of a run: wav-core's four, and the data sites that answer (WF4). Reset marks come from the cache. */
export async function wavUp(ctx: BenchContext, options: WavSet & { harDir?: string } = {}): Promise<WavEnv> {
  mkdirSync(wavDir(ctx), { recursive: true });
  const dirtyFile = wavDirtyFile(ctx, options.offset);
  const dirty = new Set<string>(existsSync(dirtyFile) ? JSON.parse(readFileSync(dirtyFile, "utf8")) : []);
  const full = wavUrls(ctx.env, options.offset, options.portOffset, options.optional ?? wavFullSites, options.resetPort);
  const answering = (await Promise.all(full.map(async (u) => ((await probe(u.url, u.ctrl, u.site.health)) ? null : u)))).filter((u) => u !== null);
  return { ctx, sites: [...wavUrls(ctx.env, options.offset, options.portOffset, options.sites, options.resetPort), ...answering], dirty, dirtyFile,
    notUp: options.name ? `${options.name} does not run it; ${options.elsewhere}` : "wav-core runs shopping, shopping_admin, reddit and gitlab; run it on wav-full (foxbench env up wav-full)",
    harDir: options.harDir ?? mkdtempSync(join(tmpdir(), "fbn-wav-har-")), ownsHarDir: !options.harDir };
}

/** Removes the run's HAR directory when the run made it. */
export const wavDown = (wav: WavEnv) => { if (wav.ownsHarDir) rmSync(wav.harDir, { recursive: true, force: true }); };

/**
 * Starts one case on the sites it uses: resets what a case left changed, puts a HAR recorder
 * and a proxy with the site's login behind each site's port, and hands the agent the first
 * site. `goal` gets the start URLs on the proxy ports.
 */
export async function wavStart(wav: WavEnv, task: WavCase, goal: (startUrls: string[]) => string, resetWaitMs?: number): Promise<Episode> {
  const { sites, dirty } = wav;
  const missing = task.sites.filter((id) => !sites.some((u) => u.site.id === id));
  if (missing.length) throw new Error(`skipped: task ${task.id} needs ${missing.join(" and ")}, which is not up: ${wav.notUp}`);
  const site = (id: string) => sites.find((u) => u.site.id === id)!;
  const starts = task.startUrls.map(parseStartUrl).map((s) => ({ ...s, path: (site(s.site).site.base ?? "") + s.path }));
  const first = site(starts[0]!.site);
  // The run loop's proxy serves the first site; each other site the task uses gets its own, whether or not a start URL names it.
  const others = sites.filter((u) => u !== first && (task.sites.includes(u.site.id) || starts.some((s) => s.site === u.site.id)));
  for (const u of [first, ...others]) {
    if (!dirty.has(u.site.id)) continue;
    await reset(u, resetWaitMs ?? 10 * 60_000);
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
  const unnamed = others.filter((u) => !starts.some((s) => s.site === u.site.id)).map((u) => ({ site: u.site.id, path: `${u.site.base ?? ""}/` }));
  const startUrls = [...starts, ...unnamed].map((s) => `http://127.0.0.1:${site(s.site).port}${s.path}`);
  const episode: Episode = {
    url: hars[0]!.har.origin + starts[0]!.path, startPath: starts[0]!.path, port: first.port, headers: headers[0]!,
    goal: goal(startUrls),
    close: async () => { await stop(); },
  };
  running.set(episode, { task, hars });
  return episode;
}

/** The case's HAR entries in time order, with the reset marks set for the sites it changed. */
export function wavFinish(wav: WavEnv, episode: Episode) {
  const { ctx, sites, dirty } = wav;
  const run = running.get(episode);
  if (!run) throw new Error("webarena-verified did not start this episode");
  for (const { site, har } of run.hars) if (!sites.find((u) => u.site.id === site)?.site.readOnly && har.entries.some((e) => !READS.includes(e.request.method))) dirty.add(site);
  saveDirty(wav);
  const entries = run.hars.flatMap((h) => h.har.entries).toSorted((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
  const urls = Object.fromEntries(sites.map((u) => [`__${u.site.id.toUpperCase()}__`, `http://127.0.0.1:${u.port}${u.site.base ?? ""}`]));
  return { ctx, entries, task: run.task, urls };
}

/** For tests: `offset` moves the tunnel ports, `portOffset` the sites' own (the proxies') ports, `resetWaitMs` shortens the wait for a reset, and `harDir` is the test's own HAR directory. */
export const webarenaVerified = (options: { offset?: number; portOffset?: number; resetWaitMs?: number; harDir?: string } = {}): Benchmark => ({
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
    return wavReady(ctx, options);
  },
  async load(ctx, subset) {
    const { tasks, hard } = await loadTasks(ctx);
    const ids = new Set(hard);
    return pickSubset("webarena-verified", tasks.map((t) => toCase(t, ids)), subset);
  },
  async up(ctx) {
    const { tasks } = await loadTasks(ctx);
    const env: VerifiedEnv = { ...(await wavUp(ctx, options)), tasks: new Map(tasks.map((t) => [String(t.id), t])), prompts: await loadPrompts(ctx, tasks) };
    return env as unknown as Env;
  },
  async start(env, item) {
    const wav = env as unknown as VerifiedEnv;
    const task = wav.tasks.get(item.id);
    if (!task) throw new Error(`webarena-verified has no task ${item.id}`);
    return wavStart(wav, task, (urls) => fillPrompt(wav.prompts.get(promptName(task))!, task.intent, urls), options.resetWaitMs);
  },
  async judge(env, episode, output) {
    const wav = env as unknown as WavEnv;
    const { ctx, entries, task, urls } = wavFinish(wav, episode);
    const score = await judgeCase(ctx, wav.harDir, Number(task.id), entries, output.answer, urls);
    const success = score.status === "success";
    return { success, score: score.score, attack: null, judgedBy: "programmatic",
      reasons: success ? [] : (score.messages.length ? score.messages : [`upstream's evaluator says ${score.status}`]).slice(0, 5).map((m) => m.slice(0, 400)) };
  },
  // The VM stops only through foxbench env down.
  down: async (env) => wavDown(env as unknown as WavEnv),
  baselines: [],
});
