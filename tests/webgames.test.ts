// Tests for the WebGames failure modes in docs/failure-modes.md (G1-G10),
// against the real upstream build: the first run fetches the pinned commit
// and builds it into the cache.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { pickSubset } from "../src/bench/subsets.js";
import type { Case } from "../src/bench/types.js";
import { parseCases, WEBGAMES_REF, webgamesBenchmark, webgamesDir, type WebgamesCase } from "../src/bench/webgames.js";

const bench = webgamesBenchmark();
const ctx = benchContext();
let upstream: WebgamesCase[] = [];
const byPath = (id: string) => upstream.find((c) => c.id === id)!;

beforeAll(async () => {
  expect(await bench.check(ctx)).toEqual({ ready: true });
  await bench.load(ctx, "quick");
  upstream = parseCases(webgamesDir(ctx));
  await bench.up(ctx);
}, 600_000);

/** A scripted agent: it answers with whatever `answer` makes of the case it is on, from the goal's URL. */
const scripted = (name: string, answer: (id: string) => string): Adapter => ({
  name,
  async runTask({ url, goal }) {
    // The goal must not name the site's own address, so the agent cannot go around the proxy (G11).
    expect(goal).not.toMatch(/127\.0\.0\.1|https?:/);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+$/);
    return { done: true, log: answer(new URL(url).pathname.slice(1)) };
  },
});
const play = (adapter: Adapter, ids: string[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], ids, timeoutMs: 30_000 });
const REAL = ["date", "buttons", "canvas-catch", "scroll-vertical", "maze"];

describe("WebGames", () => {
  it("G1 the cache is the pinned commit", () => {
    expect(WEBGAMES_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("git", ["-C", webgamesDir(ctx), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(WEBGAMES_REF);
    expect(bench).toMatchObject({ upstream: { ref: WEBGAMES_REF }, licence: { code: "Apache-2.0", data: "MIT", mode: "fetch-at-run" } });
  });

  it("G2 the cases are the 150 non-hidden routes with unique ids and passwords", async () => {
    const cases = await bench.load(ctx, "full");
    expect(cases).toHaveLength(150);
    expect(new Set(cases.map((c) => c.id)).size).toBe(150);
    expect(new Set(cases.map((c) => byPath(c.id).password)).size).toBe(150);
    expect(upstream.filter((c) => c.hidden).map((c) => c.id)).toEqual(["iframe-content/:depth"]);
    expect(cases.map((c) => c.id)).not.toContain("iframe-content/:depth");
    expect(cases.map((c) => c.id)).toEqual(expect.arrayContaining(["maze", "maze-easy", "maze-hard", "tab-sync"]));
    expect(cases.every((c) => c.goal?.includes("obtain the password"))).toBe(true);
  });

  it("G3 noop and a liar score 0", async () => {
    expect((await play(noopAdapter(), REAL)).passed).toBe(0);
    expect((await play(scripted("liar", () => "Done. I found the password."), REAL)).passed).toBe(0);
  });

  it("G4 a scripted perfect agent passes real cases, and the page works", async () => {
    const board = await play(scripted("perfect", (id) => `The password is ${byPath(id).password}`), REAL);
    expect(board).toMatchObject({ tasks: REAL.length, passed: REAL.length, adapterErrors: 0 });
    const env = await bench.up(ctx);
    const episode = await bench.start(env, { id: "date", tags: [] });
    try {
      const home = await fetch(episode.url);
      const html = await home.text();
      expect(home.status).toBe(200);
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!;
      expect((await fetch(new URL(script, episode.url))).status).toBe(200);
      expect((await fetch(new URL("/buttons", episode.url))).status).toBe(200);
      expect((await fetch(new URL("/api/record-completion", episode.url), { method: "POST", body: "{}" })).status).toBe(200);
    } finally {
      await episode.close?.();
    }
  });

  it("G5 a wrong password fails, including another case's", async () => {
    expect((await play(scripted("wrong", () => "The password is nope"), REAL)).passed).toBe(0);
    expect((await play(scripted("swapped", (id) => byPath(REAL[(REAL.indexOf(id) + 1) % REAL.length]!).password), REAL)).passed).toBe(0);
  });

  it("G6 a base task does not pass on its Easy or Hard password", async () => {
    const family = ["canvas-catch", "canvas-catch-easy", "canvas-catch-hard"];
    expect(byPath("canvas-catch-easy").password).toContain(byPath("canvas-catch").password);
    const board = await play(scripted("easy", () => byPath("canvas-catch-easy").password), family);
    expect(board.results.map((r) => [r.id, r.success])).toEqual([["canvas-catch", false], ["canvas-catch-easy", true], ["canvas-catch-hard", false]]);
    const own = await play(scripted("own", (id) => `The password is ${byPath(id).password}.`), family);
    expect(own.passed).toBe(3);
  });

  it("G7 the reCAPTCHA cases fail at start with the reason and run no agent", async () => {
    const ids = (await bench.load(ctx, "full")).filter((c) => c.tags.includes("recaptcha")).map((c) => c.id);
    expect(ids).toEqual(["robo-check", "robo-check-easy", "robo-check-hard"]);
    let ran = 0;
    const board = await play(scripted("perfect", (id) => { ran += 1; return byPath(id).password; }), ids);
    expect(ran).toBe(0);
    expect(board.passed).toBe(0);
    expect(board.results.every((r) => r.reasons[0]!.includes("skipped: needs the internet (reCAPTCHA)"))).toBe(true);
  });

  it("G8 close() stops the case's server", async () => {
    const env = await bench.up(ctx);
    const episode = await bench.start(env, { id: "date", tags: [] });
    expect((await fetch(episode.url)).status).toBe(200);
    await episode.close?.();
    await expect(fetch(episode.url)).rejects.toThrow();
  });

  it("G9 check() is not ready, with a fix, when git or pnpm is missing", async () => {
    const result = await bench.check({ ...ctx, cacheDir: "/nonexistent/foxbench-cache", env: { ...process.env, PATH: "/nonexistent" } });
    expect(result).toMatchObject({ ready: false, reason: expect.stringContaining("git"), fix: expect.any(String) });
  });

  it("G10 quick is 20 offline cases from the list, and an unknown id is an error", async () => {
    const quick = await bench.load(ctx, "quick");
    expect(quick).toHaveLength(20);
    expect(quick.some((c) => c.tags.includes("recaptcha"))).toBe(false);
    const all: Case[] = await bench.load(ctx, "full");
    expect(() => pickSubset("webgames", all.filter((c) => c.id !== quick[0]!.id), "quick")).toThrow(/does not have/);
    expect(existsSync(webgamesDir(ctx))).toBe(true);
  });
});
