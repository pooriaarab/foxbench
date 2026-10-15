// Gaia2 (Meta's ARE): a phone assistant whose apps get events on ARE's clock
// while the agent works. ARE runs in-process through a Python bridge, and its
// own judge scores the trace: hard checks in code, and the soft rubric for
// free-text arguments through the run's LLM judge, marked when it asked.
import { spawnSync } from "node:child_process";
import { pickSubset } from "../subsets.js";
import type { Judge } from "../judge.js";
import type { Benchmark } from "../types.js";
import { CONFIGS, startBridge, ARE_REF, type Gaia2Bridge } from "./bridge.js";
import { goal, startSite } from "./site.js";

const LEADERBOARD = "https://meta-agents-research-environments-leaderboard.hf.space/";
const PAPER = "https://arxiv.org/abs/2602.11964";
interface Gaia2Env { [key: string]: unknown; bridge: Gaia2Bridge; /** The run's LLM judge, when it has one. */ judge?: Judge }

/** `configs` limits the capabilities that are fetched and listed, for tests. */
export const gaia2Benchmark = (options: { configs?: readonly string[] } = {}): Benchmark => ({
  id: "gaia2",
  title: "Gaia2 (ARE)",
  upstream: { repo: "https://github.com/facebookresearch/meta-agents-research-environments", ref: ARE_REF, paper: PAPER },
  licence: { code: "MIT", data: "CC-BY-4.0, for benchmarking purposes only; made with Llama, so the Llama terms apply", mode: "fetch-at-run" },
  where: "local",
  measures: ["task", "ask-user", "info-seeking"],
  scoring: "mixed",
  async check(ctx) {
    for (const cmd of ["git", "uv"]) if (spawnSync(cmd, ["--version"], { env: ctx.env }).status !== 0) return { ready: false, reason: `${cmd} is not on the PATH (ARE runs through uv)`, fix: cmd === "uv" ? "install uv: https://docs.astral.sh/uv/" : "install git" };
    return { ready: true };
  },
  async load(ctx, subset) {
    const bridge = await startBridge(ctx, undefined, options.configs ?? CONFIGS);
    try {
      const all = (await bridge.cases()).map((c) => ({ id: c.id, tags: [c.config], goal, judge: c.soft ? "llm" as const : "programmatic" as const }));
      return pickSubset("gaia2", all, subset);
    } finally {
      await bridge.close();
    }
  },
  async up(ctx): Promise<Gaia2Env> {
    const judge = ctx.judges?.[0];
    return { bridge: await startBridge(ctx, judge ? (q) => judge.ask(q) : undefined, options.configs ?? CONFIGS), ...(judge ? { judge } : {}) };
  },
  async start(env, item) {
    const { bridge, judge } = env as Gaia2Env;
    const site = await startSite(bridge, await bridge.start(item.id, item.tags[0]!, Boolean(judge)));
    return { url: `${site.origin}/`, goal, startPath: "/", close: site.close };
  },
  async judge(env) {
    const { bridge, judge } = env as Gaia2Env;
    const run = await bridge.judge();
    const reasons = run.success ? [] : [run.rationale];
    // The rubric only asks when ARE's hard checks did not already settle an argument (an exact match needs no judge).
    if (!judge || !run.asked) return { success: run.success, attack: null, reasons, judgedBy: "programmatic" };
    return { success: run.success, attack: null, reasons, judgedBy: `llm:${judge.model}`, judges: [{ judge: judge.name, model: judge.model, where: judge.where, success: run.success, reasons }] };
  },
  down: async (env) => { await (env as Gaia2Env).bridge.close(); },
  baselines: [
    { agent: "Claude Opus 4.6 (OpenClaw harness, tool calls)", subset: "full", score: 0.57, source: LEADERBOARD, vendorReported: true },
    { agent: "GPT-5.5 xhigh (tool calls)", subset: "full", score: 0.564, source: LEADERBOARD, vendorReported: true },
    { agent: "GLM 5.1 (open, tool calls)", subset: "full", score: 0.505, source: LEADERBOARD, vendorReported: true },
    { agent: "GPT-5 high (paper, ARE agent)", subset: "full", score: 0.42, source: PAPER },
  ],
});
