// Tests for the vwa env failure modes in docs/failure-modes.md (VW1-VW9). The
// startup script and the reset service run for real, with fake `docker`,
// `curl`, `sha1sum` and `systemctl` programs first on PATH that record what they were asked.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as http, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vwaResetService } from "../src/bench/vwa/env.js";
import { cloudEnvs } from "../src/env/envs.js";

const env = cloudEnvs.find((e) => e.name === "vwa")!;
const UPSTREAM_TOKEN = "4b61655535e7ed388f0d40a93600254c";

/** A directory of fake programs. `docker inspect` succeeds only for names in $dir/exists; fake curl writes a real zip. */
function fakes(sha = "match") {
  const dir = mkdtempSync(join(tmpdir(), "fbn-vwa-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const program = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  program("docker", `echo "docker $*" >> ${log}
case "$1" in
  inspect) grep -qx "$2" ${dir}/exists 2>/dev/null; exit $? ;;
  network) [ "$2" = inspect ] && exit 1; exit 0 ;;
  run) echo "$*" | sed -n 's/.*--name \\([^ ]*\\).*/\\1/p' >> ${dir}/exists ;;
esac
exit 0`);
  program("curl", `echo "curl $*" >> ${log}
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then python3 -I -c 'import sys, zipfile
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("classifieds_docker_compose/docker-compose.yml", "services: {}")
z.writestr("classifieds_docker_compose/mysql/init_db.sh", "echo init")
z.writestr("classifieds_docker_compose/mysql/osclass_craigslist.sql", "-- data --")' "$2"; fi
  shift
