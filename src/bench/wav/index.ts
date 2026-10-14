// WebArena-Verified (ServiceNow, Apache-2.0) on the wav-core env: the
// shopping, shopping_admin, reddit and gitlab containers at a pinned image
// tag. One site table drives the VM's startup script, the tunnel ports and
// check(). The agent sees each site on its own port through the recording
// proxy; the proxy forwards to the tunnel on that port plus TUNNEL_OFFSET.
import { request } from "node:http";
import type { Benchmark, BenchContext, Readiness } from "../types.js";

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
}

// Ports and health pages as upstream's environments/container/config.py.
export const wavSites: WavSite[] = [
  { id: "shopping", port: 7770, ctrlPort: 7771, containerPort: 80, health: "/customer/account/login" },
  { id: "shopping_admin", port: 7780, ctrlPort: 7781, containerPort: 80, health: "/" },
  { id: "reddit", port: 9999, ctrlPort: 9998, containerPort: 80, health: "/login" },
  { id: "gitlab", port: 8023, ctrlPort: 8024, containerPort: 8023, health: "/users/sign_in" },
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

/** One GET with no connection pool, so a dead tunnel never hands back a stale socket. */
function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, timeout: PROBE_MS }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`no answer in ${PROBE_MS / 1000} s`)));
    req.on("error", reject);
    req.end();
  });
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
    const urls = wavUrls(ctx.env, options.offset);
    const down = (await Promise.all(urls.map(async (u) => ({ id: u.site.id, why: await probe(u.url, u.ctrl, u.site.health) })))).filter((d) => d.why);
    if (!down.length) return { ready: true };
    return { ready: false, reason: down.map((d) => `${d.id}: ${d.why}`).join("; "),
      fix: "foxbench env up wav-core (GitLab takes minutes to boot), or set FOXBENCH_WAV_HOST to a host that runs the wav-core containers" };
  },
  // The task list comes with #128; until then there is nothing to run.
  load: async () => [],
  up: async (ctx) => ({ sites: wavUrls(ctx.env, options.offset) }),
  start: async () => { throw new Error("webarena-verified has no tasks yet"); },
  judge: async () => { throw new Error("webarena-verified has no tasks yet"); },
  // The VM stops only through foxbench env down.
  down: async () => {},
  baselines: [],
});
