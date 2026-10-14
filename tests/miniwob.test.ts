// Tests for the MiniWoB++ failure modes E12-E15 in docs/failure-modes.md.
// The seed values come from numpy (BrowserGym's own generator).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goalKey, miniwobBenchmark } from "../src/bench/miniwob/index.js";
import { MINIWOB_EPISODES, MINIWOB_TASKS, randomState } from "../src/bench/miniwob/tasks.js";
import { benchContext } from "../src/bench/registry.js";

const ctx = benchContext();

describe("E12 the task list is BrowserGym's", () => {
  it("has 125 tasks with 5 seeds each: 625 cases", async () => {
    expect(MINIWOB_TASKS).toHaveLength(125);
    expect(new Set(MINIWOB_TASKS.map((t) => t.id)).size).toBe(125);
    const published = await miniwobBenchmark.load(ctx, "published");
    expect(published).toHaveLength(625);
    expect(new Set(published.map((c) => c.id)).size).toBe(625);
    expect(published[0]).toMatchObject({ id: "ascending-numbers#0", tags: expect.arrayContaining(["ascending-numbers", "hidden-test", "test"]) });
    expect((await miniwobBenchmark.load(ctx, "full")).map((c) => c.id)).toEqual(published.map((c) => c.id));
  });
  it("names only pages the pinned MiniWoB++ has, when it is in the cache", () => {
    const html = join(ctx.cacheDir, "miniwob-33c3b4ddef8c", "miniwob", "html", "miniwob");
    if (!existsSync(html)) return;
    expect(MINIWOB_TASKS.filter((t) => !existsSync(join(html, `${t.id}.html`)))).toEqual([]);
  });
});

describe("E13 the seeds are BrowserGym's", () => {
  it("matches numpy's RandomState", () => {
    const rng = randomState(42);
    expect([1, 2, 3, 4, 5].map(() => rng.randint(34))).toEqual([28, 14, 7, 20, 18]);
    expect([0, 1, 33, 17].map((s) => randomState(s).randint(1_000_000))).toEqual([985772, 128037, 941076, 993903]);
  });
  it("makes the 625 page seeds numpy makes", () => {
    expect(MINIWOB_EPISODES[0]).toMatchObject({ id: "ascending-numbers#0", taskSeed: 28, seed: 42241 });
    const lines = MINIWOB_EPISODES.map((e) => `${e.task}:${e.taskSeed}:${e.seed}`).join("\n");
    expect(createHash("sha256").update(lines).digest("hex")).toBe("53fd6ea98ebf17a6277bd8150a60fdf15974070a93a090920a1833698ddfd30f");
  });
});

describe("E14 quick is fixed", () => {
  it("is 20 published cases of 20 tasks, the same each time", async () => {
    const quick = await miniwobBenchmark.load(ctx, "quick");
    const published = new Set((await miniwobBenchmark.load(ctx, "published")).map((c) => c.id));
    expect(quick).toHaveLength(20);
    expect(quick.every((c) => published.has(c.id))).toBe(true);
    expect(new Set(quick.map((c) => c.id.split("#")[0])).size).toBe(20);
    expect((await miniwobBenchmark.load(ctx, "quick")).map((c) => c.id)).toEqual(quick.map((c) => c.id));
  });
});

describe("E15 the goal cache key", () => {
  it("is the task and its page seed", () => {
    const same = MINIWOB_EPISODES.filter((e) => e.task === "click-button");
    expect(goalKey(same[0]!)).toBe(`click-button#${same[0]!.seed}`);
  });
});
