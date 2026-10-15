// Tests for the wav-full failure modes in docs/failure-modes.md (WF1-WF7). The
// env comes from the registry. Its startup script runs under fake docker,
// systemctl and python3 tools; real map and Wikipedia cases run through the run
// loop with scripted agents against fake sites on the tunnel ports, and
// upstream's own evaluator judges them.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapter, TaskOutput } from "../src/adapter.js";
import { noopAdapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { webarenaVerified, wavFullSites, wavImage, wavSites, WIKIPEDIA_ZIM } from "../src/bench/wav/index.js";
import { WAV_VERSION, wavDir } from "../src/bench/wav/tasks.js";
import { cloudEnvs } from "../src/env/envs.js";
import { freeBase } from "./free-base.js";

// Skipped without a Docker CLI and network.
const online = spawnSync("docker", ["manifest", "inspect", "hello-world"], { stdio: "ignore", timeout: 30_000 }).status === 0;
const env = cloudEnvs.find((e) => e.name === "wav-full")!;

describe("WF1 the VM and its ports", () => {
  it("is 64 GB of RAM and 500 GB of SSD, and tunnels the core, Wikipedia and map ports at +10000", () => {
    expect(env).toMatchObject({ machineType: "n2-standard-16", diskGb: 500, diskType: "pd-ssd" });
    expect(wavFullSites.map((s) => [s.id, s.port, s.ctrlPort])).toEqual([["wikipedia", 8888, 8889], ["map", 3000, 3071]]);
    const want = [...wavSites, ...wavFullSites].flatMap((s) => [s.port, s.ctrlPort]).concat(8870);
    expect(env.ports).toEqual(want.map((remote) => ({ remote, local: remote + 10000 })));
  });
  it("is told apart from wav-core only by what it adds", () => {
    const core = cloudEnvs.find((e) => e.name === "wav-core")!;
    expect(env.ports.slice(0, core.ports.length - 1)).toEqual(core.ports.slice(0, -1));
    expect(core.startup).not.toContain("wikipedia");
  });
});

// A scratch VM: /opt/foxbench is a temp dir, and the tools log what they are asked.
function boot(dir: string, pythonPre = "", aptBody = "true") {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(join(dir, "served"))) serveMapTars(dir);
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${dir}/log\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // Containers and images are marker files: `run` records the container and its image (the last argument), pull and build make an image, and
  // `image inspect` reports the arch in arch-<image> (amd64 unless a test says otherwise).
  tool("docker", `m() { echo "$1" | tr '/:@' '___'; }
last() { for a; do l=$a; done; echo $l; }
case "$1" in
  inspect) if [ "$2" = -f ]; then cat ${dir}/image-of-$4; else [ -e ${dir}/image-of-$2 ]; fi;;
  run) shift; while [ "$1" != --name ]; do shift; done; last "$@" > ${dir}/image-of-$2;;
  pull) touch ${dir}/img-$(m $(last "$@"));;
  build) while [ "$1" != -t ]; do shift; done; touch ${dir}/img-$(m $2); cp $3/Dockerfile ${dir}/Dockerfile;;
  create) echo cid;;
  cp) mkdir -p $3;;
  rm) ;;
  image) [ -e ${dir}/img-$(m $5) ] || exit 1; cat ${dir}/arch-$(m $5) 2>/dev/null || echo amd64;;
  volume) case "$2" in create) mkdir -p ${dir}/vol/$3/_data;; inspect) echo ${dir}/vol/$5/_data;; esac;;
esac`);
  tool("uname", "echo x86_64");
  // curl without -o streams ${dir}/served/<name> (the map's archives); a count in curl-cut makes that many calls end early, as a dropped connection does (curl exit 18).
  // curl with -o is the ZIM: it writes ${dir}/zim/<host> to the -o file from where the file ends (as -C - does); a host with no file answers 403 (exit 22); a count in zim-cut ends that many calls early (exit 18).
  tool("curl", `for a; do [ "$p" = -o ] && out=$a; p=$a; url=$a; done
if [ -z "$out" ]; then
  f=${dir}/served/$(basename $url); [ -e $f ] || exit 22
  n=$(cat ${dir}/curl-cut 2>/dev/null || echo 0)
  [ "$n" -gt 0 ] && { echo $((n-1)) > ${dir}/curl-cut; head -c 20000 $f; exit 18; }
  cat $f; exit
fi
src=${dir}/zim/$(echo $url | sed 's,^[a-z]*://,,; s,/.*,,'); [ -e $src ] || exit 22
have=$(stat -c %s $out 2>/dev/null || echo 0); n=$(cat ${dir}/zim-cut 2>/dev/null || echo 0)
[ "$n" -gt 0 ] && { echo $((n-1)) > ${dir}/zim-cut; tail -c +$((have+1)) $src | head -c 20000 >> $out; exit 18; }
tail -c +$((have+1)) $src >> $out`);
  for (const name of ["systemctl", "systemd-run", "apt-get"]) tool(name, name === "systemctl" ? '[ "$1" != is-active ]' : name === "apt-get" ? aptBody : "true");
  tool("python3", `${pythonPre}\n[ "$1" = -m ] && [ "$2" = venv ] && [ "$3" != --help ] && for t in pip webarena-verified; do mkdir -p $3/bin; printf '#!/bin/sh\\necho "$t $*" >> ${dir}/log\\n' | sed "s/\\$t/$t/" > $3/bin/$t; chmod +x $3/bin/$t; done; true`);
  if (!existsSync(join(dir, "zim"))) serveZim(dir, { "archive.org": BYTES });
  // The ZIM is 95 GB: the script runs against a small one, whose size and md5 replace the pinned ones.
  const zim = existsSync(join(dir, "zim", "archive.org")) ? readFileSync(join(dir, "zim", "archive.org")) : Buffer.alloc(0);
  const md5 = execFileSync("md5sum", { input: zim, encoding: "utf8" }).split(" ")[0]!;
  const script = join(dir, "startup.sh");
  writeFileSync(script, env.startup.replaceAll("/opt/foxbench", join(dir, "fb")).replaceAll(String(WIKIPEDIA_ZIM.size), String(zim.length)).replaceAll(WIKIPEDIA_ZIM.md5, md5));
  mkdirSync(join(dir, "fb"), { recursive: true });
  const r = spawnSync("sh", [script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, DOCKER_DAEMON_JSON: join(dir, "daemon.json") } });
  return { status: r.status, stderr: r.stderr, log: existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").trim().split("\n") : [], script };
}

