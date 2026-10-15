// Tests for the WebChoreArena failure modes in docs/failure-modes.md (WC1-WC9).
// The evaluators run on scripted answers and pages with a fake judge; real
// cases run through the run loop against fake sites on the tunnel ports. The
// task list is the real one, fetched at the pinned commit.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter, type TaskOutput } from "../src/adapter.js";
import type { Judge } from "../src/bench/judge.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { CHORE_REF, choreBenchmark } from "../src/bench/wa/chore.js";
import { scoreChore } from "../src/bench/wa/chore-eval.js";
import type { WaFacts, WaPage, WaTask } from "../src/bench/wa/eval.js";
import type { JudgeBrowser } from "../src/bench/wa/page.js";
import { wavSites } from "../src/bench/wav/index.js";
import { freeBase } from "./free-base.js";

const task = (e: Partial<WaTask["eval"]> & Record<string, unknown>, intent = "the question"): WaTask => ({ intent, eval: { eval_types: ["string_match"], ...e } });
const facts = (over: Partial<WaFacts> = {}): WaFacts => ({ answer: "", finalUrl: undefined, judges: [], settleMs: 0, ...over });
const check = async (t: WaTask, f: Partial<WaFacts>) => scoreChore(t, facts(f));
function judge(says: (prompt: string) => string = () => "correct") {
  const asked: string[] = [];
  const j: Judge = { name: "claude", model: "fake-model", where: "cloud", ask: async ({ prompt }) => { asked.push(prompt); return says(prompt); } };
  return { j, asked };
}
const pageOf = (pages: Record<string, { html?: string; js?: Record<string, unknown> }>): WaPage => {
  let at = "";
  return {
    goto: async (url) => { if (!pages[url]) throw new Error(`no page ${url}`); at = url; },
    evaluate: async (js) => { const hit = Object.entries(pages[at]?.js ?? {}).find(([k]) => js.includes(k)); if (!hit) throw new Error("no such element"); return hit[1]; },
    content: async () => pages[at]?.html ?? "",
  };
};

describe("WC3 must_include", () => {
  const list = task({ reference_answers: { must_include: ["red |or| blue", "large", "cotton"] } });
  it("scores the mean over the entries, and succeeds only at 1", async () => {
    expect(await check(list, { answer: "a blue large cotton shirt" })).toMatchObject({ success: true, score: 1 });
    const part = await check(list, { answer: "a blue large shirt" });
    expect(part).toMatchObject({ success: false });
    expect(part.score).toBeCloseTo(2 / 3);
    expect(part.reasons[0]).toContain("cotton");
    expect((await check(list, { answer: "" })).score).toBe(0);
  });
  it("reads a single one-character value as a whole token", async () => {
    const one = task({ reference_answers: { must_include: ["5"] } });
    expect((await check(one, { answer: "15 items" })).success).toBe(false);
    expect((await check(one, { answer: "5 items" })).success).toBe(true);
    expect((await check(task({ reference_answers: { must_include: ["55"] } }), { answer: "155 items" })).success).toBe(true);
  });
});

const urlCase = (ref: string, extra: object = {}) => task({ eval_types: ["url_match"], reference_url: ref, ...extra });

