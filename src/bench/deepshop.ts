// DeepShop (Lyu et al., 2025): 150 complex Amazon shopping queries, 30 in each
// of five categories, with an attribute, a filter and a sort requirement. The
// official judge is GPT-4o on screenshots; foxbench uses Claude through the
// judge interface on the agent's answer, action history and the proxy trace,
// one point for each requirement the query has. The file is fetched at a
// pinned dataset revision into the cache.
import { pickSubset } from "./subsets.js";
import { siteNote } from "./open-web.js";
import type { BenchContext, Benchmark, Case, Episode } from "./types.js";
import type { Judge } from "./judge.js";
import { datasetFile, datasetReady, rubricVerdict, startPage, type Criterion } from "./webtailbench.js";

/** The `DeepShop/DeepShop` revision of 2025-05-13 (CC BY 4.0). */
export const DEEPSHOP_REF = "96cd194a8dfddfd072fc61eb7747a0e9d09f4103";
const FILE = { dataset: "DeepShop/DeepShop", ref: DEEPSHOP_REF, file: "deepshop.jsonl" };

interface Query { id: string; ques: string; web: string; attribute: string; filter: string; sort: string; category: string; difficulty: "easy" | "medium" | "hard" }
const started = new WeakMap<Episode, Query>();

export const deepshopBenchmark = (): Benchmark => {
  let queries: Query[] = [];
  const read = async (ctx: BenchContext) => (queries = (await datasetFile(ctx, FILE)).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Query));
  return {
    id: "deepshop",
    title: "DeepShop",
    upstream: { repo: "https://huggingface.co/datasets/DeepShop/DeepShop", ref: DEEPSHOP_REF, paper: "https://arxiv.org/abs/2506.02839" },
    licence: { code: "unstated", data: "CC-BY-4.0", mode: "fetch-at-run" },
    where: "live-web",
    measures: ["task", "info-seeking"],
    scoring: "llm",
    check: (ctx) => datasetReady(ctx, FILE),
    async load(ctx, subset) {
      const all: Case[] = (await read(ctx)).map((q) => ({ id: q.id, tags: [q.category.toLowerCase(), q.difficulty], tier: q.difficulty, judge: "llm", goal: q.ques }));
      return pickSubset("deepshop", all, subset);
    },
    async up(ctx) {
      await read(ctx);
      return { judges: ctx.judges ?? [] };
    },
    async start(_env, item) {
      const query = queries.find((q) => q.id === item.id);
      if (!query) throw new Error(`deepshop has no case ${item.id}`);
      const page = await startPage(query.id, query.ques, query.web);
      const episode: Episode = { url: page.url, goal: `${query.ques}\n\nDo this on ${query.web}. ${siteNote(query.web)} When you are done, reply with what you found.`, startPath: "/", close: page.close };
      started.set(episode, query);
      return episode;
    },
    async judge(env, episode, output, trace) {
      const q = started.get(episode);
      if (!q) throw new Error("deepshop did not start this episode");
      const items: Criterion[] = (["attribute", "filter", "sort"] as const).filter((k) => q[k] !== "None").map((k) => ({ criterion: `${k[0]!.toUpperCase()}${k.slice(1)}: ${q[k]}`, max: 1 }));
      return rubricVerdict(env.judges as Judge[], q.ques, items, output, trace);
    },
    down: async () => {},
    baselines: [
      { agent: "o3 SoM (vendor-run)", subset: "full", score: 0.497, source: "https://huggingface.co/microsoft/Fara-7B", vendorReported: true },
      { agent: "Fara-7B (vendor-run)", subset: "full", score: 0.262, source: "https://huggingface.co/microsoft/Fara-7B", vendorReported: true },
    ],
  };
};
