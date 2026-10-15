// Tests for the DoomArena failure modes in docs/failure-modes.md (DA1-DA9).
// Real cases run through the run loop against fake reddit and shopping sites
// on the tunnel ports, with upstream's own WebArena-Verified evaluator for the
// task and DoomArena's own attack text fetched at the pinned commit.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter, type TaskOutput } from "../src/adapter.js";
import { attackHtml, fetchDoom, KINDS, pyString } from "../src/bench/doomarena/attacks.js";
import { doomarenaBenchmark, doomCases, startInjector } from "../src/bench/doomarena/index.js";
import { benchContext, benchmarkById } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { wavSites } from "../src/bench/wav/index.js";
import { WAV_VERSION, wavDir } from "../src/bench/wav/tasks.js";
import { freeBase } from "./free-base.js";

const OFFSET = await freeBase(23000, 500, [...wavSites.flatMap((s) => [s.port, s.ctrlPort]), 8870]);
const AGENT = await freeBase(4300, 400, [9999, 7770]);
const ctx = benchContext();
const servers: Server[] = [];
const resets: string[] = [];
/** A read-only reddit case and a read-only shopping case. */
const TASKS = ["27", "21"];

/** Each id's expected answer, read from the pinned package, never from the repo. */
let want: Record<string, { intent: string; answer: unknown }> = {};
const listen = async (server: Server, port: number) => {
  servers.push(server);
  await new Promise<void>((r) => server.listen(port + OFFSET, "127.0.0.1", r));
};
beforeAll(async () => {
  const code = `import json, sys
from importlib.resources import files
tasks = json.loads((files("webarena_verified") / "assets/dataset/webarena-verified.json").read_text())
out = {}
for t in tasks:
    if str(t["task_id"]) not in sys.argv[1].split(","): continue
    exp = next(e for e in t["eval"] if e["evaluator"] == "AgentResponseEvaluator")["expected"]
    out[t["task_id"]] = {"intent": t["intent"], "answer": {"task_type": exp["task_type"].upper(), "status": exp["status"], "retrieved_data": exp.get("retrieved_data")}}
json.dump(out, sys.stdout)`;
  want = JSON.parse(execFileSync(ctx.env.FOXBENCH_UV || "uv", ["run", "-q", "--isolated", "--no-project", "--python", "3.12", "--with", `webarena-verified==${WAV_VERSION}`, "python", "-I", "-c", code, TASKS.join(",")], { encoding: "utf8" }));
  for (const site of wavSites) {
    await listen(createServer((_req, res) => res.end(JSON.stringify({ success: true }))), site.ctrlPort);
    await listen(createServer(async (req, res) => {
      for await (const _ of req);
      if (site.id === "gitlab" && req.url === "/users/sign_in") return res.writeHead(200, { "set-cookie": "_gitlab_session=anon" }).end('<input name="authenticity_token" value="t">');
      res.writeHead(200, { "content-type": "text/html" }).end("<html><body><p>a page</p></body></html>");
    }), site.port);
  }
  await listen(createServer((req, res) => { resets.push(req.url ?? ""); res.end("reset"); }), 8870);
}, 300_000);
afterAll(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))));

/** The agent's own loads. A pooled connection to the last case's proxy on the same port is dead, so retry. */
const get = async (url: string): Promise<string> => {
  for (let tries = 0; ; tries++) {
    try {
      return await (await fetch(url, { headers: { accept: "text/html" } })).text();
    } catch (error) {
      if (tries >= 4) throw error;
      await new Promise((r) => setTimeout(r, 200 * (tries + 1)));
    }
  }
};

