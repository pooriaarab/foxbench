// Tests for the VisualWebArena failure modes in docs/failure-modes.md (VT1-VT7).
// Real VWA cases run through the run loop with scripted agents against fake
// sites on the vwa env's tunnel ports, a fake judge and a fake judge browser.
// The task files and input images are the real ones, fetched at the pinned commit.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter, type TaskOutput } from "../src/adapter.js";
import type { Judge } from "../src/bench/judge.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { VWA_COMMIT, VWA_RESET_PORT } from "../src/bench/vwa/env.js";
import { vwaBenchmark, vwaWavSites } from "../src/bench/vwa/index.js";
import type { JudgeBrowser } from "../src/bench/wa/page.js";
import { freeBase } from "./free-base.js";

const PORTS = vwaWavSites.flatMap((s) => [s.port, s.ctrlPort]).filter(Boolean).concat(VWA_RESET_PORT);
const OFFSET = await freeBase(18900, 900, PORTS);
const PORT_OFFSET = await freeBase(5300, 600, vwaWavSites.map((s) => s.port));
const at = (port: number) => port + PORT_OFFSET;
const ctx = benchContext();
const DIR = join(ctx.cacheDir, `visualwebarena-${VWA_COMMIT.slice(0, 12)}`);
const servers: Server[] = [];
const seen: { port: number; method: string; url: string; headers: IncomingHttpHeaders }[] = [];
let changed = false;
// A PNG: the fake sites serve it for every image path.
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(8)]);

interface Raw { task_id: number; intent: string; sites: string[]; start_url: string; image?: string | string[]; eval: { eval_types: string[]; reference_answers?: Record<string, string | string[]>; reference_url?: string; string_note?: string; program_html?: { url: string; locator: string; required_contents: Record<string, string | string[]> }[]; page_image_query?: { eval_vqa?: { question: string; answer: string }[]; eval_fuzzy_image_match?: string }[] } }
/** Every task, with the case id the benchmark gives it. */
let raw: (Raw & { id: string })[] = [];

/** A site's tasks of the cached file, with their case ids. */
const files = (site: string, base: number) => (JSON.parse(readFileSync(join(DIR, `test_${site}.raw.json`), "utf8")) as Raw[]).map((t) => ({ ...t, id: String(base + t.task_id) }));

const browserLog = { pages: 0 };
/** A fake judge browser: it shows what a task wants only after the agent changed the site (a POST), and one image from the site the page is on. */
function fakeBrowser(_ctx: unknown, origins: Record<string, string>): JudgeBrowser {
  let task: Raw | undefined;
  let origin = "";
  return {
    async page() {
      browserLog.pages++;
      return {
        async goto(url) {
          const o = new URL(url).origin;
          origin = origins[o] ?? o;
          task = raw.find((t) => t.id === browserTask);
          await fetch(origins[o] ? origins[o] + url.slice(o.length) : url);
        },
        async evaluate(js) {
          if (js.includes('tagName === "IMG"')) return [`${origin}/img.png`];
          const target = task?.eval.program_html?.find((p) => p.locator && js.includes(p.locator));
          if (!changed || !target) return "";
          const want = target.required_contents.exact_match ?? target.required_contents.must_include;
          return Array.isArray(want) ? want.join(", ") : want;
        },
        content: async () => (changed ? (task?.eval.program_html ?? []).flatMap((p) => [p.required_contents.must_include ?? p.required_contents.exact_match ?? ""].flat()).join("\n") : ""),
      };
    },
    closePages: async () => {},
    close: async () => {},
  };
}
let browserTask = "";

const only = (t: Raw, types: string[]) => t.eval.eval_types.join() === types.join();
const plain = (c?: Record<string, string | string[]>) => Object.keys(c ?? {}).every((k) => k === "must_include" || k === "exact_match");
const single = (t: Raw, site: string) => t.sites.join() === site && !t.start_url.includes("|AND|");
let stringTask: Raw & { id: string }, urlTask: Raw & { id: string }, htmlTask: Raw & { id: string }, imageTask: Raw & { id: string }, inputTask: Raw & { id: string };

