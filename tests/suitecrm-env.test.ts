// Tests for the suitecrm env failure modes in docs/failure-modes.md (SE1-SE8).
// The startup script and the reset service run for real, with fake `docker`,
// `curl` and `systemctl` programs first on PATH that record what they were asked.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloudEnvs } from "../src/env/envs.js";

const env = cloudEnvs.find((e) => e.name === "suitecrm")!;

/** A directory of fake programs. `docker exec ... select count` answers 0 until the file `ready` exists. */
function fakes() {
  const dir = mkdtempSync(join(tmpdir(), "fbn-suitecrm-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const program = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // docker inspect succeeds only for a name in $dir/exists; `exec -i` logs the stdin it was given.
  program("docker", `echo "docker $*" >> ${log}
case "$1" in
  inspect|network) [ "$1" = network ] && [ "$2" = inspect ] && exit 1; grep -qx "$2" ${dir}/exists 2>/dev/null ;;
  run) echo "$*" | sed -n 's/.*--name \\([^ ]*\\).*/\\1/p' >> ${dir}/exists ;;
  exec) case "$*" in
    *"count(*)"*) n=$(cat ${dir}/polls 2>/dev/null || echo 0); echo $((n+1)) > ${dir}/polls; [ "$n" -ge 2 ] && echo 10 || echo 0 ;;
    *) if [ "$2" = -i ]; then echo "stdin: $(head -c 40)" >> ${log}; fi ;;
  esac ;;
esac
exit 0`);
  program("curl", `echo "curl $*" >> ${log}
while [ $# -gt 0 ]; do [ "$1" = -o ] && echo "-- seed --" > "$2"; shift; done
exit 0`);
  program("systemctl", `echo "systemctl $*" >> ${log}; [ "$1" = is-active ] && exit 1; exit 0`);
  program("systemd-run", `echo "systemd-run $*" >> ${log}`);
  program("sleep", "exit 0");
  return { dir, bin, log, lines: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

function boot(f: ReturnType<typeof fakes>) {
  const state = join(f.dir, "state");
  const r = spawnSync("sh", ["-c", env.startup], { encoding: "utf8", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FOXBENCH_DIR: state } });
  return { status: r.status, stderr: r.stderr, state };
}

describe("SE1 pinned images", () => {
  it("runs the legacy 8.8.1 and 11.4.7 tags and never latest or upstream's dead registry", () => {
    expect(env.startup).toContain("docker.io/bitnamilegacy/suitecrm:8.8.1");
    expect(env.startup).toContain("docker.io/bitnamilegacy/mariadb:11.4.7");
    expect(env.startup).not.toMatch(/latest|public\.ecr\.aws/);
  });
});

describe("SE2 the site URL is the proxy's", () => {
  it("starts SuiteCRM for http://127.0.0.1:8080 and tunnels another local port", () => {
    expect(env.startup).toContain("SUITECRM_HOST=127.0.0.1");
    expect(env.startup).toContain("SUITECRM_EXTERNAL_HTTP_PORT_NUMBER=8080");
    expect(env.ports.map((p) => p.local)).not.toContain(8080);
  });
});

describe("SE3 the seed is fetched at a pinned commit", () => {
  it("downloads demo_data.sql from upstream at a 40-hex commit, and the repo has no copy", () => {
    expect(env.startup).toMatch(/raw\.githubusercontent\.com\/segev-shlomov\/ST-WebAgentBench\/[0-9a-f]{40}\/suitecrm_setup\/init-db\/demo_data\.sql/);
    const tracked = spawnSync("git", ["ls-files", "*demo_data*"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }).stdout;
    expect(tracked.trim()).toBe("");
  });
});

describe("SE4 the seed loads once, after SuiteCRM has its tables", () => {
  it("waits for the users table, loads the seed, dumps it, and a reboot loads nothing", () => {
    const f = fakes();
    const first = boot(f);
    expect(first.status, first.stderr).toBe(0);
    const calls = f.lines();
    const polls = calls.filter((l) => l.includes("count(*)")).length;
    const load = calls.findIndex((l) => l.startsWith("stdin: -- seed --"));
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(load).toBeGreaterThan(calls.findLastIndex((l) => l.includes("count(*)")));
    expect(calls.some((l) => l.startsWith("docker exec") && l.includes("mysqldump"))).toBe(true);
    expect(existsSync(join(first.state, "seed.sql"))).toBe(true);
    const before = f.lines().length;
    expect(boot(f).status).toBe(0);
    const again = f.lines().slice(before);
    expect(again.some((l) => l.startsWith("curl") || l.startsWith("stdin:") || l.includes("mysqldump"))).toBe(false);
    expect(again.filter((l) => l.startsWith("docker start")).length).toBe(2);
    expect(again.some((l) => l.startsWith("docker run"))).toBe(false);
  });
});

/** The reset service on a free port, with a fake docker; returns a fetch and a stop. */
async function service(fail = false) {
  const f = fakes();
  const seed = join(f.dir, "seed.sql");
  writeFileSync(seed, "-- seed --");
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  writeFileSync(join(f.dir, "reset.py"), (await import("../src/bench/suitecrm/index.js")).suitecrmResetService(seed, port));
  writeFileSync(join(f.bin, "docker"), `#!/bin/sh\necho "docker $*" >> ${f.log}\ncat > /dev/null\n${fail ? "echo boom >&2; exit 1" : "exit 0"}\n`, { mode: 0o755 });
  const child = spawn("python3", [join(f.dir, "reset.py")], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(url, { method: "HEAD" }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { f, url, stop: () => child.kill() };
}

describe("SE5 reset restores the seeded database", () => {
  it("POST /reset pipes the dump into mysql in the db container", async () => {
    const s = await service();
    try {
      expect((await fetch(`${s.url}/reset`, { method: "POST" })).status).toBe(200);
      expect(s.f.lines()).toEqual(["docker exec -i suitecrm-db mysql -u root bitnami_suitecrm"]);
    } finally { s.stop(); }
  });
  it("answers 500 with the reason when the restore fails", async () => {
    const s = await service(true);
    try { expect((await fetch(`${s.url}/reset`, { method: "POST" })).status).toBe(500); } finally { s.stop(); }
  });
});

describe("SE6 one port table", () => {
  it("tunnels SuiteCRM and the reset service, and maps them in the startup script", () => {
    expect(env.ports).toEqual([{ remote: 8080, local: 18081 }, { remote: 8873, local: 18873 }]);
    expect(env.startup).toContain("-p 8080:8080");
    expect(env.startup).toContain('("0.0.0.0", 8873)');
  });
});

describe("SE7 the VM size", () => {
  it("is e2-standard-4 with a 30 GB disk", () => {
    expect(env.machineType).toBe("e2-standard-4");
    expect(env.diskGb).toBe(30);
  });
});

describe("SE8 the reset service is narrow", () => {
  it("resets only on POST /reset", async () => {
    const s = await service();
    try {
      expect((await fetch(`${s.url}/reset`)).status).toBe(405);
      expect((await fetch(`${s.url}/other`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${s.url}/reset`, { method: "DELETE" })).status).toBe(405);
      expect(s.f.lines()).toEqual([]);
    } finally { s.stop(); }
  });
});

describe("SE9 no two envs share a local port", () => {
  it("opens each tunnel on its own local port", () => {
    const locals = cloudEnvs.flatMap((e) => e.ports.map((p) => p.local));
    expect(new Set(locals).size).toBe(locals.length);
  });
});
