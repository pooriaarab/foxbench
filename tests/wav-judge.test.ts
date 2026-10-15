// Tests for the WebArena-Verified scoring failure modes in docs/failure-modes.md
// (WJ1-WJ9). Real cases run through the run loop with scripted agents, against
// fake sites on the tunnel ports; upstream's own evaluator judges them.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapter, TaskOutput } from "../src/adapter.js";
import { noopAdapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { webarenaVerified, wavSites } from "../src/bench/wav/index.js";
import { WAV_VERSION, wavDir } from "../src/bench/wav/tasks.js";
import { freeBase } from "./free-base.js";

// Below the ephemeral range, in a band of this file's own.
const OFFSET = await freeBase(17000, 1000, [...wavSites.flatMap((s) => [s.port, s.ctrlPort]), 8870]);
const IDS = ["0", "27", "44", "580"];
// This file's own HAR directory; the shared <cache>/har is not used (WJ9).
const HAR_DIR = mkdtempSync(join(tmpdir(), "fbn-wj-har-"));
const ctx = benchContext();
const servers: Server[] = [];
const resets: string[] = [];
let siteDown = "";

/** Each id's expected answer and request, read from the pinned package, never from the repo. */
type Want = { answer: unknown; url?: string; method?: string; post?: Record<string, string> };
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
    url = net.get("url")
    out[t["task_id"]] = {"intent": t["intent"], "answer": {"task_type": exp["task_type"].upper(), "status": exp["status"], "retrieved_data": exp.get("retrieved_data")},
        "url": url[0] if isinstance(url, list) else url, "method": net.get("http_method"), "post": net.get("post_data")}
json.dump(out, sys.stdout)`;
  return JSON.parse(execFileSync(ctx.env.FOXBENCH_UV || "uv", ["run", "-q", "--isolated", "--no-project", "--python", "3.12", "--with", `webarena-verified==${WAV_VERSION}`, "python", "-I", "-c", code, IDS.join(",")], { encoding: "utf8" }));
}
// The sites' own ports (the proxies') move too, so no file holds 9999 or 8023 (WT11).
const PORT_OFFSET = await freeBase(15700, 1000, wavSites.map((s) => s.port));
const at = (port: number) => port + PORT_OFFSET;
const SITE_URL: Record<string, string> = { __SHOPPING__: `http://127.0.0.1:${at(7770)}`, __SHOPPING_ADMIN__: `http://127.0.0.1:${at(7780)}/admin`, __REDDIT__: `http://127.0.0.1:${at(9999)}`, __GITLAB__: `http://127.0.0.1:${at(8023)}` };
const render = (url: string) => url.replace(/^__[A-Z_]+__/, (m) => SITE_URL[m]!);

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
  for (const site of wavSites) {
    await listen(createServer((_req, res) => res.end(JSON.stringify({ success: site.id !== siteDown }))), site.ctrlPort);
    await listen(createServer(async (req, res) => {
      for await (const _ of req);
      if (site.id === "gitlab" && req.url === "/users/sign_in") {
        if (req.method === "GET") return res.writeHead(200, { "set-cookie": "_gitlab_session=anon" }).end('<input name="authenticity_token" value="t">');
        return res.writeHead(302, { location: `http://127.0.0.1:${at(8023)}/`, "set-cookie": "_gitlab_session=in" }).end();
      }
      if (req.method === "POST") return res.writeHead(302, { location: `http://127.0.0.1:${at(site.port)}/f/sci_fi`, "set-cookie": "flash=done; path=/" }).end();
      res.writeHead(200, { "content-type": req.url?.startsWith("/api") ? "application/json" : "text/html" }).end(req.url?.startsWith("/api") ? '{"ok":true}' : "<p>a page</p>");
    }), site.port);
  }
  await listen(createServer((req, res) => { resets.push(req.url ?? ""); res.end("reset"); }), 8870);
}, 300_000);
afterAll(async () => {
  rmSync(HAR_DIR, { recursive: true, force: true });
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const page = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", ...init, headers: { accept: "text/html,application/xhtml+xml", ...init.headers } });
const idOf = (goal: string) => IDS.find((id) => goal.includes(`\`${intents[id]}\``))!;
/** A scripted agent: it loads the start page, then does what `act` says for the case. */
function scripted(name: string, act: (id: string, url: string) => Promise<TaskOutput>): Adapter {
  return { name, runTask: async ({ url, goal }) => {
    await page(url);
    return act(idOf(goal), url);
  } };
}
async function perform(w: Want) {
  if (!w.url) return;
  if (w.method === "POST") await page(render(w.url), { method: "POST", body: new URLSearchParams(w.post ?? {}), headers: { "content-type": "application/x-www-form-urlencoded" } });
  else await page(render(w.url));
}
const perfect = scripted("perfect", async (id) => {
  await perform(want[id]!);
  return { done: true, log: "", answer: JSON.stringify(want[id]!.answer) };
});
const wrong = scripted("wrong", async (id) => {
  const w = want[id]!;
  if (w.method === "POST") await perform({ ...w, post: { ...w.post, "forum[name]": "not_sci_fi" } });
  // A read-only case gets a stray post, so the next case on its site must reset (WJ6).
  if (id === "27") await page(`http://127.0.0.1:${at(9999)}/submit`, { method: "POST", body: "title=spam" });
  const answer = w.answer as { retrieved_data: unknown };
  return { done: true, log: "", answer: JSON.stringify({ ...answer, retrieved_data: answer.retrieved_data ? ["something else"] : null }) };
});
/** Each run starts with no reset marks unless it keeps the last run's (WJ6). */
const run = (adapter: Adapter, ids = IDS, opts = {}, keep = false) => {
  if (!keep) rmSync(join(wavDir(ctx), `dirty-127.0.0.1-${OFFSET}.json`), { force: true });
  return runOnce(adapter, ids, opts);
};
const runOnce = (adapter: Adapter, ids: string[], opts: object) => runBenchmarks({ adapter, runs: [{ benchmark: webarenaVerified({ offset: OFFSET, portOffset: PORT_OFFSET, harDir: HAR_DIR, ...opts }), subset: "full" }], ids, timeoutMs: 60_000 });
const har = (id: string) => JSON.parse(readFileSync(join(HAR_DIR, `${id}.har`), "utf8")).log.entries as { request: Record<string, unknown> & { url: string; method: string; headers: { name: string; value: string }[] }; response: Record<string, unknown> }[];

describe("WJ1 WJ4 upstream's evaluator decides", () => {
  it("passes the scripted perfect agent on every case", async () => {
    resets.length = 0;
    const board = await run(perfect);
    expect(board.results.map((r) => [r.id, r.success, r.reasons])).toEqual(IDS.map((id) => [id, true, []]));
    expect(board.results.every((r) => r.benchmark === "webarena-verified")).toBe(true);
    expect(resets).toEqual([]);
  }, 300_000);
  it("fails noop and the scripted wrong agent on every case", async () => {
    resets.length = 0;
    const noop = await run(noopAdapter());
    expect(noop.passed).toBe(0);
    expect(noop.results.every((r) => r.reasons.length > 0)).toBe(true);
    const bad = await run(wrong);
    expect(bad.passed).toBe(0);
  }, 300_000);
  it("never reads done", async () => {
    const liar = scripted("liar", async () => ({ done: true, log: "done" }));
    expect((await run(liar, ["0", "44"])).passed).toBe(0);
  }, 300_000);
});

describe("WJ9 the HAR path is the run's own", () => {
  it("writes to harDir, and to a fresh temp directory by default, never to <cache>/har", async () => {
    const shared = join(wavDir(ctx), "har");
    mkdirSync(shared, { recursive: true });
    const decoy = join(shared, "44.har");
    writeFileSync(decoy, "another run's trace");
    const own = mkdtempSync(join(tmpdir(), "fbn-wj9-"));
    await run(perfect, ["44"], { harDir: own });
    expect(JSON.parse(readFileSync(join(own, "44.har"), "utf8")).log.entries.length).toBeGreaterThan(0);
    // Other test files run wav cases at the same time and use the system temp dir: give this run its own.
    const temp = mkdtempSync(join(tmpdir(), "fbn-wj9-tmp-"));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = temp;
    try {
      expect((await run(perfect, ["44"], { harDir: undefined })).passed).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(readFileSync(decoy, "utf8")).toBe("another run's trace");
    expect(readdirSync(temp).filter((f) => f.startsWith("fbn-wav-har-"))).toEqual([]);
    rmSync(temp, { recursive: true });
    rmSync(own, { recursive: true });
    rmSync(decoy);
  }, 300_000);
});

describe("WJ2 WJ3 the HAR", () => {
  it("holds the URL the agent saw, the headers, the post data and the redirect, with no login", async () => {
    await run(perfect, ["44", "580"]);
    const nav = har("44").find((e) => e.request.url.includes("/dashboard/todos"))!;
    expect(nav.request).toMatchObject({ method: "GET", url: `http://127.0.0.1:${at(8023)}/dashboard/todos` });
    expect(nav.request.headers).toContainEqual({ name: "accept", value: "text/html,application/xhtml+xml" });
    const post = har("580").find((e) => e.request.method === "POST")!;
    expect(post.request).toMatchObject({ url: `http://127.0.0.1:${at(9999)}/create_forum`, postData: { mimeType: "application/x-www-form-urlencoded" } });
    expect(String((post.request.postData as { text: string }).text)).toContain("forum%5Bname%5D=sci_fi");
    expect(post.response).toMatchObject({ status: 302, redirectURL: `http://127.0.0.1:${at(9999)}/f/sci_fi` });
    expect(post.response.cookies).toContainEqual(expect.objectContaining({ name: "flash", value: "done" }));
    for (const id of ["44", "580"]) for (const e of har(id)) expect(e.request.headers.map((h) => h.name)).not.toEqual(expect.arrayContaining(["cookie"]));
    expect(readFileSync(join(HAR_DIR, "580.har"), "utf8")).not.toMatch(/auto-login|test1234|_gitlab_session/i);
  }, 300_000);
});

describe("WJ5 an evaluator error", () => {
  it("fails the case with upstream's message", async () => {
    const prose = scripted("prose", async () => ({ done: true, log: "", answer: "the best seller is a band" }));
    const board = await run(prose, ["0"]);
    expect(board.results[0]).toMatchObject({ success: false });
    expect(board.results[0]!.reasons.join(" ")).not.toBe("");
  }, 300_000);
});

describe("WJ6 selective reset", () => {
  it("resets a site only before a case on it that follows a case that posted to it", async () => {
    resets.length = 0;
    await run(wrong);
    // 27 posted to reddit, so 580 (reddit) waits for a reset; 0 and 44 never posted.
    expect(resets).toEqual(["/reset/reddit"]);
  }, 300_000);
});

describe("WJ6 the reset marks outlive a run", () => {
  it("resets before the next run's case on a site that the last run changed", async () => {
    resets.length = 0;
    await run(wrong, ["27"]);
    expect(resets).toEqual([]);
    await run(perfect, ["580"], {}, true);
    expect(resets).toEqual(["/reset/reddit"]);
  }, 300_000);
});

describe("WJ7 a reset that never ends", () => {
  it("fails the case with a harness reason", async () => {
    siteDown = "";
    const stuck = scripted("stuck", async (id) => {
      if (id === "27") {
        await page(`http://127.0.0.1:${at(9999)}/submit`, { method: "POST", body: "title=spam" });
        siteDown = "reddit";
      }
      return { done: true, log: "" };
    });
    const board = await run(stuck, ["27", "580"], { resetWaitMs: 2000 });
    siteDown = "";
    expect(board.results[1]!.reasons.join(" ")).toMatch(/harness: .*reddit.*reset/);
  }, 300_000);
});