describe("WC4 url_match", () => {
  it("matches host and path inside the final URL, ignoring case and a trailing slash, and needs the query values", async () => {
    const t = urlCase("http://127.0.0.1:7780/admin/Sales/order |OR| http://127.0.0.1:7780/admin/reports");
    expect((await check(t, { finalUrl: "http://127.0.0.1:7780/admin/sales/order/view/3/" })).success).toBe(true);
    expect((await check(t, { finalUrl: "http://127.0.0.1:7770/admin/sales/order" })).success).toBe(false);
    const q = urlCase("http://127.0.0.1:7780/admin/reports?period=day");
    expect((await check(q, { finalUrl: "http://127.0.0.1:7780/admin/reports?x=1&period=day" })).success).toBe(true);
    expect((await check(q, { finalUrl: "http://127.0.0.1:7780/admin/reports?period=week" })).success).toBe(false);
    // As upstream does, the query keys of every `|OR|` reference are required together.
    expect((await check(urlCase("http://x/a |OR| http://x/b?k=1"), { finalUrl: "http://x/a" })).success).toBe(false);
  });
  it("takes the best of the `or` references, and fails another rule or no page", async () => {
    const t = urlCase("http://127.0.0.1:9999/f/a", { or: [{ reference_url: "http://127.0.0.1:9999/f/b" }] });
    expect((await check(t, { finalUrl: "http://127.0.0.1:9999/f/b/1" })).success).toBe(true);
    expect((await check(urlCase("http://x/a", { url_note: "EXACT" }), { finalUrl: "http://x/a" })).reasons[0]).toContain("unsupported url_note EXACT");
    expect((await check(t, {})).reasons[0]).toContain("opened no page");
  });
});

const html = (targets: object[]) => task({ eval_types: ["program_html"], program_html: targets as WaTask["eval"]["program_html"] });
const target = (over: object) => ({ url: "http://127.0.0.1:9999/p", locator: "document.querySelector('#v').innerText", required_contents: { exact_match: "a & b" }, ...over });

describe("WC5 program_html", () => {
  it("reads each target in the judge browser, unescaped, with the best of its `or` alternatives", async () => {
    const page = pageOf({ "http://127.0.0.1:9999/p": { js: { "#v": "A &amp; B" } }, "http://127.0.0.1:9999/q": { html: "total: 3" } });
    expect((await check(html([target({})]), { page: async () => page })).success).toBe(true);
    const alt = target({ required_contents: { exact_match: "nope" }, or: [{ url: "http://127.0.0.1:9999/q", locator: "", required_contents: { must_include: ["total: 3"] } }] });
    expect((await check(html([alt]), { page: async () => page })).success).toBe(true);
  });
  it("unescapes entities, and leaves an unknown one or a bad code point as it is", async () => {
    const page = pageOf({ "http://127.0.0.1:9999/p": { html: "price: &euro;5 &#x41; &bogus; &#1114112;" } });
    const has = (want: string) => check(html([target({ locator: "", required_contents: { must_include: [want] } })]), { page: async () => page });
    expect((await has("price: \u20ac5 a &bogus; &#1114112;")).success).toBe(true);
  });
  it("multiplies the targets, takes a mean over must_include, and fails an unknown key by name", async () => {
    const page = pageOf({ "http://127.0.0.1:9999/p": { html: "one two" } });
    const two = html([target({ locator: "", required_contents: { must_include: ["one", "three |OR| two"] } }), target({ locator: "", required_contents: { must_include: ["one", "nine"] } })]);
    const r = await check(two, { page: async () => page });
    expect(r.success).toBe(false);
    expect(r.score).toBeCloseTo(0.5);
    expect((await check(html([target({ required_contents: { fuzzy_match: ["x"] } })]), { page: async () => page })).reasons[0]).toContain("unsupported");
  });
});

describe("WC6 fuzzy_match", () => {
  const t = task({ reference_answers: { fuzzy_match: ["tops: 3", "bottoms: 2"] } }, "Count them");
  it("uses WebChoreArena's prompt with a `; ` join, marks the case llm, and fails with no judge", async () => {
    const { j, asked } = judge();
    expect(await check(t, { answer: "tops: 3, bottoms: 2", judges: [j] })).toMatchObject({ success: true, llm: true, score: 1 });
    expect(asked[0]).toContain("reference answer: tops: 3; bottoms: 2\n");
    expect(asked[0]).toContain("The goal is to evaluate whether the key points in the reference answer are included");
    expect((await check(t, { answer: "x" })).reasons[0]).toBe("judge: no judge");
    expect((await check(t, { answer: "x", judges: [judge(() => "partially correct").j] })).success).toBe(false);
  });
  it("never asks about an empty answer", async () => {
    const { j, asked } = judge();
    expect((await check(t, { answer: "", judges: [j] })).success).toBe(false);
    expect(asked).toEqual([]);
  });
});

