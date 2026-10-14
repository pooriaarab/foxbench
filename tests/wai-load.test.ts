// Tests for the WebArena-Infinity loader rows (WL1-WL4) in docs/failure-modes.md,
// on the tasks fetched at the pinned commit. WL5 runs in tests/wai.test.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { benchContext } from "../src/bench/registry.js";
import quickList from "../src/bench/subsets/webarena-infinity.json" with { type: "json" };
import type { Case } from "../src/bench/types.js";
import { waiBenchmark } from "../src/bench/wai/index.js";

const bench = waiBenchmark();
const ctx = benchContext({ cacheDir: mkdtempSync(join(tmpdir(), "foxbench-wai-load-")) });
let all: Case[];
const load = (subset: Parameters<typeof bench.load>[1]) => bench.load(ctx, subset);
const app = (c: Case) => c.id.split("/")[0]!;

beforeAll(async () => { all = await load("full"); }, 180_000);

describe("WebArena-Infinity loader", () => {
  it("WL1 loads 1,620 real and 737 function tasks from 13 apps with unique ids", () => {
    expect(all.length).toBe(2357);
    expect(new Set(all.map((c) => c.id)).size).toBe(2357);
    expect(all.filter((c) => c.id.split("/")[1] === "real").length).toBe(1620);
    expect(all.filter((c) => c.id.split("/")[1] === "function").length).toBe(737);
    expect(new Set(all.map(app)).size).toBe(13);
  });

  it("WL2 gives real tasks their upstream tier and function tasks none", () => {
    const real = all.filter((c) => c.tags.includes("real"));
    expect(real.every((c) => c.tier && c.tags.includes(c.tier))).toBe(true);
    expect(["easy", "medium", "hard"].map((t) => real.filter((c) => c.tier === t).length)).toEqual([260, 260, 1100]);
    expect(all.filter((c) => c.tags.includes("function")).every((c) => c.tier === undefined && !c.tags.some((t) => ["easy", "medium", "hard"].includes(t)))).toBe(true);
  });

  it("WL3 selects by tag exactly", async () => {
    for (const tag of ["gmail", "easy", "real", "function", "xero-invoicing"]) {
      const picked = await load(`tag:${tag}`);
      expect(picked.length).toBeGreaterThan(0);
      expect(picked.map((c) => c.id)).toEqual(all.filter((c) => c.tags.includes(tag)).map((c) => c.id));
    }
    expect((await load("tag:gmail")).every((c) => app(c) === "gmail")).toBe(true);
    expect((await load("tag:gmail")).length).toBe(90);
  });

  it("WL4 quick is the committed list: 20 cases over every app, both kinds and every tier", async () => {
    const quick = await load("quick");
    expect(quick.map((c) => c.id)).toEqual(quickList.quick);
    expect(quick.length).toBe(20);
    expect(new Set(quick.map(app)).size).toBe(13);
    expect(new Set(quick.map((c) => c.id.split("/")[1]))).toEqual(new Set(["real", "function"]));
    expect(new Set(quick.flatMap((c) => (c.tier ? [c.tier] : [])))).toEqual(new Set(["easy", "medium", "hard"]));
    expect((await load("quick")).map((c) => c.id)).toEqual(quick.map((c) => c.id));
  });
});
