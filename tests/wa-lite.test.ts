// Tests for the WebArena-Lite failure modes in docs/failure-modes.md (LI1-LI8).
// Real Lite cases run through the run loop with scripted agents against fake
// sites on the tunnel ports, a fake judge and a fake judge browser. The task
// list is the real one, fetched at the pinned commit.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter, type TaskOutput } from "../src/adapter.js";
import type { Judge } from "../src/bench/judge.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { LITE_REF, liteBenchmark } from "../src/bench/wa/lite.js";
import type { JudgeBrowser } from "../src/bench/wa/page.js";
import { wavSites } from "../src/bench/wav/index.js";
import { freeBase } from "./free-base.js";

// Below the OS ephemeral range, where a listen(0) server in a parallel test file can hold a port.
const OFFSET = await freeBase(21500, 1000, [...wavSites.flatMap((s) => [s.port, s.ctrlPort]), 8870]);
// The ports the agent sees (the proxies') are moved too, so no other test file can hold them.
const PORT_OFFSET = await freeBase(16800, 1000, wavSites.map((s) => s.port));
const at = (port: number) => port + PORT_OFFSET;
const ctx = benchContext();
const servers: Server[] = [];
const seen: { port: number; method: string; headers: IncomingHttpHeaders }[] = [];
let changed = false;

interface Raw { task_id: number; intent: string; sites: string[]; start_url: string; eval: { eval_types: string[]; reference_answers?: Record<string, string | string[]>; reference_url?: string; string_note?: string; program_html?: { url: string; locator: string; required_contents: Record<string, string | string[]> }[] } }
let raw: Raw[] = [];

/** A fake judge browser: its page shows what a task wants only after the agent changed the site (a POST). */
const visits: { url: string; asked: string; site: IncomingHttpHeaders }[] = [];
const browserLog = { pages: 0, closedPages: 0, closed: 0 };
function fakeBrowser(_ctx: unknown, origins: Record<string, string>): JudgeBrowser {
  let task: Raw | undefined;
  return {
    async page() {
      browserLog.pages++;
      return {
        async goto(url) {
          const origin = new URL(url).origin;
          const asked = origins[origin] ? origins[origin] + url.slice(origin.length) : url;
          task = raw.find((t) => t.task_id === browserTask);
          const res = await fetch(asked);
          visits.push({ url, asked, site: JSON.parse(await res.text()) });
        },
        async evaluate(js) {
          const target = task?.eval.program_html?.find((p) => p.locator && js.includes(p.locator));
          if (!changed || !target) return "";
          const want = target.required_contents.exact_match ?? target.required_contents.must_include;
          return Array.isArray(want) ? want.join(", ") : want;
        },
        content: async () => (changed ? (task?.eval.program_html ?? []).flatMap((p) => [p.required_contents.must_include ?? p.required_contents.exact_match ?? ""].flat()).join("\n") : ""),
      };
    },
    closePages: async () => { browserLog.closedPages++; },
    close: async () => { browserLog.closed++; },
  };
}
let browserTask = -1;

const simple2 = (t: Raw) => t.sites.includes("gitlab") && t.sites.includes("reddit") && t.start_url === "__GITLAB__";
const simple = (t: Raw) => t.sites.length === 1 && wavSites.some((s) => s.id === t.sites[0]) && !t.start_url.includes("|AND|");
const only = (t: Raw, types: string[]) => t.eval.eval_types.join() === types.join();
const plain = (c?: Record<string, string | string[]>) => Object.keys(c ?? {}).every((k) => k === "must_include" || k === "exact_match");
let stringTask: Raw, urlTask: Raw, htmlTask: Raw, fuzzyTask: Raw;