// Below the OS ephemeral range, where a listen(0) server in a parallel test file can hold a port.
const OFFSET = await freeBase(21500, 1000, [...wavSites.flatMap((s) => [s.port, s.ctrlPort]), 8870]);
// The ports the agent sees (the proxies') are moved too, so no other test file can hold them.
const PORT_OFFSET = await freeBase(17900, 1000, wavSites.map((s) => s.port));
const at = (port: number) => port + PORT_OFFSET;
const ctx = benchContext();
const servers: Server[] = [];
let changed = false;
interface Raw { task_id: number; intent: string; sites: string[]; start_url: string; eval: { eval_types: string[]; reference_answers?: Record<string, string | string[]>; reference_url?: string; program_html?: { url: string; locator: string; required_contents: Record<string, string | string[]> }[] } }
let raw: Raw[] = [];
let browserTask = -1;
const fakeBrowser = (): JudgeBrowser => ({
  page: async () => {
    const targets = raw.find((t) => t.task_id === browserTask)?.eval.program_html ?? [];
    return { goto: async () => {}, content: async () => (changed ? targets.flatMap((p) => [p.required_contents.must_include ?? p.required_contents.exact_match ?? ""].flat()).join("\n") : ""),
      evaluate: async (js) => { const hit = targets.find((p) => p.locator && js.includes(p.locator)); const want = hit && (hit.required_contents.exact_match ?? hit.required_contents.must_include); return changed && want ? [want].flat().join(", ") : ""; } };
  },
  closePages: async () => {},
  close: async () => {},
});
const bench = () => choreBenchmark({ offset: OFFSET, portOffset: PORT_OFFSET, browser: fakeBrowser, settleMs: 0, resetWaitMs: 2000 });
const only = (t: Raw, types: string[]) => t.eval.eval_types.join() === types.join();
const plain = (t: Raw) => !JSON.stringify(t.eval).includes("fuzzy") && !JSON.stringify(t.eval).includes('"or"');
const refs = (t: Raw) => Object.keys(t.eval.reference_answers ?? {}).every((k) => k === "must_include" || k === "exact_match");
let stringTask: Raw, urlTask: Raw, htmlTask: Raw;