describe("WF2 WF3 the startup script", () => {
  const dir = mkdtempSync(join(tmpdir(), "fbn-wf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("is valid sh, pins the package and runs every image at 0.1.0", () => {
    const syntax = spawnSync("sh", ["-n", "-c", env.startup]);
    expect(syntax.status).toBe(0);
    expect(env.startup).toContain(`webarena-verified==${WAV_VERSION}`);
    // Wikipedia has no amd64 image: it is built from a digest (WF9), so it has no tag here.
    expect(env.startup.match(/am1n3e\/webarena-verified-[a-z_]+:\S+/g)!.toSorted()).toEqual([...wavSites, ...wavFullSites].filter((s) => s.id !== "wikipedia").map(wavImage).toSorted());
  });
  it("takes every image name from one table, at the tags Docker Hub has", () => {
    expect([...wavSites, ...wavFullSites].map(wavImage).toSorted()).toEqual([
      "am1n3e/webarena-verified-gitlab:0.1.0", "am1n3e/webarena-verified-map:0.1.0", "am1n3e/webarena-verified-reddit:0.1.0",
      "am1n3e/webarena-verified-shopping:0.1.0", "am1n3e/webarena-verified-shopping_admin:0.1.0", "am1n3e/webarena-verified-wikipedia:1.0.0"]);
  });
  // Real registry: the fake docker above cannot tell a missing tag from a present one (the first GCP run failed on that).
  it.skipIf(!online)("has every image of the startup script on Docker Hub", (t) => {
    for (const image of env.startup.match(/am1n3e\/webarena-verified-[a-z_]+:\S+/g)!) {
      const r = spawnSync("docker", ["manifest", "inspect", image], { encoding: "utf8", timeout: 60_000 });
      if (/toomanyrequests|429/.test(r.stderr)) return t.skip("Docker Hub rate limit");
      expect(r.status, `${image}: ${r.stderr}`).toBe(0);
    }
  });
  it("installs python3-venv when ensurepip is missing, before the venv step", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "fbn-wf-venv-"));
    try {
      const noEnsurepip = boot(dir2, `[ "$1" = -c ] && [ ! -e ${dir2}/venv-installed ] && exit 1`, `[ "$*" = "install -y -q python3-venv" ] && touch ${dir2}/venv-installed; true`);
      expect(noEnsurepip.status, noEnsurepip.stderr).toBe(0);
      const at = (re: RegExp) => noEnsurepip.log.findIndex((l) => re.test(l));
      expect(at(/^apt-get install .*python3-venv/)).toBeGreaterThan(-1);
      expect(at(/^python3 -m venv .*wav-venv/)).toBeGreaterThan(at(/^apt-get install .*python3-venv/));
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  });
  it("starts the core sites and the reset service first, then sets up each data site once", () => {
    const first = boot(dir);
    expect(first.status, first.stderr).toBe(0);
    const at = (re: RegExp) => first.log.findIndex((l) => re.test(l));
    const setup = first.log.filter((l) => l.startsWith("webarena-verified env setup init"));
    expect(setup).toEqual([]);
    expect(first.log).toContain(`pip install -q webarena-verified==${WAV_VERSION}`);
    const lastCore = Math.max(...wavSites.map((s) => at(new RegExp(`^docker run .*--name wav-${s.id} `))));
    expect(lastCore).toBeGreaterThan(-1);
    expect(at(/^systemd-run /)).toBeGreaterThan(lastCore);
    expect(at(/^webarena-verified env setup init/)).toBeGreaterThan(at(/^systemd-run /));
    // Wikipedia gets the ZIM directory; the map gets upstream's named volumes; each on its ports.
    expect(first.log.find((l) => l.includes("--name wav-wikipedia "))).toMatch(/-p 8888:8080 -p 8889:8874 .*-v \S+wav-data:\/data:ro/);
    expect(first.log.find((l) => l.includes("--name wav-map "))).toMatch(/-p 3000:8080 -p 3071:8877 .*-v webarena_verified_map_tile_db:\/data\/database/);
  });
  it("downloads nothing on the second boot and only starts the containers", () => {
    const second = boot(dir);
    expect(second.status, second.stderr).toBe(0);
    const before = readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    expect(before.filter((l) => l.startsWith("webarena-verified env setup init"))).toHaveLength(1);
    expect(before.filter((l) => l.startsWith("docker pull"))).toHaveLength(6);
    expect(before.filter((l) => l.startsWith("docker start"))).toHaveLength(6);
  });
});

