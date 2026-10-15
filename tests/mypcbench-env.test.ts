// Tests for the mypcbench env failure modes in docs/failure-modes.md (MP1-MP8).
// The CLI runs against the fake gcloud; the reset service runs for real
// (python3) against a fake docker, a fake control API and fake apps.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as tcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MYPCBENCH_IMAGE, MYPCBENCH_RESET_SERVICE, RESET_PORT, mypcApps, mypcbenchUrls, probeVm, resetVm, sessionHeaders, sessionToken } from "../src/bench/mypcbench/env.js";
import { cloudEnvs } from "../src/env/envs.js";

const root = join(import.meta.dirname, "..");
const env = cloudEnvs.find((e) => e.name === "mypcbench")!;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

function cli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(root, "dist/cli.js"), "env", ...args], { encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: home, FOXBENCH_GCLOUD: join(root, "tests/fixtures/fake-gcloud.mjs"), FAKE_GCLOUD_LOG: join(home, "calls.jsonl"),
      FOXBENCH_GCP_PROJECT: "test-project", FOXBENCH_GCP_ZONE: "test-zone-a" } });
}
const isFree = (port: number) => new Promise<boolean>((r) => { const s = tcp(); s.once("error", () => r(false)); s.listen(port, "127.0.0.1", () => s.close(() => r(true))); });

/** An offset that puts all of an env's tunnel ports on free local ports; other checkouts' tests can hold any of them. */
async function freeOffset(ports: number[]): Promise<number> {
  for (let tries = 0; tries < 50; tries++) {
    const offset = 20000 + Math.floor(Math.random() * 30000);
    if ((await Promise.all(ports.map((p) => isFree(p + offset)))).every(Boolean)) return offset;
  }
  throw new Error("no free local port range for the tunnels");
}
/** The create call of `foxbench env up <name>` and the startup script it sent. */
async function up(name: string) {
  const home = mkdtempSync(join(tmpdir(), "fbn-mypc-"));
  const offset = await freeOffset(cloudEnvs.find((e) => e.name === name)!.ports.map((p) => p.local));
  const r = cli(home, "up", name, "--local-port-offset", String(offset));
  cleanup.push(() => cli(home, "down", name));
  expect(r.status, r.stderr).toBe(0);
  const calls = readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; script?: string });
  return calls.find((c) => c.argv.includes("create"))!;
}

describe("MP1 the image is pinned", () => {
  it("runs the image by digest and never by tag", () => {
    expect(MYPCBENCH_IMAGE).toMatch(/^ljang\/mypcbench-qemu@sha256:[0-9a-f]{64}$/);
    expect(env.startup).toContain(`docker pull -q ${MYPCBENCH_IMAGE}`);
    expect(env.startup.match(/ljang\/mypcbench-qemu\S*/g)!.every((i) => i === MYPCBENCH_IMAGE)).toBe(true);
    expect(env.startup).not.toMatch(/latest/);
  });
});

describe("MP2 nested virtualization", () => {
  it("is asked for by mypcbench and by no other env", async () => {
    expect(cloudEnvs.filter((e) => e.nestedVirt).map((e) => e.name)).toEqual(["mypcbench"]);
    const call = await up("mypcbench");
    expect(call.argv).toContain("--enable-nested-virtualization");
    expect(call.argv).toContain("--machine-type=n2-standard-8");
    expect(call.argv).toContain("--labels=foxbench-env=mypcbench");
    expect(call.script).toBe(env.startup);
    expect((await up("smoke")).argv).not.toContain("--enable-nested-virtualization");
  });
});

describe("MP3 no /dev/kvm", () => {
  it("is valid shell that checks /dev/kvm before it installs or pulls anything", () => {
    expect(spawnSync("sh", ["-n"], { input: env.startup }).status).toBe(0);
    const kvm = env.startup.indexOf("/dev/kvm");
    expect(kvm).toBeGreaterThan(0);
    expect(kvm).toBeLessThan(env.startup.indexOf("apt-get"));
    expect(kvm).toBeLessThan(env.startup.indexOf("docker pull"));
    expect(env.startup).toContain("exit 1");
  });
});

describe("MP4 one app table", () => {
  it("has 17 apps on 3001-3017, tunnelled with the reset port and mapped in the startup script", () => {
    expect(mypcApps.map((a) => a.port)).toEqual(Array.from({ length: 17 }, (_, i) => 3001 + i));
    expect(new Set(mypcApps.map((a) => a.id)).size).toBe(17);
    expect(env.ports).toEqual([...mypcApps.map((a) => ({ remote: a.port, local: a.port + 10000 })), { remote: RESET_PORT, local: RESET_PORT + 10000 }]);
    expect(env.startup).toContain("-p 3001-3018:3001-3018");
    expect(env.startup).toContain("--privileged --device /dev/kvm");
    // The control API is not tunnelled: only the reset service on the VM reaches it.
    expect(env.startup).toContain("-p 127.0.0.1:5000:5000");
    expect(env.ports.map((p) => p.remote)).not.toContain(5000);
    expect(mypcbenchUrls({}).apps[16]!.url).toBe("http://127.0.0.1:13017");
    expect(mypcbenchUrls({ MYPCBENCH_HOST: "10.0.0.5" }).reset).toBe(`http://10.0.0.5:${RESET_PORT + 10000}`);
  });
});