beforeAll(async () => {
  expect(await bench().load(ctx, "full")).toHaveLength(532);
  raw = JSON.parse(readFileSync(join(ctx.cacheDir, `webchorearena-${CHORE_REF.slice(0, 12)}`, "tasks.json"), "utf8"));
  const find = (f: (t: Raw) => boolean) => raw.find((t) => t.sites.length === 1 && wavSites.some((s) => s.id === t.sites[0]) && !t.start_url.includes("|AND|") && f(t))!;
  stringTask = find((t) => only(t, ["string_match"]) && plain(t) && refs(t));
  urlTask = find((t) => only(t, ["url_match"]) && plain(t) && t.sites[0] !== stringTask.sites[0]);
  htmlTask = find((t) => only(t, ["program_html"]) && plain(t) && t.eval.program_html!.every((p) => !p.url.startsWith("func") && p.url !== "last") && ![stringTask, urlTask].some((o) => o.sites[0] === t.sites[0]));
  for (const site of wavSites) {
    for (const [port, body] of [[site.ctrlPort, '{"success":true}'], [site.port, "<p>a page</p>"]] as const) {
      const server = createServer((req, res) => {
        req.resume();
        if (site.id === "gitlab" && req.url === "/users/sign_in") return req.method === "GET" ? res.writeHead(200, { "set-cookie": "_gitlab_session=a" }).end('<input name="authenticity_token" value="t">') : res.writeHead(302, { location: "/", "set-cookie": "_gitlab_session=b" }).end();
        if (req.method === "POST") changed = true;
        res.writeHead(200, { "content-type": "text/html" }).end(body);
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(port + OFFSET, "127.0.0.1", r));
    }
  }
  const reset = createServer((_req, res) => res.end("reset"));
  servers.push(reset);
  await new Promise<void>((r) => reset.listen(8870 + OFFSET, "127.0.0.1", r));
}, 300_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const SITE: Record<string, string> = { __SHOPPING__: `http://127.0.0.1:${at(7770)}`, __SHOPPING_ADMIN__: `http://127.0.0.1:${at(7780)}/admin`, __REDDIT__: `http://127.0.0.1:${at(9999)}`, __GITLAB__: `http://127.0.0.1:${at(8023)}` };
const render = (url: string) => url.replace(/^__[A-Z_]+__/, (m) => SITE[m]!);
const page = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", headers: { accept: "text/html", connection: "close" }, ...init });
const scripted = (name: string, act: (t: Raw) => Promise<TaskOutput>): Adapter => ({ name, runTask: async ({ url, goal }) => { await page(url); return act(raw.find((t) => goal.includes(t.intent))!); } });
const perfect = scripted("perfect", async (t) => {
  if (t.eval.eval_types.includes("url_match")) await page(render(t.eval.reference_url!));
  if (t.eval.eval_types.includes("program_html")) await page(render(t.start_url), { method: "POST", body: "x=1" });
  const ref = t.eval.reference_answers ?? {};
  return { done: true, log: "", answer: ref.exact_match ? String(ref.exact_match) : ([ref.must_include ?? []].flat()).map((a) => a.split(/ \|or\| /i)[0]).join(", ") };
});
const wrong = scripted("wrong", async () => ({ done: true, log: "", answer: "something else entirely" }));
const run = (adapter: Adapter, ids: Raw[]) => {
  changed = false;
  browserTask = ids.find((t) => t.eval.program_html?.length)?.task_id ?? -1;
  return runBenchmarks({ adapter, runs: [{ benchmark: bench(), subset: "full" }], ids: ids.map((t) => String(t.task_id)), timeoutMs: 60_000 });
};

describe("WC1 WC2 WC8 WC9 the task list", () => {
  it("is the 532 pinned tasks with the small set tagged, the tags, judge marks and the quick subset", async () => {
    const cases = await bench().load(ctx, "full");
    expect(cases.map((c) => c.id)).toEqual(raw.map((t) => String(t.task_id)));
    expect(cases.filter((c) => c.tags.includes("small"))).toHaveLength(102);
    expect(cases.filter((c) => c.judge === "llm")).toHaveLength(24);
    expect(cases.find((c) => c.id === "10000")!.tags).toEqual(expect.arrayContaining(["shopping_admin", "string_match", "others", "obs:any"]));
    expect(bench().scoring).toBe("mixed");
    const list = JSON.parse(readFileSync(join(import.meta.dirname, "../src/bench/subsets/webchorearena.json"), "utf8")).quick as string[];
    const quick = await bench().load(ctx, "quick");
    expect(quick.map((c) => c.id)).toEqual(list);
    expect(quick.every((c) => c.tags.includes("small") && !c.tags.includes("multi-site"))).toBe(true);
    const cross = raw.find((t) => t.sites.includes("wikipedia"))!;
    const b = bench();
    await expect(b.start(await b.up(ctx), { id: String(cross.task_id), tags: [] })).rejects.toThrow(/wikipedia.*wav-full/);
  });
});

describe("WC7 scripted agents on real cases", () => {
  it("passes the perfect agent, and fails noop and the wrong agent, on string, url and program_html cases", async () => {
    const ids = [stringTask, urlTask, htmlTask];
    const board = await run(perfect, ids);
    expect(board.results.map((r) => [r.id, r.success, r.reasons])).toEqual(ids.map((t) => [String(t.task_id), true, []]));
    expect(board.results.every((r) => r.score === 1)).toBe(true);
    expect((await run(noopAdapter(), ids)).passed).toBe(0);
    expect((await run(wrong, ids)).passed).toBe(0);
  }, 300_000);
});
