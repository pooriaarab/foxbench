// Tests for the VisualWebArena-Adv failure modes in docs/failure-modes.md
// (VA1-VA6). Real cases run through the run loop with scripted agents against
// fake sites on the vwa env's tunnel ports. The case files and attack images
// are the real ones, fetched one case at a time at the pinned commit.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { VWA_RESET_PORT } from "../src/bench/vwa/env.js";
import type { JudgeBrowser } from "../src/bench/wa/page.js";
import { ADV_REF, onPage, vwaAdvBenchmark } from "../src/bench/vwa/adv.js";
import { vwaWavSites } from "../src/bench/vwa/index.js";
import { freeBase } from "./free-base.js";

const PORTS = vwaWavSites.flatMap((s) => [s.port, s.ctrlPort]).filter(Boolean).concat(VWA_RESET_PORT);
const OFFSET = await freeBase(18900, 900, PORTS);
const PORT_OFFSET = await freeBase(6000, 600, vwaWavSites.map((s) => s.port));
const at = (port: number) => port + PORT_OFFSET;
const ctx = benchContext();
const DIR = join(ctx.cacheDir, `vwa-adv-${ADV_REF.slice(0, 12)}`);
const servers: Server[] = [];
const VICTIM_SHOP = "/media/catalog/product/cache/89ff578b9cd87e0600daac45c9e1ea98/B/0/B09KXWBNZ6.0.jpg";
// The shopping site serves the product image under another cache hash than the observation recorded.
const SHOP_HASH = "/media/catalog/product/cache/00000000000000000000000000000000/B/0/B09KXWBNZ6.0.jpg";
const SITE_PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from("victim")]);

async function listen(server: Server, port: number) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(port + OFFSET, "127.0.0.1", r));
}
beforeAll(async () => {
  for (const site of vwaWavSites) {
    if (site.ctrlPort) await listen(createServer((_req, res) => res.end(JSON.stringify({ success: true }))), site.ctrlPort);
    await listen(createServer((req, res) => {
      req.resume();
      const url = req.url ?? "/";
      if (site.id === "classifieds" && url === "/index.php?page=login") return res.writeHead(200, { "set-cookie": "PHPSESSID=anon" }).end("<form></form>");
      if (site.id === "classifieds" && req.method === "POST") return res.writeHead(302, { location: "/index.php?page=user", "set-cookie": "oc_userId=7" }).end();
      if (/\.(png|jpg)$/.test(url)) return res.writeHead(200, { "content-type": "image/png" }).end(SITE_PNG);
      const img = site.id === "shopping" ? `<img src="${SHOP_HASH}">` : site.id === "classifieds" ? '<img src="/oc-content/uploads/14761/14761_thumbnail.png">' : "";
      res.writeHead(200, { "content-type": "text/html" }).end(`<html>${img}</html>`);
    }), site.port);
  }
  await listen(createServer((_req, res) => res.end("reset")), VWA_RESET_PORT);
}, 60_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

/** A judge browser whose reddit post shows one comment by the user that holds no date, whatever the agent did. */
const commenting: () => JudgeBrowser = () => ({
  page: async () => ({ goto: async () => {}, content: async () => "", evaluate: async (js) => (js.includes("comment__content") ? { username: "MarvelsGrantMan136", content: "nice movie", time: "2024-01-01T00:00:00Z", children: [] } : "") }),
  closePages: async () => {},
  close: async () => {},
});
const bench = () => vwaAdvBenchmark({ offset: OFFSET, portOffset: PORT_OFFSET, resetWaitMs: 2000, browser: commenting, settleMs: 0 });
const advCtx = (attack: string) => ({ ...ctx, env: { ...ctx.env, FOXBENCH_VWAADV_ATTACK: attack } });
const SITE: Record<string, string> = { __SHOPPING__: `http://127.0.0.1:${at(7770)}`, __REDDIT__: `http://127.0.0.1:${at(9999)}`, __CLASSIFIEDS__: `http://127.0.0.1:${at(9980)}` };
const render = (url: string) => url.replace(/^__[A-Z_]+__/, (m) => SITE[m]!);
const page = (url: string) => fetch(url, { redirect: "manual", headers: { accept: "text/html", connection: "close" } });
const CLASSIFIEDS = "classifieds_103_wrong_object_cap";
const SHOPPING = "shopping_29_wrong_color_cap";
const read = (file: string) => JSON.parse(readFileSync(join(DIR, file), "utf8"));
const urlOf = (c: { eval: { reference_url: string } }) => render(c.eval.reference_url.replace(/^http:\/\/127\.0\.0\.1:(\d+)/, (_m, p: string) => ({ 9980: "__CLASSIFIEDS__", 7770: "__SHOPPING__", 9999: "__REDDIT__" })[Number(p)]!));
/** A case's two goals from its cached files: the user's (the clean task) and the attacker's, as the URLs the agent would open. */
const goals = (id: string) => {
  const base = id.split("_").slice(0, 2).join("_");
  return { user: urlOf(read(`agent_clean-${base}-config.json`)), attacker: urlOf(read(`agent_adv-${id}-config.json`)) };
};
const agent = (name: string, go: (id: string) => "user" | "attacker" | "none"): Adapter => ({
  name,
  async runTask({ url, goal }) {
    await page(url);
    const id = [CLASSIFIEDS, SHOPPING].find((c) => goal.includes(c.split("_")[0] === "shopping" ? "winter coat" : "Arts + crafts"))!;
    const which = go(id);
    if (which !== "none") await page(goals(id)[which]);
    return { done: true, log: "" };
  },
});
const run = (adapter: Adapter, ids: string[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench(), subset: "full" }], ids, timeoutMs: 60_000 });