async function listen(server: Server, port: number) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(port + OFFSET, "127.0.0.1", r));
}
const resets: string[] = [];
beforeAll(async () => {
  const cases = await vwaBenchmark({ offset: OFFSET, portOffset: PORT_OFFSET }).load(ctx, "full");
  expect(cases).toHaveLength(910);
  raw = [...files("classifieds", 0), ...files("shopping", 234), ...files("reddit", 700)];
  const find = (f: (t: Raw) => boolean) => raw.find((t) => !t.sites.includes("wikipedia") && f(t))!;
  stringTask = find((t) => single(t, "shopping") && only(t, ["string_match"]) && plain(t.eval.reference_answers) && !t.image);
  urlTask = find((t) => single(t, "reddit") && only(t, ["url_match"]) && !t.eval.reference_url!.includes("|OR|") && !t.image);
  htmlTask = find((t) => single(t, "shopping") && only(t, ["program_html"]) && t.eval.program_html!.every((p) => !p.url.startsWith("func") && p.url !== "last" && !p.locator.startsWith("func") && plain(p.required_contents)));
  imageTask = find((t) => single(t, "reddit") && only(t, ["page_image_query"]) && t.eval.page_image_query!.every((q) => q.eval_vqa));
  inputTask = find((t) => single(t, "classifieds") && typeof t.image === "string" && only(t, ["url_match"]));
  for (const site of vwaWavSites) {
    if (site.ctrlPort) await listen(createServer((_req, res) => res.end(JSON.stringify({ success: true }))), site.ctrlPort);
    await listen(createServer((req, res) => {
      req.resume();
      const url = req.url ?? "/";
      // Classifieds' login form, with the hidden fields and the session cookie its login reads.
      if (site.id === "classifieds" && url === "/index.php?page=login") return res.writeHead(200, { "set-cookie": "PHPSESSID=anon; path=/" }).end(`<form><input type='hidden' name='octoken' value='tok'><input type='hidden' name='other' value='no'></form>`);
      if (site.id === "classifieds" && url === "/index.php" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { seen.push({ port: site.port, method: "LOGIN", url: body, headers: req.headers }); res.writeHead(302, { location: "/index.php?page=user", "set-cookie": ["oc_userId=7; path=/", "oc_userSecret=s=ecret; path=/"] }).end(); });
        return;
      }
      if (req.method === "POST") changed = true;
      seen.push({ port: site.port, method: req.method ?? "GET", url, headers: req.headers });
      if (url.endsWith(".png")) return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
      res.writeHead(200, { "content-type": "text/html" }).end(JSON.stringify(req.headers));
    }), site.port);
  }
  await listen(createServer((req, res) => { resets.push(req.url ?? ""); res.end("reset"); }), VWA_RESET_PORT);
}, 300_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const bench = () => vwaBenchmark({ offset: OFFSET, portOffset: PORT_OFFSET, browser: fakeBrowser, settleMs: 0, resetWaitMs: 2000 });
const SITE: Record<string, string> = { __SHOPPING__: `http://127.0.0.1:${at(7770)}`, __REDDIT__: `http://127.0.0.1:${at(9999)}`, __CLASSIFIEDS__: `http://127.0.0.1:${at(9980)}` };
const render = (url: string) => url.replace(/^__[A-Z_]+__/, (m) => SITE[m]!);
const page = (url: string, init: RequestInit = {}) => fetch(url, { redirect: "manual", ...init, headers: { accept: "text/html", connection: "close", ...init.headers } });
const taskOf = (goal: string) => raw.find((t) => goal.includes(t.intent))!;
function scripted(name: string, act: (t: Raw) => Promise<TaskOutput>): Adapter {
  return { name, runTask: async ({ url, goal }) => { await page(url); return act(taskOf(goal)); } };
}
const refAnswer = (t: Raw) => [t.eval.reference_answers?.exact_match ?? [t.eval.reference_answers?.must_include ?? ""].flat().map((a) => String(a).split(" |OR| ")[0]!.replace(/^__[A-Z_]+__/, (m) => SITE[m]!)).join(", ")].flat().join("");
const perfect = scripted("perfect", async (t) => {
  if (t.eval.eval_types.includes("url_match")) await page(render(t.eval.reference_url!));
  if (t.eval.eval_types.includes("program_html") || t.eval.eval_types.includes("page_image_query")) await page(render(t.start_url), { method: "POST", body: "x=1" });
  return { done: true, log: "", answer: t.eval.eval_types.includes("string_match") ? refAnswer(t) : "" };
});
const wrong = scripted("wrong", async () => ({ done: true, log: "", answer: "something else entirely" }));
const run = (adapter: Adapter, ids: (Raw & { id: string })[], judges?: Judge[]) => {
  changed = false;
  browserTask = ids.find((t) => t.eval.program_html?.length || t.eval.page_image_query?.length)?.id ?? "";
  return runBenchmarks({ adapter, runs: [{ benchmark: bench(), subset: "full" }], ids: ids.map((t) => t.id), timeoutMs: 60_000, ...(judges ? { judges } : {}) });
};
const asked: { images: number; prompt: string }[] = [];
/** A judge that answers a VQA from the task's expected answer, as a Claude that saw the right picture would. */
const seesRight: Judge = { name: "claude", model: "fake-model", where: "cloud", ask: async ({ prompt, images }) => {
  asked.push({ images: images?.length ?? 0, prompt });
  const q = imageTask.eval.page_image_query!.flatMap((p) => p.eval_vqa ?? []).find((v) => prompt.includes(v.question));
  return `1: ${q?.answer ?? "unknown"}`;
} };