done`);
  program("sha1sum", `echo "sha1sum $(cat)" >> ${log}; ${sha === "match" ? "exit 0" : 'echo "sha1sum: FAILED" >&2; exit 1'}`);
  program("systemctl", `echo "systemctl $*" >> ${log}; [ "$1" = is-active ] && exit 1; exit 0`);
  program("systemd-run", `echo "systemd-run $*" >> ${log}`);
  return { dir, bin, log, lines: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

function boot(f: ReturnType<typeof fakes>) {
  const state = join(f.dir, "state");
  const r = spawnSync("sh", ["-c", env.startup], { encoding: "utf8", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, FOXBENCH_DIR: state } });
  return { status: r.status, stderr: r.stderr, state };
}

describe("VW1 pinned images", () => {
  it("runs Classifieds and MySQL by digest, shopping and reddit at the wav-core tag, and never latest", () => {
    expect(env.startup).toMatch(/jykoh\/classifieds@sha256:[0-9a-f]{64}/);
    expect(env.startup).toMatch(/library\/mysql@sha256:[0-9a-f]{64}/);
    expect(env.startup).toContain("am1n3e/webarena-verified-shopping:0.1.0");
    expect(env.startup).toContain("am1n3e/webarena-verified-reddit:0.1.0");
    expect(env.startup).not.toMatch(/latest/);
  });
});

describe("VW2 the compose zip is fetched and checked, never committed", () => {
  it("checks the SHA-1 before it unpacks, and stops on a mismatch", () => {
    const f = fakes();
    const ok = boot(f);
    expect(ok.status, ok.stderr).toBe(0);
    expect(f.lines().some((l) => l.startsWith("sha1sum b351be6468feeeb0b9b261dfc0ad9e8c2966d718 "))).toBe(true);
    expect(readFileSync(join(ok.state, "classifieds-init", "osclass_craigslist.sql"), "utf8")).toBe("-- data --");
    const bad = fakes("mismatch");
    const r = boot(bad);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(r.state, "classifieds-init"))).toBe(false);
    expect(bad.lines().some((l) => l.startsWith("docker run") && l.includes("classifieds"))).toBe(false);
  });
  it("names archive.org, and the repo has no copy of the zip or its data", () => {
    expect(env.startup).toContain("https://archive.org/download/classifieds_docker_compose/classifieds_docker_compose.zip");
    const tracked = spawnSync("git", ["ls-files", "*classifieds*", "*osclass*"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }).stdout;
    expect(tracked.trim()).toBe("");
  });
});

describe("VW3 each site's URL is the proxy's", () => {
  it("tells each site http://127.0.0.1:<its port> and tunnels other local ports", () => {
    expect(env.startup).toContain("WA_ENV_CTRL_EXTERNAL_SITE_URL=http://127.0.0.1:7770");
    expect(env.startup).toContain("WA_ENV_CTRL_EXTERNAL_SITE_URL=http://127.0.0.1:9999");
    expect(env.startup).toContain("-e CLASSIFIEDS=http://127.0.0.1:9980/");
    for (const p of [7770, 9999, 9980]) expect(env.ports.map((x) => x.local)).not.toContain(p);
  });
});

describe("VW4 the reset token is the VM's own", () => {
  it("makes a root-only token once and gives it to the site, never upstream's", () => {
    const f = fakes();
    const first = boot(f);
    const file = join(first.state, "classifieds.token");
    const token = readFileSync(file, "utf8");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(f.lines().find((l) => l.startsWith("docker run") && l.includes("--name vwa-classifieds "))).toContain(`RESET_TOKEN=${token}`);
    expect(env.startup).not.toContain(UPSTREAM_TOKEN);
    boot(f);
    expect(readFileSync(file, "utf8")).toBe(token);
  });
});

/** A free local port. */
async function free(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}

/** The reset service on a free port, a fake docker, and a fake Classifieds that records its reset posts. */
async function service(o: { dockerFails?: boolean; classifiedsStatus?: number } = {}) {
  const f = fakes();
  const posts: string[] = [];
  const site: Server = http((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c; });
    req.on("end", () => { posts.push(`${req.method} ${req.url} ${body}`); res.writeHead(o.classifiedsStatus ?? 200).end(); });
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const sitePort = (site.address() as { port: number }).port;
  const port = await free();
  const script = join(f.dir, "reset.py");
  writeFileSync(script, vwaResetService(`http://127.0.0.1:${sitePort}`, port));
  writeFileSync(join(f.dir, "classifieds.token"), "tok123\n");
  writeFileSync(join(f.bin, "docker"), `#!/bin/sh\necho "docker $*" >> ${f.log}\n${o.dockerFails ? "echo boom >&2; exit 1" : "exit 0"}\n`, { mode: 0o755 });
  const child = spawn("python3", [script], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(url, { method: "HEAD" }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return { f, url, posts, stop: () => { child.kill(); site.close(); } };
}

describe("VW5 a reset restores a site", () => {
  it("recreates shopping and reddit from their images", async () => {
    const s = await service();
    try {
      expect((await fetch(`${s.url}/reset/shopping`, { method: "POST" })).status).toBe(200);
      expect((await fetch(`${s.url}/reset/reddit`, { method: "POST" })).status).toBe(200);
      const calls = s.f.lines();
      expect(calls).toContain("docker rm -f vwa-shopping");
      expect(calls.find((l) => l.startsWith("docker run") && l.includes("vwa-reddit"))).toContain("-p 9999:80 -p 9998:8877 -e WA_ENV_CTRL_EXTERNAL_SITE_URL=http://127.0.0.1:9999 am1n3e/webarena-verified-reddit:0.1.0");
    } finally { s.stop(); }
  });
  it("posts the token to Classifieds' own reset", async () => {
    const s = await service();
    try {
      expect((await fetch(`${s.url}/reset/classifieds`, { method: "POST" })).status).toBe(200);
      expect(s.posts).toEqual(["POST /index.php?page=reset token=tok123"]);
      expect(s.f.lines()).toEqual([]);
    } finally { s.stop(); }
  });
});

describe("VW6 the reset service is narrow", () => {
  it("resets only on POST /reset/<site> for a known site", async () => {
    const s = await service();
    try {
      expect((await fetch(`${s.url}/reset/shopping`)).status).toBe(405);
      expect((await fetch(`${s.url}/reset/reddit`, { method: "DELETE" })).status).toBe(405);
      expect((await fetch(`${s.url}/reset/gitlab`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${s.url}/reset`, { method: "POST" })).status).toBe(404);
      expect(s.f.lines()).toEqual([]);
      expect(s.posts).toEqual([]);
    } finally { s.stop(); }
  });
  it("answers 500 when a reset fails", async () => {
    const d = await service({ dockerFails: true });
    const c = await service({ classifiedsStatus: 403 });
    try {
      expect((await fetch(`${d.url}/reset/shopping`, { method: "POST" })).status).toBe(500);
      expect((await fetch(`${c.url}/reset/classifieds`, { method: "POST" })).status).toBe(500);
    } finally { d.stop(); c.stop(); }
  });
});

describe("VW7 one port table", () => {
  it("tunnels each site, its control port and the reset service, away from wav-core's local ports", () => {
    expect(env.ports.map((p) => p.remote)).toEqual([7770, 7771, 9999, 9998, 9980, 8872]);
    for (const { remote, local } of env.ports) {
      expect(local).toBe(remote + 20000);
      expect(local).not.toBe(remote + 10000);
    }
    expect(env.startup).toContain("-p 7770:80 -p 7771:8877");
    expect(env.startup).toContain("-p 9980:9980");
    expect(env.startup).toContain('("0.0.0.0", 8872)');
  });
});

describe("VW8 the VM size", () => {
  it("is n2-standard-8 with a 100 GB disk", () => {
    expect(env.machineType).toBe("n2-standard-8");
    expect(env.diskGb).toBe(100);
  });
});

describe("VW9 the data loads once", () => {
  it("fetches and unpacks on the first boot only, and a reboot starts the containers", () => {
    const f = fakes();
    expect(boot(f).status).toBe(0);
    const first = f.lines();
    expect(first.filter((l) => l.startsWith("curl")).length).toBe(1);
    expect(first.some((l) => l.startsWith("docker run") && l.includes("--name vwa-classifieds-db") && l.includes("/docker-entrypoint-initdb.d"))).toBe(true);
    expect(boot(f).status).toBe(0);
    const again = f.lines().slice(first.length);
    expect(again.some((l) => l.startsWith("curl") || l.startsWith("sha1sum") || l.startsWith("docker run") || l.startsWith("docker pull"))).toBe(false);
    expect(again.filter((l) => l.startsWith("docker start")).length).toBe(4);
  });
});
