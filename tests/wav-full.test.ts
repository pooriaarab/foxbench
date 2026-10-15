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
import { webarenaVerified, wavFullSites, wavImage, wavSites } from "../src/bench/wav/index.js";
import { WAV_VERSION, wavDir } from "../src/bench/wav/tasks.js";
import { cloudEnvs } from "../src/env/envs.js";
import { freeBase } from "./free-base.js";

// Skipped without a Docker CLI and network.
const online = spawnSync("docker", ["manifest", "inspect", "hello-world"], { stdio: "ignore", timeout: 30_000 }).status === 0;
const env = cloudEnvs.find((e) => e.name === "wav-full")!;

describe("WF1 the VM and its ports", () => {
  it("is 64 GB of RAM and 450 GB of disk, and tunnels the core, Wikipedia and map ports at +10000", () => {
    expect(env).toMatchObject({ machineType: "n2-standard-16", diskGb: 450 });
    expect(wavFullSites.map((s) => [s.id, s.port, s.ctrlPort])).toEqual([["wikipedia", 8888, 8889], ["map", 3000, 3001]]);
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
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${dir}/log\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  tool("docker", `case "$1" in inspect) [ -e ${dir}/has-$2 ];; run) shift; while [ "$1" != --name ]; do shift; done; touch ${dir}/has-$2;; esac`);
  for (const name of ["systemctl", "systemd-run", "apt-get"]) tool(name, name === "systemctl" ? '[ "$1" != is-active ]' : name === "apt-get" ? aptBody : "true");
  tool("python3", `${pythonPre}\n[ "$1" = -m ] && [ "$2" = venv ] && [ "$3" != --help ] && for t in pip webarena-verified; do mkdir -p $3/bin; printf '#!/bin/sh\\necho "$t $*" >> ${dir}/log\\n' | sed "s/\\$t/$t/" > $3/bin/$t; chmod +x $3/bin/$t; done; true`);
  const script = join(dir, "startup.sh");
  writeFileSync(script, env.startup.replaceAll("/opt/foxbench", join(dir, "fb")));
  mkdirSync(join(dir, "fb"), { recursive: true });
  const r = spawnSync("sh", [script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
  return { status: r.status, stderr: r.stderr, log: existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").trim().split("\n") : [], script };
}

describe("WF2 WF3 the startup script", () => {
  const dir = mkdtempSync(join(tmpdir(), "fbn-wf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("is valid sh, pins the package and runs every image at 0.1.0", () => {
    const syntax = spawnSync("sh", ["-n", "-c", env.startup]);
    expect(syntax.status).toBe(0);
    expect(env.startup).toContain(`webarena-verified==${WAV_VERSION}`);
    expect(env.startup.match(/am1n3e\/webarena-verified-[a-z_]+:\S+/g)!.toSorted()).toEqual([...wavSites, ...wavFullSites].map(wavImage).toSorted());
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
    expect(setup.map((l) => l.split(" ")[5])).toEqual(["wikipedia", "map"]);
    expect(first.log).toContain(`pip install -q webarena-verified==${WAV_VERSION}`);
    const lastCore = Math.max(...wavSites.map((s) => at(new RegExp(`^docker run .*--name wav-${s.id} `))));
    expect(lastCore).toBeGreaterThan(-1);
    expect(at(/^systemd-run /)).toBeGreaterThan(lastCore);
    expect(at(/^webarena-verified env setup init/)).toBeGreaterThan(at(/^systemd-run /));
    // Wikipedia gets the ZIM directory; the map gets upstream's named volumes; each on its ports.
    expect(first.log.find((l) => l.includes("--name wav-wikipedia "))).toMatch(/-p 8888:8080 -p 8889:8874 .*-v \S+wav-data:\/data:ro/);
    expect(first.log.find((l) => l.includes("--name wav-map "))).toMatch(/-p 3000:8080 -p 3001:8877 .*-v webarena_verified_map_tile_db:\/data\/database/);
  });
  it("downloads nothing on the second boot and only starts the containers", () => {
    const second = boot(dir);
    expect(second.status, second.stderr).toBe(0);
    const before = readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    expect(before.filter((l) => l.startsWith("webarena-verified env setup init"))).toHaveLength(2);
    expect(before.filter((l) => l.startsWith("docker pull"))).toHaveLength(6);
    expect(before.filter((l) => l.startsWith("docker start"))).toHaveLength(6);
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