describe("MP5 the session cookie", () => {
  it("is the one upstream's Python builds", () => {
    // From upstream's _warmup_one_app run in Python 3: hmac-sha256 over json.dumps, key mypcbench-session-2026.
    expect(sessionToken("vaultbank")).toBe("eyJlbWFpbCI6ICJtaWNoYWVsLnNjb3R0QGR1bmRlcm1pZmZsaW4uY29tIiwgImFwcCI6ICJ2YXVsdGJhbmsifS4xNDE5Yjc4Y2UyODAxNTA2ODVhNjhkMjRmOTBmZGMyMjVjNTY0MDY0MmE0MWUyZmI2ZjZiNGRiMDI0NGUwZWQ4");
    expect(sessionHeaders(mypcApps[3]!).cookie).toMatch(/^session_buzzchat=/);
    expect(sessionToken("mail")).not.toBe(sessionToken("buzzchat"));
  });
});

/** Runs the reset service for real on a free port, with a fake docker and a control API that is healthy only after a restart. */
async function service(opts: { apps?: "ok" | "down"; healthy?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fbn-mypc-svc-"));
  const dockerLog = join(dir, "docker.log");
  writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" >> ${dockerLog}\n`);
  chmodSync(join(dir, "docker"), 0o755);
  writeFileSync(join(dir, "svc.py"), MYPCBENCH_RESET_SERVICE);
  const servers: Server[] = [];
  const listen = (s: Server) => new Promise<number>((r) => { servers.push(s); s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)); });
  const seen: { app: string; cookie: string }[] = [];
  const control = await listen(createServer((req, res) => { res.statusCode = opts.healthy === false || !existsSync(dockerLog) ? 503 : 200; res.end(); }));
  // One fake app server for all 17: the service's URL template maps each app port to it.
  const apps = await listen(createServer((req, res) => {
    seen.push({ app: req.url ?? "", cookie: String(req.headers.cookie) });
    res.statusCode = opts.apps === "down" ? 500 : 200;
    res.end();
  }));
  const free = await listen(createServer());
  await new Promise((r) => servers.pop()!.close(r));
  const child: ChildProcess = spawn("python3", ["-I", join(dir, "svc.py")], { stdio: "ignore",
    env: { PATH: `${dir}:${process.env.PATH}`, MYPCBENCH_CONTROL_URL: `http://127.0.0.1:${control}`, MYPCBENCH_APP_URL: `http://127.0.0.1:${apps}/{port}`,
      MYPCBENCH_RESET_PORT: String(free), MYPCBENCH_RESET_WAIT_S: "4" } });
  cleanup.push(() => { child.kill(); servers.forEach((s) => { s.closeAllConnections(); s.close(); }); });
  const url = `http://127.0.0.1:${free}`;
  for (let i = 0; i < 50 && (await probeVm(url, 1000)) === "connect ECONNREFUSED 127.0.0.1:" + free; i++) await new Promise((r) => setTimeout(r, 100));
  return { url, dockerLog, seen };
}

describe("MP6 the reset service", () => {
  it("restarts the container and answers 200 once the control API and every app answer", async () => {
    const svc = await service();
    expect(await probeVm(svc.url)).toContain("503");
    await resetVm(svc.url, 30_000);
    expect(readFileSync(svc.dockerLog, "utf8").trim()).toBe("restart mypcbench");
    expect(await probeVm(svc.url)).toBeNull();
    // Each app was asked on its own port path with its own session cookie.
    const asked = svc.seen.filter((s) => s.app.startsWith("/30"));
    expect(new Set(asked.map((s) => s.app.split("/")[1])).size).toBe(17);
    expect(asked.find((s) => s.app.startsWith("/3016/"))!.cookie).toBe(sessionHeaders(mypcApps[15]!).cookie);
  }, 40_000);
  it("answers 500 with the reason when an app never comes up", async () => {
    const svc = await service({ apps: "down" });
    await expect(resetVm(svc.url, 30_000)).rejects.toThrow(/returned 500.*vaultbank did not answer/);
  }, 40_000);
  it("answers 500 when the control API stays down", async () => {
    const svc = await service({ healthy: false });
    await expect(resetVm(svc.url, 30_000)).rejects.toThrow(/returned 500.*control API is not healthy/);
  }, 40_000);
});

describe("MP7 the VM size", () => {
  it("is n2-standard-8 with a 60 GB disk", () => {
    expect(env.machineType).toBe("n2-standard-8");
    expect(env.diskGb).toBe(60);
  });
});

describe("MP8 a reset on a dead tunnel", () => {
  it("times out and names the URL", async () => {
    const hang = createServer(() => {});
    const port = await new Promise<number>((r) => hang.listen(0, "127.0.0.1", () => r((hang.address() as { port: number }).port)));
    cleanup.push(() => { hang.closeAllConnections(); hang.close(); });
    const started = Date.now();
    await expect(resetVm(`http://127.0.0.1:${port}`, 500)).rejects.toThrow(`http://127.0.0.1:${port}/reset did not answer`);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