// The map's three archives as upstream's config.py lays them out, in miniature: [archive, volume, path inside it].
const MAP_TARS: [string, string, string][] = [
  ["osm_tile_server.tar", "webarena_verified_map_tile_db", "projects/ogma3/docker/volumes/osm-data/_data"],
  ["osrm_routing.tar", "webarena_verified_map_routing_car", "car"], ["osrm_routing.tar", "webarena_verified_map_routing_bike", "bike"], ["osrm_routing.tar", "webarena_verified_map_routing_foot", "foot"],
  ["nominatim_volumes.tar", "webarena_verified_map_nominatim_db", "projects/metis2/docker/docker/volumes/nominatim-data/_data"],
  ["nominatim_volumes.tar", "webarena_verified_map_nominatim_flatnode", "projects/metis2/docker/docker/volumes/nominatim-flatnode/_data"],
];
function serveMapTars(dir: string) {
  const stage = join(dir, "stage");
  mkdirSync(join(dir, "served"), { recursive: true });
  for (const [, vol, path] of MAP_TARS) {
    mkdirSync(join(stage, path), { recursive: true });
    writeFileSync(join(stage, path, "data.bin"), vol.repeat(5000));
  }
  for (const name of new Set(MAP_TARS.map((t) => t[0]))) {
    const roots = MAP_TARS.filter((t) => t[0] === name).map((t) => t[2].split("/")[0]!);
    execFileSync("tar", ["-cf", join(dir, "served", name), "-C", stage, ...new Set(roots)]);
  }
}