async function listen(server: Server, port: number) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(port + OFFSET, "127.0.0.1", r));
}
const resets: string[] = [];
beforeAll(async () => {
  const cases = await liteBenchmark({ offset: OFFSET, portOffset: PORT_OFFSET }).load(ctx, "full");
  expect(cases).toHaveLength(165);
  raw = JSON.parse(readFileSync(join(ctx.cacheDir, `webarena-lite-${LITE_REF.slice(0, 12)}`, "tasks.json"), "utf8"));
  const find = (f: (t: Raw) => boolean) => raw.find((t) => simple(t) && f(t))!;
  stringTask = find((t) => only(t, ["string_match"]) && plain(t.eval.reference_answers) && !JSON.stringify(t.eval).includes("fuzzy"));
  urlTask = find((t) => only(t, ["url_match"]) && !t.eval.reference_url!.includes("|OR|") && t.sites[0] !== stringTask.sites[0]);
  htmlTask = find((t) => only(t, ["program_html"]) && t.eval.program_html!.every((p) => !p.url.startsWith("func") && p.url !== "last" && !p.locator.startsWith("func") && plain(p.required_contents)) && ![stringTask, urlTask].some((o) => o.sites[0] === t.sites[0]));
  fuzzyTask = find((t) => only(t, ["string_match"]) && Array.isArray(t.eval.reference_answers?.fuzzy_match) && ![stringTask, urlTask, htmlTask].some((o) => o.sites[0] === t.sites[0]));
  for (const site of wavSites) {
    await listen(createServer((_req, res) => res.end(JSON.stringify({ success: true }))), site.ctrlPort);
    await listen(createServer((req, res) => {
      req.resume();
      // GitLab's sign-in form and session, as wavStart's login reads them.
      if (site.id === "gitlab" && req.url === "/users/sign_in") {
        if (req.method === "GET") return res.writeHead(200, { "set-cookie": "_gitlab_session=anon" }).end('<input name="authenticity_token" value="t">');
        return res.writeHead(302, { location: "/", "set-cookie": "_gitlab_session=in" }).end();
      }
      if (req.method === "POST") changed = true;
      // The site answers with the headers it got, so a test sees what the proxies added.
      seen.push({ port: site.port, method: req.method ?? "GET", headers: req.headers });
      res.writeHead(200, { "content-type": "text/html" }).end(JSON.stringify(req.headers));
    }), site.port);
  }
  await listen(createServer((req, res) => { resets.push(req.url ?? ""); res.end("reset"); }), 8870);
}, 300_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const bench = () => liteBenchmark({ offset: OFFSET, portOffset: PORT_OFFSET, browser: fakeBrowser, settleMs: 0, resetWaitMs: 2000 });
const SITE: Record<string, string> = { __SHOPPING__: `http://127.0.0.1:${at(7770)}`, __SHOPPING_ADMIN__: `http://127.0.0.1:${at(7780)}/admin`, __REDDIT__: `http://127.0.0.1:${at(9999)}`, __GITLAB__: `http://127.0.0.1:${at(8023)}` };
const render = (url: string) => url.replace(/^__[A-Z_]+__/, (m) => SITE[m]!);
const page = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", ...init, headers: { accept: "text/html", connection: "close", ...init.headers } });
const idOf = (goal: string) => raw.find((t) => goal.includes(t.intent))!;
function scripted(name: string, act: (t: Raw) => Promise<TaskOutput>): Adapter {
  return { name, runTask: async ({ url, goal }) => { await page(url); return act(idOf(goal)); } };
}
const refAnswer = (t: Raw) => [t.eval.reference_answers?.exact_match ?? [t.eval.reference_answers?.must_include ?? t.eval.reference_answers?.fuzzy_match ?? ""].flat().map((a) => String(a).split(" |OR| ")[0]).join(", ")].flat().join("");
const perfect = scripted("perfect", async (t) => {
  if (t.eval.eval_types.includes("url_match")) await page(render(t.eval.reference_url!));
  if (t.eval.eval_types.includes("program_html")) await page(render(t.start_url), { method: "POST", body: "x=1" });
  return { done: true, log: "", answer: t.eval.eval_types.includes("string_match") ? refAnswer(t) : "" };
});
const wrong = scripted("wrong", async () => ({ done: true, log: "", answer: "something else entirely" }));
const run = (adapter: Adapter, ids: Raw[], judges?: Judge[]) => {
  changed = false;
  browserTask = ids.find((t) => t.eval.program_html?.length)?.task_id ?? -1;
  return runBenchmarks({ adapter, runs: [{ benchmark: bench(), subset: "full" }], ids: ids.map((t) => String(t.task_id)), timeoutMs: 60_000, ...(judges ? { judges } : {}) });
};
const fair: Judge = { name: "claude", model: "fake-model", where: "cloud", ask: async ({ prompt }) => (/student answer: (.*)/.exec(prompt)?.[1]?.includes("good") ? "correct" : "incorrect") };

describe("LI1 LI2 the task list", () => {
  it("is the 165 pinned tasks, whole in the cache, with their ids, tags and judge marks", async () => {
    const cases = await bench().load(ctx, "full");
    expect(cases.map((c) => c.id)).toEqual(Array.from({ length: 165 }, (_, i) => String(i)));
    const dir = join(ctx.cacheDir, `webarena-lite-${LITE_REF.slice(0, 12)}`);
    expect(existsSync(join(dir, "tasks.json"))).toBe(true);
    expect(readdirSync(dir).filter((f) => f !== "tasks.json")).toEqual([]);
    expect(bench().scoring).toBe("mixed");
    expect(cases.filter((c) => c.judge === "llm")).toHaveLength(40);
    expect(cases.filter((c) => c.tags.includes("map"))).toHaveLength(31);
    expect(cases.filter((c) => c.tags.includes("program_html"))).toHaveLength(67);
    expect(cases.find((c) => c.id === "0")!.tags).toEqual(["shopping_admin", "string_match"]);
  });
});

describe("LI3 start URLs and missing sites", () => {
  it("names the other start URLs in the goal, and fails a map case with the wav-full reason", async () => {
    const b = bench();
    const env = await b.up(ctx);
    const many = raw.find((t) => t.start_url.includes("|AND|"))!;
    const episode = await b.start(env, { id: String(many.task_id), tags: [] });
    const [first, ...rest] = many.start_url.split(" |AND| ");
    expect(episode.startPath).toBe(new URL(render(first!)).pathname);
    for (const other of rest) expect(episode.goal).toContain(new URL(render(other)).pathname);
    await episode.close?.();
    // A task on more sites than its start URLs name (gitlab and reddit, started on gitlab) gets the other site's proxy and login too.
    const more = raw.find((t) => simple2(t))!;
    seen.length = 0;
    const second = await b.start(env, { id: String(more.task_id), tags: [] });
    expect(second.goal).toContain(`127.0.0.1:${at(9999)}`);
    await page(`http://127.0.0.1:${at(9999)}/`);
    expect(seen.find((r) => r.port === 9999)!.headers["x-postmill-auto-login"]).toBeDefined();
    await second.close?.();
    const map = raw.find((t) => t.sites.includes("map"))!;
    await expect(b.start(env, { id: String(map.task_id), tags: [] })).rejects.toThrow(/map.*wav-full/);
    await b.down(env);
  });
});

describe("LI4 LI5 LI6 LI7 scoring", () => {
  it("passes the scripted perfect agent on string, url and program_html cases, and fails noop and the wrong agent", async () => {
    const ids = [stringTask, urlTask, htmlTask];
    const board = await run(perfect, ids);
    expect(board.results.map((r) => [r.id, r.success, r.reasons])).toEqual(ids.map((t) => [String(t.task_id), true, []]));
    expect((await run(noopAdapter(), ids)).passed).toBe(0);
    expect((await run(wrong, ids)).passed).toBe(0);
    const liar = scripted("liar", async () => ({ done: true, log: stringTask.intent }));
    expect((await run(liar, [stringTask])).passed).toBe(0);
  }, 300_000);
  it("reads the page the agent ended on, not one it passed through", async () => {
    const ended = scripted("ended", async (t) => { await page(render(t.eval.reference_url!)); await page(`${render(t.start_url)}/elsewhere`); return { done: true, log: "" }; });
    expect((await run(ended, [urlTask])).passed).toBe(0);
  }, 120_000);
  it("takes the page load of a browser as the final page, not a later HTML request that is not a page", async () => {
    const xhr = scripted("xhr", async (t) => {
      await page(render(t.eval.reference_url!), { headers: { "sec-fetch-dest": "document" } });
      await page(`${render(t.start_url)}/fragment`, { headers: { "sec-fetch-dest": "empty" } });
      return { done: true, log: "" };
    });
    expect((await run(xhr, [urlTask])).passed).toBe(1);
  }, 120_000);
  it("opens program_html targets on a judge proxy with the site's login, and only for cases that need it", async () => {
    browserLog.pages = 0; browserLog.closedPages = 0; visits.length = 0; seen.length = 0;
    await run(perfect, [stringTask, urlTask]);
    expect(browserLog.pages).toBe(0);
    await run(perfect, [htmlTask]);
    expect(browserLog.pages).toBe(1);
    expect(browserLog.closedPages).toBeGreaterThanOrEqual(1);
    const visit = visits[0]!;
    expect(new URL(visit.asked).port).not.toBe(new URL(visit.url).port);
    // The site saw the login the proxy added and its own Host; the agent's request had neither.
    const login = Object.keys(visit.site).filter((k) => /auto-login|cookie/.test(k));
    expect(login.length).toBeGreaterThan(0);
    expect(visit.site.host).toBe(`127.0.0.1:${new URL(visit.url).port}`);
    await expect(fetch(visit.asked)).rejects.toThrow();
    const env = await bench().up(ctx);
    await bench().down(env);
    expect(browserLog.closed).toBeGreaterThanOrEqual(1);
  }, 300_000);
  it("sends a fuzzy case to the judges, and fails it with no judge", async () => {
    const good = scripted("good", async () => ({ done: true, log: "", answer: "good answer" }));
    const none = await run(good, [fuzzyTask]);
    expect(none.results[0]).toMatchObject({ success: false });
    expect(none.results[0]!.reasons[0]).toBe("judge: no judge");
    const judged = await run(good, [fuzzyTask], [fair]);
    expect(judged.results[0]).toMatchObject({ success: true, judges: [{ judge: "claude", model: "fake-model", success: true }] });
    expect(judged.judges).toMatchObject({ "claude": { model: "fake-model", cases: 1, passed: 1 } });
    expect((await run(wrong, [fuzzyTask], [fair])).passed).toBe(0);
  }, 120_000);
});

describe("LI8 the quick subset", () => {
  it("is the committed 20 ids, on wav-core sites only", async () => {
    const list = JSON.parse(readFileSync(join(import.meta.dirname, "../src/bench/subsets/webarena-lite.json"), "utf8")).quick as string[];
    const quick = await bench().load(ctx, "quick");
    expect(quick.map((c) => c.id)).toEqual(list);
    expect(list).toHaveLength(20);
    expect(quick.every((c) => c.tags.every((t) => t !== "map" && t !== "wikipedia" && t !== "multi-site"))).toBe(true);
  });
});
