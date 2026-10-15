// Tests for the WebMall env failure modes in docs/failure-modes.md (WM1-WM12). A fake
// docker and curl on PATH log every call, so the script runs for real and nothing is fetched.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TUNNEL_OFFSET, WEBMALL_IMAGES, WEBMALL_REF, webmallSites, webmallStartup } from "../src/bench/webmall/env.js";

const root = join(import.meta.dirname, "..");
const fixtures = join(root, "tests/fixtures");
let home = "";
let source = "";
const cache = () => join(home, "cache", `webmall-${WEBMALL_REF.slice(0, 12)}`);

beforeAll(() => {
  // What codeload serves: the repo tree with its docker_all/ directory.
  const tree = mkdtempSync(join(tmpdir(), "fbn-wm-src-"));
  mkdirSync(join(tree, "WebMall-x/docker_all/deployed_wp_config_local"), { recursive: true });
  writeFileSync(join(tree, "WebMall-x/docker_all/docker-compose.yml"), "services: {}\n");
  for (const n of [1, 2, 3, 4]) writeFileSync(join(tree, `WebMall-x/docker_all/deployed_wp_config_local/shop_${n}.php`), `define( 'WP_HOME', 'http://localhost:SHOP${n}_PORT_PLACEHOLDER' );\n`);
  source = join(tree, "src.tar.gz");
  execFileSync("tar", ["czf", source, "-C", tree, "WebMall-x"]);
});
afterEach(() => {
  // Close any tunnel a test left up.
  if (existsSync(join(home, ".foxbench/env/webmall.json"))) cli(["env", "down", "webmall"]);
});