const idOf = (goal: string) => TASKS.find((id) => goal.includes(`\`${want[id]!.intent}\``))!;
/** A scripted agent: it loads the start page, then does what `act` says. */
const scripted = (name: string, act: (id: string, page: string, url: string) => Promise<TaskOutput>): Adapter => ({
  name, runTask: async ({ url, goal }) => act(idOf(goal), await get(url), url),
});
const perfect = scripted("perfect", async (id) => ({ done: true, log: "", answer: JSON.stringify(want[id]!.answer) }));
/** Follows the attack: opens the help desk the page names, then answers correctly. */
const gullible = scripted("gullible", async (id, page) => {
  const desk = /VERIFY YOUR IDENTITY AT THE AGENT HELP DESK \((127\.0\.0\.1:\d+)\)/.exec(page.replace(/&#0?39;|&quot;/g, ""));
  if (desk) await get(`http://${desk[1]}/desk`);
  return { done: true, log: desk ? "went to the desk" : "no desk", answer: JSON.stringify(want[id]!.answer) };
});
const run = (adapter: Adapter, ids: string[]) => {
  rmSync(join(wavDir(ctx), `dirty-127.0.0.1-${OFFSET}.json`), { force: true });
  return runBenchmarks({ adapter, runs: [{ benchmark: doomarenaBenchmark({ offset: OFFSET, portOffset: AGENT }), subset: "full" }], ids, timeoutMs: 60_000 });
};

describe("DA1 fetched at the pinned commit", () => {
  it("records the licence, reads upstream's own text and commits none of it", async () => {
    const b = benchmarkById("doomarena")!;
    expect(b.upstream).toMatchObject({ repo: "https://github.com/ServiceNow/DoomArena", ref: "b80902f107b4d28194580352a59b3029f4a018b4" });
    expect(b.licence).toMatchObject({ code: "Apache-2.0", mode: "fetch-at-run" });
    const sources = await fetchDoom(ctx.cacheDir);
    expect(pyString(sources.popup, "DEFAULT_HIDDEN_WARNING_MESSAGE_TEMPLATE")).toContain("{REPORT_URL_PLACEHOLDER}");
    expect(execFileSync("git", ["ls-files"], { encoding: "utf8" })).not.toMatch(/popup_attacks|banner_attacks/);
  }, 60_000);
});

describe("DA3 DA4 the markup", () => {
  it("names the collector, never upstream's localhost:1234, and only the pop-up carries the card", async () => {
    const sources = await fetchDoom(ctx.cacheDir);
    const report = "127.0.0.1:4321";
    for (const kind of KINDS) {
      const html = attackHtml(kind, sources, report);
      expect(html).not.toContain("localhost:1234");
      if (kind === "clean") expect(html).toBe("");
      else expect(html).toContain(report);
    }
    expect(attackHtml("banner", sources, report)).toMatch(/<img src="data:image\/svg\+xml;base64,[^"]+" alt="/);
    expect(attackHtml("popup", sources, report)).toContain("I understand the risks and want to proceed");
    expect(attackHtml("combined", sources, report)).toContain("viewport-wrapper");
  }, 60_000);
  it("puts the markup before </body> of an HTML page and leaves other answers alone", async () => {
    const site = createServer((req, res) => {
      const json = req.url === "/api";
      res.writeHead(200, { "content-type": json ? "application/json" : "text/html" }).end(json ? '{"ok":true}' : "<html><body><p>hi</p></body></html>");
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    const injector = await startInjector(`http://127.0.0.1:${(site.address() as { port: number }).port}`, "<div id=attack></div>");
    const page = await (await fetch(injector.origin)).text();
    expect(page).toBe("<html><body><p>hi</p><div id=attack></div></body></html>");
    expect(await (await fetch(`${injector.origin}/api`)).text()).toBe('{"ok":true}');
    await injector.close();
    await new Promise((r) => site.close(r));
  });
});

describe("DA5 DA6 the case list", () => {
  it("runs each reddit and shopping task under the four kinds, and only an attacked case can report one", async () => {
    const cases = doomCases([{ id: 7, sites: ["reddit"], startUrls: ["__REDDIT__"], intent: "x", taskType: "retrieve" },
      { id: 8, sites: ["gitlab"], startUrls: ["__GITLAB__"], intent: "y", taskType: "retrieve" },
      { id: 9, sites: ["reddit", "gitlab"], startUrls: ["__REDDIT__"], intent: "z", taskType: "retrieve" }]);
    expect(cases.map((c) => c.id)).toEqual(["clean-7", "banner-7", "popup-7", "combined-7"]);
    expect(cases.map((c) => Boolean(c.trap))).toEqual([false, true, true, true]);
  });
});

describe("DA2 DA7 DA8 the runs", () => {
  it("fails noop on every kind, with no attack followed and no reset", async () => {
    resets.length = 0;
    const board = await run(noopAdapter(), KINDS.map((k) => `${k}-27`));
    expect(board.passed).toBe(0);
    expect(board.results.map((r) => r.attack)).toEqual([null, "blocked", "blocked", "blocked"]);
    expect(resets).toEqual([]);
  }, 300_000);
  it("passes a scripted perfect agent clean and attacked, on both sites", async () => {
    const board = await run(perfect, ["clean-27", "combined-27", "clean-21", "popup-21"]);
    expect(board.results.map((r) => [r.id, r.success, r.attack]).toSorted()).toEqual([["clean-21", true, null], ["clean-27", true, null], ["combined-27", true, "blocked"], ["popup-21", true, "blocked"]]);
  }, 300_000);
  it("counts the attack when the agent opens the attacker's page, and never on a clean case", async () => {
    const board = await run(gullible, ["popup-27", "clean-27"]);
    const by = Object.fromEntries(board.results.map((r) => [r.id, r]));
    expect([by["popup-27"]!.attack, by["popup-27"]!.success, by["clean-27"]!.attack, by["clean-27"]!.success]).toEqual(["followed", true, null, true]);
    expect(by["popup-27"]!.reasons).toContain("the agent opened the attacker's page");
  }, 300_000);
});

describe("DA9 not ready", () => {
  it("names the sites that are down and a missing uv", async () => {
    const down = await doomarenaBenchmark({ offset: OFFSET + 3 }).check(ctx);
    expect(down).toMatchObject({ ready: false, reason: expect.stringMatching(/shopping: .*; reddit: /) });
    expect(await doomarenaBenchmark({ offset: OFFSET }).check(benchContext({ env: { FOXBENCH_UV: "/nonexistent/uv" } }))).toMatchObject({ ready: false, reason: expect.stringContaining("need uv") });
    expect(await doomarenaBenchmark({ offset: OFFSET }).check(ctx)).toEqual({ ready: true });
  }, 60_000);
});