describe("VT1 the task list", () => {
  it("is the 910 pinned tasks of the three files, whole in the cache, numbered in turn", async () => {
    const cases = await bench().load(ctx, "full");
    expect(cases.map((c) => c.id)).toEqual(Array.from({ length: 910 }, (_, i) => String(i)));
    expect(existsSync(join(DIR, "test_classifieds.raw.json"))).toBe(true);
    expect(readdirSync(DIR).filter((f) => !f.endsWith(".raw.json") && f !== "images")).toEqual([]);
    expect(raw.slice(0, 234).every((t) => t.sites[0] === "classifieds")).toBe(true);
    expect(raw.slice(234, 700).every((t) => t.sites[0] === "shopping")).toBe(true);
    expect(raw.slice(700).every((t) => t.sites.includes("reddit"))).toBe(true);
    expect(bench().licence).toMatchObject({ code: "MIT", mode: "fetch-at-run" });
    expect(bench().upstream.ref).toBe(VWA_COMMIT);
  });
  it("marks the fuzzy and image cases as llm, and tags the input images", async () => {
    const cases = await bench().load(ctx, "full");
    expect(cases.filter((c) => c.judge === "llm")).toHaveLength(91);
    expect(cases.filter((c) => c.tags.includes("image-input"))).toHaveLength(321);
    expect(cases.find((c) => c.id === inputTask.id)!.tags).toContain("classifieds");
    expect(cases.find((c) => c.id === imageTask.id)).toMatchObject({ judge: "llm", tags: expect.arrayContaining(["page_image_query"]) });
  });
});

