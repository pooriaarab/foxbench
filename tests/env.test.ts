// Tests for the foxbench env failure modes in docs/failure-modes.md (V1-V11).
// They run the built CLI against a fake gcloud that records its argv.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
let home = "";
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
function fresh(more: Record<string, string> = {}) {
  home = mkdtempSync(join(tmpdir(), "fbn-env-"));
  extra = more;
}
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
  it("gets a max run duration that deletes it, and no public IP", () => {
    fresh();
    expect(env("up", "smoke").status).toBe(0);
    expect(create()).toEqual(expect.arrayContaining(["--max-run-duration=4h", "--instance-termination-action=DELETE", "--no-address"]));
  });
  it("takes another duration", () => {
    fresh();
    expect(env("up", "smoke", "--max-run-duration", "90m").status).toBe(0);
    expect(create()).toContain("--max-run-duration=90m");
  });
});

describe("V2 every VM is labelled", () => {
  it("passes foxbench-env=<env>", () => {
    fresh();
    env("up", "smoke");
    expect(create()).toContain("--labels=foxbench-env=smoke");
  });
});

describe("V3 down deletes only this env's VMs", () => {
  it("filters by label and skips VMs with another label", () => {
    fresh();
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
  it("is Spot unless --no-spot", () => {
    fresh();
    env("up", "smoke");
    expect(create()).toContain("--provisioning-model=SPOT");
    env("down", "smoke");
    fresh();
    env("up", "smoke", "--no-spot");
    expect(create()).toContain("--provisioning-model=STANDARD");
  });
});

describe("V6 the startup script", () => {
  it("is the env's own script", () => {
    fresh();
    env("up", "smoke");
    expect(calls().find((c) => c.argv.includes("create"))!.script).toContain("http.server 8080");
  });
  it("an unknown env stops before gcloud", () => {
    fresh();
    const r = env("up", "nope");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("smoke");
    expect(calls()).toHaveLength(0);
  });
});

describe("V7 a failed gcloud call", () => {
  it("stops with gcloud's stderr and writes no state", () => {
    fresh({ FAKE_GCLOUD_FAIL: "create" });
    const r = env("up", "smoke");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Quota 'SPOT_CPUS' exceeded");
    expect(existsSync(join(home, ".foxbench/env/smoke.json"))).toBe(false);
    expect(calls().some((c) => c.argv.includes("start-iap-tunnel"))).toBe(false);
  });
});

describe("V8 project, zone and account from the environment", () => {
  it("passes them to every call", () => {
    fresh();
    env("up", "smoke");
    for (const c of calls()) expect(c.argv).toEqual(expect.arrayContaining(["--project=test-project", "--account=tester@example.com"]));
    expect(create()).toContain("--zone=test-zone-a");
  });
  it("stops without a project", () => {
    fresh({ FOXBENCH_GCP_PROJECT: "" });
    const r = env("up", "smoke");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("FOXBENCH_GCP_PROJECT");
    expect(calls()).toHaveLength(0);
  });
});

describe("V9 the tunnel and the state file", () => {
  it("up writes state with a live tunnel, down kills it and removes the state", () => {
    fresh();
    expect(env("up", "smoke").stdout).toContain("http://127.0.0.1:18080");
    const tunnel = calls().find((c) => c.argv.includes("start-iap-tunnel"))!.argv;
    expect(tunnel).toEqual(expect.arrayContaining(["8080", "--local-host-port=127.0.0.1:18080"]));
    const stateFile = join(home, ".foxbench/env/smoke.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const pid = state.tunnels[0].pid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(env("status", "smoke").stdout).toMatch(/tunnel smoke 127\.0\.0\.1:18080 -> \S+:8080 up/);
    expect(env("up", "smoke").status).toBe(1);
    expect(env("down", "smoke").status).toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe("V10 status with no VMs", () => {
  it("prints none", () => {
    fresh();
    const r = env("status");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("none");
  });
});

describe("V11 a taken local port", () => {
  it("stops before it makes a VM", async () => {
    fresh();
    const server = createServer();
    await new Promise<void>((done) => server.listen(18080, "127.0.0.1", done));
    try {
      const r = env("up", "smoke");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("18080");
      expect(calls()).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});
