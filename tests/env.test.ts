// Tests for the foxbench env failure modes in docs/failure-modes.md (V1-V17).
// They run the built CLI against a fake gcloud that records its argv.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
let home = "";
// The smoke env tunnels to 127.0.0.1:18080. Another checkout's tests, or any
// other process, can hold that port, so every `up` here shifts it by an offset
// that lands the tunnel on a port the OS just gave away.
let port = 18080;
let offset = 0;
afterEach(() => {
  // Close any tunnel a test left up.
  if (existsSync(join(home, ".foxbench/env/smoke.json"))) env("down", "smoke");
});

function env(...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, "dist/cli.js"), "env", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: home, FOXBENCH_GCLOUD: join(root, "tests/fixtures/fake-gcloud.mjs"), FAKE_GCLOUD_LOG: join(home, "calls.jsonl"),
      FOXBENCH_GCP_PROJECT: "test-project", FOXBENCH_GCP_ZONE: "test-zone-a", FOXBENCH_GCP_ACCOUNT: "tester@example.com", ...extra },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
let extra: Record<string, string> = {};
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port: free } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return free;
}
async function fresh(more: Record<string, string> = {}) {
  home = mkdtempSync(join(tmpdir(), "fbn-env-"));
  extra = more;
  port = await freePort();
  offset = port - 18080;
}
const up = (...args: string[]) => env("up", "smoke", "--local-port-offset", String(offset), ...args);
function calls(): { argv: string[]; script?: string }[] {
  const file = join(home, "calls.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}
const create = () => calls().find((c) => c.argv.includes("create"))!.argv;
function listing(vms: { name: string; env?: string }[]) {
  const file = join(home, "list.json");
  writeFileSync(file, JSON.stringify(vms.map((v) => ({ name: v.name, status: "RUNNING", zone: "https://compute/zones/test-zone-a", labels: v.env ? { "foxbench-env": v.env } : {} }))));
  extra.FAKE_GCLOUD_LIST = file;
}

describe("V1 a forgotten VM", () => {
  it("gets a max run duration that deletes it, and no public IP", async () => {
    await fresh();
    expect(up().status).toBe(0);
    expect(create()).toEqual(expect.arrayContaining(["--max-run-duration=4h", "--instance-termination-action=DELETE", "--no-address"]));
  });
  it("takes another duration", async () => {
    await fresh();
    expect(up("--max-run-duration", "90m").status).toBe(0);
    expect(create()).toContain("--max-run-duration=90m");
  });
});

describe("V2 every VM is labelled", () => {
  it("passes foxbench-env=<env>", async () => {
    await fresh();
    up();
    expect(create()).toContain("--labels=foxbench-env=smoke");
  });
});

describe("V3 down deletes only this env's VMs", () => {
  it("filters by label and skips VMs with another label", async () => {
    await fresh();
    listing([{ name: "vm-smoke" }, { name: "vm-wav", env: "wav-core" }, { name: "vm-mine", env: "smoke" }]);
    const r = env("down", "smoke");
    expect(r.status).toBe(0);
    const list = calls().find((c) => c.argv.includes("list"))!.argv;
    expect(list).toContain("--filter=labels.foxbench-env=smoke");
    const deletes = calls().filter((c) => c.argv.includes("delete")).map((c) => c.argv);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toEqual(expect.arrayContaining(["vm-mine", "--zone=test-zone-a", "--quiet"]));
  });
});

describe("V4 Spot by default", () => {
  it("is Spot unless --no-spot", async () => {
    await fresh();
    up();
    expect(create()).toContain("--provisioning-model=SPOT");
    env("down", "smoke");
    await fresh();
    up("--no-spot");
    expect(create()).toContain("--provisioning-model=STANDARD");
  });
});

describe("V6 the startup script", () => {
  it("is the env's own script", async () => {
    await fresh();
    up();
    expect(calls().find((c) => c.argv.includes("create"))!.script).toContain("http.server 8080");
  });
  it("an unknown env stops before gcloud", async () => {
    await fresh();
    const r = env("up", "nope");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("smoke");
    expect(calls()).toHaveLength(0);
  });
});

describe("V7 a failed gcloud call", () => {
  it("stops with gcloud's stderr and writes no state", async () => {
    await fresh({ FAKE_GCLOUD_FAIL: "create" });
    const r = up();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Quota 'SPOT_CPUS' exceeded");
    expect(existsSync(join(home, ".foxbench/env/smoke.json"))).toBe(false);
    expect(calls().some((c) => c.argv.includes("start-iap-tunnel"))).toBe(false);
  });
});

describe("V8 project, zone and account from the environment", () => {
  it("passes them to every call", async () => {
    await fresh();
    up();
    for (const c of calls()) expect(c.argv).toEqual(expect.arrayContaining(["--project=test-project", "--account=tester@example.com"]));
    expect(create()).toContain("--zone=test-zone-a");
  });
  it("stops without a project", async () => {
    await fresh({ FOXBENCH_GCP_PROJECT: "" });
    const r = up();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("FOXBENCH_GCP_PROJECT");
    expect(calls()).toHaveLength(0);
  });
});

describe("V9 the tunnel and the state file", () => {
  it("up writes state with a live tunnel, down kills it and removes the state", async () => {
    await fresh();
    expect(up().stdout).toContain(`http://127.0.0.1:${port}`);
    const tunnel = calls().find((c) => c.argv.includes("start-iap-tunnel"))!.argv;
    expect(tunnel).toEqual(expect.arrayContaining(["8080", `--local-host-port=127.0.0.1:${port}`]));
    const stateFile = join(home, ".foxbench/env/smoke.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const pid = state.tunnels[0].pid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(env("status", "smoke").stdout).toMatch(new RegExp(`tunnel smoke 127\\.0\\.0\\.1:${port} -> \\S+:8080 up`));
    listing([{ name: state.vm, env: "smoke" }]);
    expect(up().status).toBe(1);
    expect(env("down", "smoke").status).toBe(0);
    await expect.poll(() => { try { return process.kill(pid, 0); } catch { return false; } }).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe("V10 status with no VMs", () => {
  it("prints none", async () => {
    await fresh();
    const r = env("status");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("none");
  });
});

describe("V11 a taken local port", () => {
  it("stops before it makes a VM", async () => {
    await fresh();
    const server = createServer();
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    try {
      const r = up();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(String(port));
      expect(calls()).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});

describe("V14 no two envs share a local port", () => {
  it("gives each local port to one env", async () => {
    const { cloudEnvs } = await import("../src/env/envs.js");
    const owner = new Map<number, string>();
    const clashes: string[] = [];
    for (const cloud of cloudEnvs) for (const { local } of cloud.ports) {
      const other = owner.get(local);
      if (other && other !== cloud.name) clashes.push(`${local}: ${other} and ${cloud.name}`);
      owner.set(local, cloud.name);
    }
    expect(clashes).toEqual([]);
  });
});

// A killed child of this test process stays a zombie until reaped, and kill(pid, 0) still finds it.
const dead = (pid: number) => { const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(); return !stat || stat.startsWith("Z"); };
const stateFile = () => join(home, ".foxbench/env/smoke.json");
function writeState(tunnels: { remote: number; local: number; pid: number; log: string }[]) {
  mkdirSync(join(home, ".foxbench/env"), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ env: "smoke", vm: "foxbench-smoke-old", zone: "test-zone-a", tunnels }));
}
/** A tunnel an earlier `up` left behind: the fake gcloud, in its own process group, bound to `local`. */
async function orphanTunnel(local: number, tunnelEnv: Record<string, string> = {}): Promise<number> {
  const child = spawn(process.execPath, [join(root, "tests/fixtures/fake-gcloud.mjs"), "compute", "start-iap-tunnel", "foxbench-smoke-old", "8080", `--local-host-port=127.0.0.1:${local}`],
    { detached: true, stdio: "ignore", env: { ...process.env, FAKE_GCLOUD_LOG: join(home, "orphans.jsonl"), ...tunnelEnv } });
  child.unref();
  await expect.poll(async () => { try { await new Promise<void>((ok, no) => { const s = createServer(); s.once("error", no); s.listen(local, "127.0.0.1", () => s.close(() => ok())); }); return false; } catch { return true; } }, { timeout: 15_000 }).toBe(true);
  return child.pid!;
}

describe("V15 a preempted VM leaves its tunnels", () => {
  it("down stops the state's tunnels when no VM exists", async () => {
    await fresh();
    const pid = await orphanTunnel(port);
    writeState([{ remote: 8080, local: port, pid, log: join(home, "t.log") }]);
    const r = env("down", "smoke");
    expect(r.status).toBe(0);
    await expect.poll(() => dead(pid), { timeout: 15_000 }).toBe(true);
    expect(existsSync(stateFile())).toBe(false);
  });
  it("an up that died while its tunnel was still opening left its pid in the state", async () => {
    await fresh({ FAKE_GCLOUD_NOBIND: "1" });
    const child = spawn(process.execPath, [join(root, "dist/cli.js"), "env", "up", "smoke", "--local-port-offset", String(offset)],
      { stdio: "ignore", env: { ...process.env, HOME: home, FOXBENCH_GCLOUD: join(root, "tests/fixtures/fake-gcloud.mjs"), FAKE_GCLOUD_LOG: join(home, "calls.jsonl"),
        FOXBENCH_GCP_PROJECT: "test-project", FOXBENCH_GCP_ZONE: "test-zone-a", FAKE_GCLOUD_NOBIND: "1" } });
    await expect.poll(() => existsSync(stateFile()) && JSON.parse(readFileSync(stateFile(), "utf8")).tunnels.length, { timeout: 15_000 }).toBe(1);
    const pid = JSON.parse(readFileSync(stateFile(), "utf8")).tunnels[0].pid;
    child.kill("SIGKILL");
    expect(dead(pid)).toBe(false);
    expect(env("down", "smoke").status).toBe(0);
    await expect.poll(() => dead(pid), { timeout: 15_000 }).toBe(true);
  });
});

describe("V16 up after a preempted VM", () => {
  it("stops its own env's old tunnels, then opens new ones", async () => {
    await fresh();
    const pid = await orphanTunnel(port);
    writeState([{ remote: 8080, local: port, pid, log: join(home, "t.log") }]);
    const r = up();
    expect(r.status).toBe(0);
    expect(dead(pid)).toBe(true);
    expect(JSON.parse(readFileSync(stateFile(), "utf8")).tunnels[0].pid).not.toBe(pid);
  });
  it("V18 waits for a stopped tunnel to free its port", async () => {
    await fresh();
    const pid = await orphanTunnel(port, { FAKE_GCLOUD_SLOWSTOP: "1500" });
    writeState([{ remote: 8080, local: port, pid, log: join(home, "t.log") }]);
    const r = up();
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(readFileSync(stateFile(), "utf8")).tunnels[0].pid).not.toBe(pid);
  });
  it("still stops when a VM of the env exists", async () => {
    await fresh();
    listing([{ name: "foxbench-smoke-old", env: "smoke" }]);
    const pid = await orphanTunnel(port);
    writeState([{ remote: 8080, local: port, pid, log: join(home, "t.log") }]);
    expect(up().status).toBe(1);
    expect(dead(pid)).toBe(false);
    process.kill(-pid);
  });
});

describe("V17 only tunnels are stopped", () => {
  it("leaves a pid that is not a tunnel", async () => {
    await fresh();
    const other = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    other.unref();
    try {
      writeState([{ remote: 8080, local: port, pid: other.pid!, log: join(home, "t.log") }]);
      expect(env("down", "smoke").status).toBe(0);
      expect(dead(other.pid!)).toBe(false);
    } finally {
      process.kill(-other.pid!);
    }
  });
  it("a port held by another program stops up and keeps the program", async () => {
    await fresh();
    const server = createServer();
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    try {
      writeState([]);
      const r = up();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`Local port ${port} is in use`);
      expect(calls().some((c) => c.argv.includes("create"))).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      server.close();
    }
  });
});