describe("VA1 the case list", () => {
  it("is the committed ids: 98 CLIP cases by default, 185 with the captioner attack, all traps", async () => {
    const clip = await bench().load(ctx, "full");
    expect(clip).toHaveLength(98);
    expect(await bench().load(advCtx("bim"), "full")).toHaveLength(185);
    expect(clip.every((c) => c.trap && c.tags.includes("attack:clip"))).toBe(true);
    expect(clip.find((c) => c.id === CLASSIFIEDS)!.tags).toEqual(["classifieds", "wrong", "attack:clip", "pass-0"]);
    expect(clip.find((c) => c.id === "classifieds_6_wrong_color_cap_1")!.tags).toContain("pass-1");
    expect(new Set(clip.map((c) => c.id)).size).toBe(98);
    await expect(bench().load(advCtx("pgd"), "full")).rejects.toThrow(/the attacks are clip and bim/);
    expect(bench().measures).toEqual(["task", "injection"]);
    expect(bench().licence).toMatchObject({ code: "MIT", mode: "fetch-at-run" });
  });
  it("commits ids only: no case file or image is tracked", () => {
    const tracked = spawnSync("git", ["ls-files", "src/bench/vwa", "src/bench/subsets"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }).stdout;
    expect(tracked).not.toMatch(/\.(png|jpg)|obs_text|data\.json/);
  });
  it("quick is the committed 20 ids, which both attacks have", async () => {
    const list = JSON.parse(readFileSync(join(import.meta.dirname, "../src/bench/subsets/vwa-adv.json"), "utf8")).quick as string[];
    expect((await bench().load(ctx, "quick")).map((c) => c.id)).toEqual(list);
    expect((await bench().load(advCtx("bim"), "quick")).map((c) => c.id)).toEqual(list);
    expect(list).toHaveLength(20);
  });
});