function fresh() {
  home = mkdtempSync(join(tmpdir(), "fbn-wm-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const [name, file] of [["docker", "fake-docker.mjs"], ["curl", "fake-curl.mjs"]] as const) execFileSync("ln", ["-s", join(fixtures, file), join(bin, name)]);
  return bin;
}
function cli(args: string[], env: Record<string, string> = {}, path = join(home, "bin")) {
  const r = spawnSync(process.execPath, [join(root, "dist/cli.js"), ...args], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: home, FOXBENCH_CACHE: join(home, "cache"), PATH: `${path}:${process.env.PATH}`, FAKE_LOG: join(home, "calls.jsonl"), FAKE_SOURCE: source,
      FOXBENCH_GCLOUD: join(fixtures, "fake-gcloud.mjs"), FAKE_GCLOUD_LOG: join(home, "gcloud.jsonl"),
      FOXBENCH_GCP_PROJECT: "test-project", FOXBENCH_GCP_ZONE: "test-zone-a", ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const up = (env: Record<string, string> = {}) => cli(["env", "up", "webmall", "--provider", "docker"], env);
const calls = (): { cmd: string; argv: string[] }[] => (existsSync(join(home, "calls.jsonl")) ? readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const docker = (...prefix: string[]) => calls().filter((c) => c.cmd === "docker" && prefix.every((p, i) => c.argv[i] === p));
const backups = () => calls().filter((c) => c.cmd === "curl" && c.argv.at(-1)!.includes("/webmall/backup/"));

describe("WebMall env", () => {
  it("WM1 fetches the pinned commit and pins every image by digest", () => {
    fresh();
    expect(up().status).toBe(0);
    expect(calls().find((c) => c.argv.at(-1)!.includes("codeload"))!.argv.at(-1)).toBe(`https://codeload.github.com/wbsg-uni-mannheim/WebMall/tar.gz/${WEBMALL_REF}`);
    expect(WEBMALL_REF).toMatch(/^[0-9a-f]{40}$/);
    const override = readFileSync(join(cache(), "override.yml"), "utf8");
    const images = [...override.matchAll(/image: (\S+)/g)].map((m) => m[1]!);
    expect(images).toHaveLength(10);
    for (const image of images) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    for (const image of Object.values(WEBMALL_IMAGES)) expect(image).toMatch(/@sha256:/);
  });

  it("WM2 binds 127.0.0.1 locally, 0.0.0.0 on the VM, and publishes no Elasticsearch port", () => {
    fresh();
    up();
    expect(readFileSync(join(cache(), "webmall.env"), "utf8")).toBe(webmallSites.map((s, n) => `${s.id === "frontend" ? "FRONTEND" : `SHOP${n + 1}`}_PORT=127.0.0.1:${s.port + TUNNEL_OFFSET}\n`).join(""));
    expect(readFileSync(join(cache(), "override.yml"), "utf8")).toContain("ports: !reset []");
    expect(webmallStartup()).toContain("SHOP1_PORT=0.0.0.0:18081");
  });

  it("WM3 names the proxy's origin in wp-config.php and the database", () => {
    fresh();
    up();
    for (const n of [1, 2, 3, 4]) {
      expect(readFileSync(join(cache(), `wp-config.${n}.php`), "utf8")).toBe(`define( 'WP_HOME', 'http://127.0.0.1:808${n}' );\n`);
      // The restored data holds the authors' host, localhost, and localhost with its port doubled; the longest goes before its prefix.
      const from = docker("exec", `WebMall_wordpress_shop${n}`, "wp", "search-replace").map((c) => c.argv[c.argv.indexOf("search-replace") + 1]);
      expect(from).toEqual([`https://webmall-${n}.informatik.uni-mannheim.de`, `http://localhost:808${n}:808${n}`, `http://localhost:808${n}`]);
      for (const c of docker("exec", `WebMall_wordpress_shop${n}`, "wp", "search-replace")) expect(c.argv[c.argv.indexOf("search-replace") + 2]).toBe(`http://127.0.0.1:808${n}`);
    }
  });

  it("WM13 gives Elasticsearch no ARM-only JVM flag on x86", () => {
    for (const [arch, flag] of [["x86_64", false], ["arm64", true]] as const) {
      const bin = fresh();
      writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${arch}\n`, { mode: 0o755 });
      expect(up().status).toBe(0);
      expect(readFileSync(join(cache(), "override.yml"), "utf8").includes("UseSVE=0")).toBe(flag);
    }
  });

  it("WM4 an interrupted first run restores again, and the ready marker comes last", () => {
    fresh();
    expect(up({ FAKE_DOCKER_FAIL: "up" }).status).toBe(1);
    expect(existsSync(join(cache(), "ready"))).toBe(false);
    expect(up().status).toBe(0);
    expect(existsSync(join(cache(), "ready"))).toBe(true);
    // Both runs removed the project's volumes before they restored.
    expect(docker("compose").filter((c) => c.argv.includes("down") && c.argv.includes("-v"))).toHaveLength(2);
  });

  it("WM5 a second up only starts the containers", () => {
    fresh();
    up();
    const before = calls().length;
    expect(up().status).toBe(0);
    const again = calls().slice(before);
    expect(again.filter((c) => c.cmd === "curl" && !c.argv.includes("/dev/null"))).toEqual([]);
    expect(again.filter((c) => c.argv[0] === "run")).toEqual([]);
    expect(again.filter((c) => c.argv[0] === "compose" && c.argv.includes("up"))).toHaveLength(1);
    expect(backups()).toHaveLength(8);
  });

  it("WM6 renames every volume, and mounts no other", () => {
    fresh();
    up();
    const override = readFileSync(join(cache(), "override.yml"), "utf8");
    const names = [...override.matchAll(/name: (\S+)/g)].map((m) => m[1]!);
    expect(names).toHaveLength(9);
    for (const name of names) expect(name).toMatch(/^foxbench_webmall_/);
    for (const c of docker("run")) for (const m of c.argv.filter((a, i) => c.argv[i - 1] === "-v" && !a.startsWith("/"))) expect(m).toMatch(/^foxbench_webmall_/);
  });

  it("WM7 a corrupt backup stops before the restore and leaves no file", () => {
    fresh();
    const r = up({ FAKE_CORRUPT: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not fetch mariadb_data_shop1");
    expect(docker("run")).toEqual([]);
    expect(existsSync(join(cache(), "backup", "mariadb_data_shop1.tar.gz"))).toBe(false);
    expect(existsSync(join(cache(), "backup", "mariadb_data_shop1.part"))).toBe(false);
    // One download at a time, each retried: the authors' server answers 429 to a second connection.
    expect(backups()[0]!.argv).toEqual(expect.arrayContaining(["--retry", "20"]));
  });

  it("WM8 down removes only the project's containers", () => {
    fresh();
    const r = cli(["env", "down", "webmall", "--provider", "docker"], { FAKE_DOCKER_PS: "abc\ndef" });
    expect(r.status).toBe(0);
    expect(docker("ps")[0]!.argv).toEqual(["ps", "-aq", "--filter", "label=com.docker.compose.project=foxbench-webmall"]);
    expect(docker("rm")).toHaveLength(1);
    expect(docker("rm")[0]!.argv).toEqual(["rm", "-f", "abc", "def"]);
    expect(docker("volume")).toEqual([]);
  });

  it("WM9 is an e2-standard-4 with 40 GB, five tunnels and a long boot wait", () => {
    fresh();
    const r = cli(["env", "up", "webmall"], { FAKE_GCLOUD_LOG: join(home, "gcloud.jsonl") });
    expect(r.status).toBe(0);
    const gcloud = readFileSync(join(home, "gcloud.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; script?: string });
    const create = gcloud.find((c) => c.argv.includes("create"))!;
    expect(create.argv).toEqual(expect.arrayContaining(["--machine-type=e2-standard-4", "--boot-disk-size=40GB", "--labels=foxbench-env=webmall"]));
    expect(create.script).toBe(webmallStartup());
    const ports = gcloud.filter((c) => c.argv.includes("start-iap-tunnel")).map((c) => c.argv.find((a) => a.startsWith("--local-host-port="))!.split(":")[1]);
    expect(ports).toEqual(webmallSites.map((s) => String(s.port + TUNNEL_OFFSET)));
  });

  it("WM10 an env without a local mode, or an unknown provider, stops before docker", () => {
    fresh();
    const smoke = cli(["env", "up", "smoke", "--provider", "docker"]);
    expect([smoke.status, smoke.stderr]).toEqual([2, expect.stringContaining("smoke has no local Docker mode")]);
    const nope = cli(["env", "up", "webmall", "--provider", "podman"]);
    expect([nope.status, nope.stderr]).toEqual([2, expect.stringContaining("--provider is gcp or docker")]);
    expect(calls()).toEqual([]);
  });

  it("WM11 a missing docker is a clear error", () => {
    fresh();
    const r = spawnSync(process.execPath, [join(root, "dist/cli.js"), "env", "up", "webmall", "--provider", "docker"], { encoding: "utf8", env: { PATH: "/nonexistent", HOME: home } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Could not run docker");
  });
});
