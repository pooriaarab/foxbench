// Tests for the wav-core failure modes in docs/failure-modes.md (WV1-WV8). The
// env is read from the registry; check() runs against fake env-ctrl servers
// and fake sites on the tunnel ports, moved by an offset so a local Docker
// run of the real containers does not clash.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { benchContext, benchmarkById } from "../src/bench/registry.js";
import { webarenaVerified, wavSites } from "../src/bench/wav/index.js";
import { cloudEnvs } from "../src/env/envs.js";

const env = cloudEnvs.find((e) => e.name === "wav-core")!;
const OFFSET = 30000;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

type Mode = "ok" | "unhealthy" | "hang" | "down";
/** Fake containers on host:port+OFFSET: env-ctrl answers /status, the site answers its health path. */
async function fake(host: string, modes: Partial<Record<string, Mode>> = {}) {
  for (const site of wavSites) {
    const mode = modes[site.id] ?? "ok";
    if (mode === "down") continue;
    const ctrl = createServer((req, res) => {
      if (mode === "hang") return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/status" ? { success: mode === "ok", message: mode === "ok" ? "" : "mysqld is down" } : { success: false }));
    });
    const page = createServer((req, res) => {
      if (mode === "hang") return;
      res.statusCode = req.url === site.health ? 200 : 404;
      res.end("<title>site</title>");
    });
    for (const [server, port] of [[ctrl, site.ctrlPort], [page, site.port]] as const) {
      servers.push(server);
      await new Promise<void>((r) => server.listen(port + OFFSET, host, r));
    }
  }
}
const ctx = (vars: Record<string, string> = {}) => benchContext({ env: { ...vars } });

describe("WV1 pinned images", () => {
  it("runs each site's 0.1.0 image and never latest", () => {
    for (const site of ["shopping", "shopping_admin", "reddit", "gitlab"]) expect(env.startup).toContain(`am1n3e/webarena-verified-${site}:0.1.0`);
    expect(env.startup).not.toMatch(/latest/);
    expect(env.startup.match(/am1n3e\/webarena-verified-[a-z_]+(:\S+)?/g)!.every((i) => i.endsWith(":0.1.0"))).toBe(true);
  });
});

describe("WV2 the base URL is the proxy's", () => {
  it("starts each container with http://127.0.0.1:<site port> and tunnels another local port", () => {
    for (const site of wavSites) expect(env.startup).toContain(`WA_ENV_CTRL_EXTERNAL_SITE_URL=http://127.0.0.1:${site.port}`);
    for (const p of env.ports) expect(wavSites.map((s) => s.port)).not.toContain(p.local);
  });
});

describe("WV3 one site table", () => {
  it("tunnels each site and env-ctrl port, and maps it in the startup script", () => {
    expect(wavSites.map((s) => s.id)).toEqual(["shopping", "shopping_admin", "reddit", "gitlab"]);
    const want = wavSites.flatMap((s) => [{ remote: s.port, local: s.port + 10000 }, { remote: s.ctrlPort, local: s.ctrlPort + 10000 }]);
    expect(env.ports).toEqual(want);
    for (const s of wavSites) expect(env.startup).toContain(`-p ${s.port}:${s.containerPort} -p ${s.ctrlPort}:8877`);
  });
  it("is in the registry as webarena-verified, on a VM, under Apache-2.0", () => {
    const b = benchmarkById("webarena-verified")!;
    expect(b.where).toBe("vm");
    expect(b.licence).toMatchObject({ code: "Apache-2.0", mode: "fetch-at-run" });
  });
});

describe("WV4 a site that does not answer", () => {
  it("is not ready, with the site, the URL and the fix", async () => {
    await fake("127.0.0.1", { gitlab: "down" });
    const r = await webarenaVerified({ offset: OFFSET }).check(ctx());
    expect(r.ready).toBe(false);
    if (r.ready) return;
    expect(r.reason).toContain("gitlab");
    expect(r.reason).toContain(`http://127.0.0.1:${8024 + OFFSET}/status`);
    expect(r.reason).not.toContain("shopping");
    expect(r.fix).toContain("foxbench env up wav-core");
  });
  it("is ready when every site and env-ctrl answers", async () => {
    await fake("127.0.0.1");
    expect(await webarenaVerified({ offset: OFFSET }).check(ctx())).toEqual({ ready: true });
  });
});

describe("WV5 env-ctrl reports a service down", () => {
  it("makes that site not ready", async () => {
    await fake("127.0.0.1", { reddit: "unhealthy" });
    const r = await webarenaVerified({ offset: OFFSET }).check(ctx());
    expect(r).toMatchObject({ ready: false, reason: expect.stringContaining("reddit") });
    if (!r.ready) expect(r.reason).toContain("mysqld is down");
  });
});

describe("WV6 a probe that hangs", () => {
  it("times out and names the site", async () => {
    await fake("127.0.0.1", { shopping_admin: "hang" });
    const started = Date.now();
    const r = await webarenaVerified({ offset: OFFSET }).check(ctx());
    expect(Date.now() - started).toBeLessThan(13_000);
    expect(r).toMatchObject({ ready: false, reason: expect.stringContaining("shopping_admin") });
  }, 20_000);
});

describe("WV7 FOXBENCH_WAV_HOST", () => {
  it("probes the containers on that host", async () => {
    await fake("127.0.0.2");
    expect((await webarenaVerified({ offset: OFFSET }).check(ctx())).ready).toBe(false);
    expect(await webarenaVerified({ offset: OFFSET }).check(ctx({ FOXBENCH_WAV_HOST: "127.0.0.2" }))).toEqual({ ready: true });
  });
});

describe("WV8 the VM size", () => {
  it("is n2-standard-8 with a 200 GB disk", () => {
    expect(env.machineType).toBe("n2-standard-8");
    expect(env.diskGb).toBe(200);
  });
});