const fresh = () => mkdtempSync(join(tmpdir(), "fbn-wf8-"));
const volume = (dir: string, vol: string) => join(dir, "vol", vol, "_data", "data.bin");
describe("WF8 the map's archives are never kept on the disk", () => {
  it("streams each archive into its volumes: no tar in the data directory, each volume holding its own path", () => {
    const dir = fresh();
    try {
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      for (const [, vol] of MAP_TARS) expect(readFileSync(volume(dir, vol), "utf8"), vol).toBe(vol.repeat(5000));
      expect(execFileSync("find", [join(dir, "fb"), "-name", "*.tar"], { encoding: "utf8" })).toBe("");
      expect(r.log.some((l) => l.includes("--site map"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("starts a cut stream again on a clean volume", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "curl-cut"), "2");
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      for (const [, vol] of MAP_TARS) expect(readFileSync(volume(dir, vol), "utf8"), vol).toBe(vol.repeat(5000));
      expect(r.log.filter((l) => l.startsWith("curl ")).length).toBeGreaterThan(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("fails the boot with one clear line when an archive keeps failing", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "curl-cut"), "99");
      const r = boot(dir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/^foxbench: BOOT FAILED: map archive \S+\.tar did not stream into its volumes after 3 tries$/m);
      expect(r.log.some((l) => l.startsWith("docker run") && l.includes("--name wav-map "))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("sizes the disk from the archives, the ZIM and the images with headroom, on SSD", () => {
    // 187.4 GB of archives (124.8 + 41.3 + 21.3), 95.2 GB of ZIM and 91 GB of images, each as measured: 374 GB.
    expect(env.diskGb).toBeGreaterThanOrEqual(Math.ceil(374 * 1.25));
    expect(env.diskType).toBe("pd-ssd");
  });
});

describe("WF9 every image runs on the VM's architecture", () => {
  it("pulls each image for the VM's platform and runs it", () => {
    const dir = fresh();
    try {
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      for (const s of [...wavSites, wavFullSites[1]!]) expect(r.log, s.id).toContain(`docker pull -q --platform linux/amd64 ${wavImage(s)}`);
      const runs = r.log.filter((l) => l.startsWith("docker run "));
      expect(runs).toHaveLength(6);
      expect(runs.every((l) => l.includes("--platform linux/amd64"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("builds Wikipedia for amd64 from its arm64-only image, as upstream publishes no other", () => {
    const dir = fresh();
    try {
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      // The only Wikipedia image, :1.0.0 and :latest, is one linux/arm64 manifest; its files are Python and shell, and kiwix-serve comes from the amd64 base.
      expect(r.log.some((l) => /^docker pull -q --platform linux\/arm64 am1n3e\/webarena-verified-wikipedia@sha256:[0-9a-f]{64}$/.test(l))).toBe(true);
      const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf8");
      expect(dockerfile).toMatch(/^FROM ghcr\.io\/kiwix\/kiwix-serve@sha256:[0-9a-f]{64}$/m);
      expect(dockerfile).toContain('ENTRYPOINT ["/entrypoint.sh"]');
      expect(readFileSync(join(dir, "image-of-wav-wikipedia"), "utf8").trim()).toBe("foxbench-wikipedia:1.0.0");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("stops the boot with one clear line when a pulled image is for another architecture", () => {
    const dir = fresh();
    try {
      writeFileSync(join(dir, "arch-am1n3e_webarena-verified-reddit_0.1.0"), "arm64\n");
      const r = boot(dir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/^foxbench: BOOT FAILED: image am1n3e\/webarena-verified-reddit:0\.1\.0 is linux\/arm64 but this VM is linux\/amd64$/m);
      expect(r.log.some((l) => l.includes("--name wav-gitlab "))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("checks a container that exists from an earlier boot too", () => {
    const dir = fresh();
    try {
      expect(boot(dir).status).toBe(0);
      writeFileSync(join(dir, "arch-foxbench-wikipedia_1.0.0"), "arm64\n");
      const r = boot(dir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/BOOT FAILED: image foxbench-wikipedia:1\.0\.0 is linux\/arm64 but this VM is linux\/amd64/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("has the images the build needs, at the registries, when there is network", (t) => {
    if (!online) return t.skip("no network");
    for (const image of env.startup.match(/(?:am1n3e\/webarena-verified-wikipedia|ghcr\.io\/kiwix\/kiwix-serve)@sha256:[0-9a-f]{64}/g)!) {
      const r = spawnSync("docker", ["manifest", "inspect", image], { encoding: "utf8", timeout: 60_000 });
      if (/toomanyrequests|429/.test(r.stderr)) return t.skip("Docker Hub rate limit");
      expect(r.status, `${image}: ${r.stderr}`).toBe(0);
    }
  });
});

const zimFile = (dir: string) => join(dir, "fb", "wav-data", WIKIPEDIA_ZIM.file);
// A small ZIM for the fake curl: `sources` are the hosts that have it, each with its own bytes.
function serveZim(dir: string, sources: Record<string, Buffer>) {
  mkdirSync(join(dir, "zim"), { recursive: true });
  for (const [host, bytes] of Object.entries(sources)) writeFileSync(join(dir, "zim", host), bytes);
}
const BYTES = Buffer.alloc(90_000, "wikipedia ");
const fresh10 = () => mkdtempSync(join(tmpdir(), "fbn-wf10-"));
const wikiRuns = (log: string[]) => log.some((l) => l.startsWith("docker run") && l.includes("--name wav-wikipedia "));

describe("WF10 the ZIM file is complete before Wikipedia starts", () => {
  it("downloads it from the first source, resuming a cut transfer, and keeps no .part file", () => {
    const dir = fresh10();
    try {
      serveZim(dir, { "metis.lti.cs.cmu.edu": BYTES, "archive.org": BYTES });
      writeFileSync(join(dir, "zim-cut"), "2");
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(zimFile(dir)).equals(BYTES)).toBe(true);
      expect(existsSync(`${zimFile(dir)}.part`)).toBe(false);
      expect(r.log.filter((l) => l.startsWith("curl ") && l.includes(" -o ")).every((l) => l.includes("-C -") && l.includes("metis.lti.cs.cmu.edu"))).toBe(true);
      expect(wikiRuns(r.log)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("falls back to the Internet Archive when the first source answers 403", () => {
    const dir = fresh10();
    try {
      serveZim(dir, { "archive.org": BYTES });
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(zimFile(dir)).equals(BYTES)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("stops the boot with one clear line when every source is short, and starts no Wikipedia", () => {
    const dir = fresh10();
    try {
      serveZim(dir, { "archive.org": BYTES });
      writeFileSync(join(dir, "zim-cut"), "99");
      const r = boot(dir);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/^foxbench: BOOT FAILED: Wikipedia ZIM \S+ is short: \d+ of 90000 bytes$/m);
      expect(existsSync(zimFile(dir))).toBe(false);
      expect(wikiRuns(r.log)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects a file of the right size with the wrong checksum, and tries the next source", () => {
    const dir = fresh10();
    try {
      serveZim(dir, { "metis.lti.cs.cmu.edu": Buffer.alloc(BYTES.length, "x"), "archive.org": BYTES });
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/foxbench: ZIM from \S+cmu\.edu\S+ has md5 \w+, not \w+/);
      expect(readFileSync(zimFile(dir)).equals(BYTES)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not trust a file that exists with no check, such as the 0 bytes the first real run left", () => {
    const dir = fresh10();
    try {
      serveZim(dir, { "archive.org": BYTES });
      mkdirSync(join(dir, "fb", "wav-data"), { recursive: true });
      writeFileSync(zimFile(dir), "");
      const r = boot(dir);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(zimFile(dir)).equals(BYTES)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("downloads nothing on the second boot", () => {
    const dir = fresh10();
    try {
      serveZim(dir, { "archive.org": BYTES });
      const first = boot(dir);
      expect(first.status).toBe(0);
      const second = boot(dir);
      expect(second.status, second.stderr).toBe(0);
      expect(second.log.filter((l) => l.startsWith("curl "))).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("pins the size of the file the Internet Archive serves", async (t) => {
    const head = await fetch(`https://archive.org/download/wikipedia_en_all_maxi_2022-05/${WIKIPEDIA_ZIM.file}`, { method: "HEAD", signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!head) return t.skip("no network");
    expect(head.headers.get("content-length")).toBe(String(WIKIPEDIA_ZIM.size));
  });
});

// Below the OS ephemeral range, where a listen(0) server in a parallel test file can hold a port.
const OFFSET = await freeBase(21500, 1000, [...wavSites, ...wavFullSites].flatMap((s) => [s.port, s.ctrlPort]).concat(8870));
// Only map and Wikipedia cases bind a port that other test files use (3000, 8888 are not theirs); a core case would clash with wav-judge and wav-tasks when files run in parallel.
const IDS = ["70", "97", "369"];
const ctx = benchContext();
const servers: Server[] = [];
const seen: Record<string, IncomingHttpHeaders[]> = {};
const resets: string[] = [];
let wantFull = true;

type Want = { answer: unknown; url?: string };
let want: Record<string, Want> = {};
let intents: Record<string, string> = {};
function expected() {
  const code = `import json, sys
from importlib.resources import files
tasks = json.loads((files("webarena_verified") / "assets/dataset/webarena-verified.json").read_text())
out = {}
for t in tasks:
    if str(t["task_id"]) not in sys.argv[1].split(","): continue
    ev = {e["evaluator"]: e for e in t["eval"]}
    exp = ev["AgentResponseEvaluator"]["expected"]
    net = ev.get("NetworkEventEvaluator", {}).get("expected", {})
    out[t["task_id"]] = {"intent": t["intent"], "answer": {"task_type": exp["task_type"].upper(), "status": exp["status"], "retrieved_data": exp.get("retrieved_data")}, "url": net.get("url")}
json.dump(out, sys.stdout)`;
  return JSON.parse(execFileSync(ctx.env.FOXBENCH_UV || "uv", ["run", "-q", "--isolated", "--no-project", "--python", "3.12", "--with", `webarena-verified==${WAV_VERSION}`, "python", "-I", "-c", code, IDS.join(",")], { encoding: "utf8" }));
}
async function listen(server: Server, port: number) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(port + OFFSET, "127.0.0.1", r));
}
beforeAll(async () => {
  const got = expected();
  for (const id of IDS) {
    const { intent, ...rest } = got[id];
    intents[id] = intent;
    want[id] = rest;
  }
  for (const site of [...wavSites, ...wavFullSites]) {
    seen[site.id] = [];
    // The data sites' servers answer only while a test wants wav-full to be up.
    const gone = () => site.readOnly && !wantFull;
    await listen(createServer((req, res) => (gone() ? req.destroy() : res.end(JSON.stringify({ success: true })))), site.ctrlPort);
    await listen(createServer((req, res) => {
      if (gone()) return req.destroy();
      // The env's own probe of the site is not the agent's request.
      if (req.headers.host !== `127.0.0.1:${site.port + OFFSET}`) seen[site.id]!.push(req.headers);
      req.resume();
      res.writeHead(200, { "content-type": "text/html" }).end("<p>a page</p>");
    }), site.port);
  }
  await listen(createServer((req, res) => { resets.push(req.url ?? ""); res.end("reset"); }), 8870);
}, 300_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

// A new connection per request: the proxy of the last case on a port is gone, and a pooled socket to it would fail.
const page = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", ...init, headers: { accept: "text/html", connection: "close", ...init.headers } });
const idOf = (goal: string) => IDS.find((id) => goal.includes(`\`${intents[id]}\``))!;
function scripted(name: string, act: (id: string) => Promise<TaskOutput>): Adapter {
  return { name, runTask: async ({ url, goal }) => { await page(url); return act(idOf(goal)); } };
}
const SITE: Record<string, string> = { __MAP__: "http://127.0.0.1:3000" };
const perfect = scripted("perfect", async (id) => {
  const w = want[id]!;
  // Task 97's expected request is a pattern; any car route on the map matches it.
  if (id === "97") await page("http://127.0.0.1:3000/routed-car/route/v1/driving/-79.9,40.4;-75.1,39.9");
  else if (w.url) await page(w.url.replace(/^__[A-Z_]+__/, (m) => SITE[m]!));
  return { done: true, log: "", answer: JSON.stringify(w.answer) };
});
const wrong = scripted("wrong", async (id) => {
  // A stray POST to the map must not mark it for a reset it cannot do (WF7).
  await page("http://127.0.0.1:3000/api/0.6/changeset/create", { method: "POST", body: "x=1" });
  const answer = want[id]!.answer as { retrieved_data: unknown };
  return { done: true, log: "", answer: JSON.stringify({ ...answer, retrieved_data: answer.retrieved_data ? ["something else"] : null }) };
});
const dirtyFile = join(wavDir(ctx), `dirty-127.0.0.1-${OFFSET}.json`);
const run = (adapter: Adapter, ids = IDS) => {
  rmSync(dirtyFile, { force: true });
  return runBenchmarks({ adapter, runs: [{ benchmark: webarenaVerified({ offset: OFFSET }), subset: "full" }], ids, timeoutMs: 60_000 });
};

describe("WF5 WF6 map and Wikipedia cases", () => {
  it("passes the scripted perfect agent, and fails noop and the wrong agent", async () => {
    wantFull = true;
    const board = await run(perfect);
    expect(board.results.map((r) => [r.id, r.success, r.reasons])).toEqual(IDS.map((id) => [id, true, []]));
    expect((await run(noopAdapter())).passed).toBe(0);
    const bad = await run(wrong, ["70", "369", "97"]);
    expect(bad.passed).toBe(0);
    expect(bad.results.every((r) => !r.reasons[0]!.startsWith("harness:"))).toBe(true);
  }, 300_000);
  it("opens each site on its own port with its Host, no login header, and tags the cases", async () => {
    wantFull = true;
    seen.map!.length = 0;
    await run(perfect, ["369", "97"]);
    expect(seen.map!.length).toBeGreaterThan(0);
    for (const h of seen.map!) {
      expect(h.host).toBe("127.0.0.1:3000");
      expect(Object.keys(h).filter((k) => /auto-login|cookie|authorization/.test(k))).toEqual([]);
    }
    const cases = await webarenaVerified({ offset: OFFSET }).load(ctx, "full");
    expect(cases.filter((c) => c.tags.includes("map"))).toHaveLength(128);
    expect(cases.filter((c) => c.tags.includes("wikipedia"))).toHaveLength(23);
    expect(cases.find((c) => c.id === "97")!.tags).toEqual(expect.arrayContaining(["map", "wikipedia", "multi-site"]));
  }, 300_000);
});

describe("WF4 only wav-core is up", () => {
  it("is ready, and fails map and Wikipedia cases with a reason that names wav-full", async () => {
    wantFull = false;
    expect(await webarenaVerified({ offset: OFFSET }).check(ctx)).toEqual({ ready: true });
    const board = await run(perfect, ["70", "97", "556"]);
    const by = Object.fromEntries(board.results.map((r) => [r.id, r]));
    for (const id of ["70", "97", "556"]) {
      expect(by[id]!.success).toBe(false);
      expect(by[id]!.reasons[0]).toMatch(/^harness: skipped: .*(map|wikipedia).*wav-full/);
    }
    // 556 has GitLab, which is up; the reason names only the site that is missing.
    expect(by["556"]!.reasons[0]).toContain("needs wikipedia,");
    expect(board.skipped).toEqual([]);
  }, 300_000);
});

describe("WF7 map and Wikipedia are read-only", () => {
  it("never marks them for a reset, and the reset service does not know them", async () => {
    wantFull = true;
    resets.length = 0;
    await run(wrong, ["70", "369"]);
    expect(existsSync(dirtyFile) ? JSON.parse(readFileSync(dirtyFile, "utf8")) : []).toEqual([]);
    expect(resets).toEqual([]);
    expect(env.startup).toContain('if site not in ("shopping", "shopping_admin", "reddit", "gitlab"):');
  }, 300_000);
});