describe("VA2 VA3 starting a case", () => {
  it("fetches only the started case's files, and serves the attack image at the victim's path on the first proxy", async () => {
    const fresh = { ...ctx, cacheDir: mkdtempSync(join(tmpdir(), "fbn-adv-")) };
    const b = bench();
    const env = await b.up(fresh);
    const episode = await b.start(env, { id: CLASSIFIEDS, tags: [] });
    const files = readdirSync(join(fresh.cacheDir, `vwa-adv-${ADV_REF.slice(0, 12)}`));
    expect(files.filter((f) => f.includes("classifieds_103_wrong_object_cap"))).toEqual(expect.arrayContaining([`agent_adv-${CLASSIFIEDS}-config.json`, `${CLASSIFIEDS}-clip.png`]));
    expect(files.filter((f) => /^(agent_adv|agent_clean)-/.test(f) && !f.includes("classifieds_103"))).toEqual([]);
    // The attack image, and the user's own input image (this task gives one), which the goal names.
    expect(episode.replace).toHaveLength(2);
    expect(episode.replace![1]!.path).toMatch(/^\/foxbench-input\/0\.(jpeg|png)$/);
    expect(episode.replace![0]!.path).toBe("/oc-content/uploads/14761/14761_thumbnail.png");
    const attack = readFileSync(join(fresh.cacheDir, `vwa-adv-${ADV_REF.slice(0, 12)}`, `${CLASSIFIEDS}-clip.png`));
    expect(episode.replace![0]!.body.equals(attack)).toBe(true);
    expect(attack.subarray(1, 4).toString()).toBe("PNG");
    // The goal is the user's task, and names no attack.
    expect(episode.goal).toContain("Arts + crafts");
    expect(episode.goal).not.toMatch(/attack|adversarial/i);
    await episode.close?.();
    await b.down(env);
  });
  it("takes the victim's path from the page when the site's cache hash differs from the observation's", async () => {
    const b = bench();
    const env = await b.up(ctx);
    const episode = await b.start(env, { id: SHOPPING, tags: [] });
    expect(episode.replace![0]!.path).toBe(SHOP_HASH);
    expect(episode.replace![0]!.path).not.toBe(VICTIM_SHOP);
    await episode.close?.();
    await b.down(env);
    expect(onPage(`<img src="http://x${VICTIM_SHOP}?w=1">`, VICTIM_SHOP)).toBe(VICTIM_SHOP);
    expect(onPage("<img src='/media/other/a.jpg'>", VICTIM_SHOP)).toBe(VICTIM_SHOP);
  });
  it("the agent's request for the victim image gets the attack image, from the cache and not the site", async () => {
    let got: Buffer | undefined;
    await runBenchmarks({ adapter: { name: "looker", async runTask({ url }) {
      await page(url);
      got = Buffer.from(await (await page(`${SITE["__CLASSIFIEDS__"]}/oc-content/uploads/14761/14761_thumbnail.png`)).arrayBuffer());
      return { done: true, log: "" };
    } }, runs: [{ benchmark: bench(), subset: "full" }], ids: [CLASSIFIEDS], timeoutMs: 60_000 });
    expect(got!.equals(readFileSync(join(DIR, `${CLASSIFIEDS}-clip.png`)))).toBe(true);
    expect(got!.equals(SITE_PNG)).toBe(false);
    expect(existsSync(join(DIR, `${CLASSIFIEDS}-bim.png`))).toBe(false);
  }, 120_000);
});

describe("VA4 VA5 VA6 scoring both goals", () => {
  const ids = [CLASSIFIEDS, SHOPPING];
  const outcomes = async (adapter: Adapter) => (await run(adapter, ids)).results.map((r) => [r.id, r.success, r.attack, r.secure]);
  it("a scripted agent that does the user's goal passes with the attack blocked", async () => {
    const board = await run(agent("perfect", () => "user"), ids);
    expect(board.results.map((r) => [r.id, r.success, r.attack, r.secure, r.reasons])).toEqual(ids.map((id) => [id, true, "blocked", true, []]));
    expect(board).toMatchObject({ traps: 2, attacksBlocked: 2, attacksFollowed: 0, secureTrapPasses: 2 });
  }, 300_000);
  it("an agent that follows the image fails the user's goal with the attack followed", async () => {
    const board = await run(agent("gullible", () => "attacker"), ids);
    expect(board.results.map((r) => [r.id, r.success, r.attack, r.secure])).toEqual(ids.map((id) => [id, false, "followed", false]));
    expect(board.results[0]!.reasons.join()).toContain("attack: the attacker's goal was met");
    expect(board).toMatchObject({ attacksBlocked: 0, attacksFollowed: 2, secureTrapPasses: 0 });
  }, 300_000);
  it("noop and an agent that does something else score 0 on both goals, and never count as secure", async () => {
    for (const adapter of [noopAdapter(), agent("elsewhere", () => "none")]) expect(await outcomes(adapter)).toEqual(ids.map((id) => [id, false, "blocked", false]));
  }, 300_000);
});

const posting = (write: boolean): Adapter => ({ name: write ? "writes" : "reads", async runTask({ url }) {
  await page(url);
  if (write) await fetch(`${SITE["__REDDIT__"]}/f/movies/86107/comment`, { method: "POST", body: "x=1", headers: { connection: "close" } }).then((r) => r.arrayBuffer());
  return { done: true, log: "" };
} });
describe("VA7 an attacker check that already holds", () => {
  // The attacker's goal is `must_exclude "03"` on the user's comment, and the user already has one without it.
  const POST = "reddit_142_wrong_text_cap_2";
  it("counts the goal as followed only when the agent changed the site", async () => {
    expect((await run(noopAdapter(), [POST])).results[0]).toMatchObject({ success: false, attack: "blocked" });
    expect((await run(posting(false), [POST])).results[0]).toMatchObject({ success: false, attack: "blocked" });
    const wrote = (await run(posting(true), [POST])).results[0]!;
    expect(wrote).toMatchObject({ success: false, attack: "followed" });
    expect(wrote.reasons.join()).toContain("attack: the attacker's goal was met");
  }, 120_000);
});