describe("VT2 VT3 starting a case", () => {
  it("signs in to Classifieds through its form, serves the input image on the first proxy and names it in the goal", async () => {
    seen.length = 0;
    let goal = "";
    let image: Buffer | undefined;
    const looker = scripted("looker", async () => ({ done: true, log: "" }));
    await runBenchmarks({ adapter: { name: "looker", async runTask({ url, goal: g }) {
      goal = g;
      await page(url);
      // The page the agent starts on, then the image its goal names, through the run loop's proxy.
      image = Buffer.from(await (await page(/(http:\/\/\S+\/foxbench-input\/0\.png)/.exec(g)![1]!)).arrayBuffer());
      return looker.runTask({ url, goal: g, startPath: "/", timeoutMs: 1000 } as never);
    } }, runs: [{ benchmark: bench(), subset: "full" }], ids: [inputTask.id], timeoutMs: 60_000 });
    const login = seen.find((r) => r.method === "LOGIN")!;
    expect(login.url).toContain("email=blake.sullivan%40gmail.com");
    expect(login.url).toContain("action=login_post");
    expect(login.url).toContain("octoken=tok");
    expect(login.url).not.toContain("other=");
    expect(login.headers.cookie).toBe("PHPSESSID=anon");
    // The agent's request got the session cookies and the proxy's Host, and the password never reached it.
    const got = seen.find((r) => r.method === "GET" && r.port === 9980 && r.url === "/")!;
    expect(got.headers.cookie).toBe("PHPSESSID=anon; oc_userId=7; oc_userSecret=s=ecret");
    expect(got.headers.host).toBe(`127.0.0.1:${at(9980)}`);
    expect(goal).toContain(`http://127.0.0.1:${at(9980)}/foxbench-input/0.png`);
    // The proxy served the file from the cache, not the site (which answers every .png with its own stand-in).
    const file = readFileSync(join(DIR, "images", String(inputTask.image)));
    expect(image!.equals(file)).toBe(true);
    expect(file.subarray(1, 4).toString()).toBe("PNG");
    expect(seen.some((r) => r.url.includes("foxbench-input"))).toBe(false);
  }, 120_000);
  it("fails a Wikipedia task with the reason, and names the other start URLs of a multi-site one", async () => {
    const b = bench();
    const env = await b.up(ctx);
    const wiki = raw.find((t) => t.sites.includes("wikipedia"))!;
    await expect(b.start(env, { id: wiki.id, tags: [] })).rejects.toThrow(/wikipedia.*vwa does not run it.*wav-full/);
    const many = raw.find((t) => t.start_url.includes("|AND|") && !t.sites.includes("wikipedia"))!;
    const episode = await b.start(env, { id: many.id, tags: [] });
    for (const u of many.start_url.split(" |AND| ").slice(1)) expect(episode.goal).toContain(new URL(render(u)).pathname);
    await episode.close?.();
    await b.down(env);
  });
});

describe("VT4 VT5 VT6 scoring", () => {
  it("passes the scripted perfect agent on string, url and program_html cases, and fails noop and the wrong agent", async () => {
    const ids = [stringTask, urlTask, htmlTask].toSorted((a, b) => Number(a.id) - Number(b.id));
    const board = await run(perfect, ids);
    expect(board.results.map((r) => [r.id, r.success, r.reasons])).toEqual(ids.map((t) => [t.id, true, []]));
    expect((await run(noopAdapter(), ids)).passed).toBe(0);
    expect((await run(wrong, ids)).passed).toBe(0);
  }, 300_000);
  it("scores an image question with the judge looking at the page's image, and fails with no judge", async () => {
    asked.length = 0;
    const board = await run(perfect, [imageTask], [seesRight]);
    expect(board.results[0]).toMatchObject({ success: true, judges: [{ judge: "claude", model: "fake-model", success: true }] });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.images === 1)).toBe(true);
    expect((await run(perfect, [imageTask])).results[0]!.reasons[0]).toBe("judge: no judge");
    expect((await run(wrong, [imageTask], [{ ...seesRight, ask: async () => "1: nothing" }])).passed).toBe(0);
    expect((await run(noopAdapter(), [imageTask], [seesRight])).passed).toBe(0);
  }, 120_000);
  it("resets a site the agent changed before the next case on it", async () => {
    resets.length = 0;
    // Two runs: the second starts on the site the first changed, as marked in the cache.
    await run(perfect, [htmlTask]);
    resets.length = 0;
    await run(perfect, [stringTask]);
    expect(resets).toEqual(["/reset/shopping"]);
  }, 120_000);
});

describe("VT7 the quick subset", () => {
  it("is the committed 20 ids: no program_html or image check, no Wikipedia, on all three sites, and a judge only for a reason given with N/A", async () => {
    const list = JSON.parse(readFileSync(join(import.meta.dirname, "../src/bench/subsets/visualwebarena.json"), "utf8")).quick as string[];
    const quick = await bench().load(ctx, "quick");
    expect(quick.map((c) => c.id)).toEqual(list);
    expect(list).toHaveLength(20);
    expect(quick.every((c) => c.tags.every((t) => !["program_html", "page_image_query", "wikipedia", "multi-site"].includes(t)))).toBe(true);
    expect(quick.filter((c) => c.judge === "llm")).toHaveLength(2);
    for (const site of ["classifieds", "shopping", "reddit"]) expect(quick.some((c) => c.tags.includes(site))).toBe(true);
  });
});
