// AppWorld (Trivedi et al., ACL 2024) as a benchmark: the agent does a task
// for one of AppWorld's people on web pages over the apps (site.ts), and
// AppWorld's own evaluator, its unit tests on the end database, judges. It
// runs only through the user's own AppWorld install (plan 4.1); the licence
// keeps AppWorld's text out of every board, so it is redacted (AW11).
import { pickSubset } from "../subsets.js";
import type { BenchContext, Benchmark, Case, Episode } from "../types.js";
import { appworldReadiness, APPWORLD_REF, startBridge, type AppWorldBridge, type AppWorldTask } from "./bridge.js";
import { startAppWorldSite } from "./site.js";

const TIERS = { 1: "easy", 2: "medium", 3: "hard" } as const;
const PUBLISHED = ["test_normal", "test_challenge"];
const LEADERBOARD = "https://appworld.dev/appworld/leaderboard.json";
/** Published task goal completion (plan 6.2). Their agents wrote API code; here the agent uses pages. */
const BASELINES: [string, string, number][] = [
  ["LARA MAS + claude-opus-4-7 (API code)", "test_normal", 0.887], ["LARA MAS + claude-opus-4-7 (API code)", "test_challenge", 0.856],
  ["AgentRL + Qwen3-14B (API code)", "test_normal", 0.869], ["AgentRL + Qwen3-14B (API code)", "test_challenge", 0.676],
];

interface AppWorldEnv { [key: string]: unknown; bridge: AppWorldBridge }
const running = new WeakSet<Episode>();

/** AppWorld's instruction, who the agent acts for, and how this site works. */
const goal = (task: AppWorldTask) => {
  const s = task.supervisor;
  return `${task.goal}\n\nYou act for ${s.first_name} ${s.last_name} (email ${s.email}, phone ${s.phone_number}). Their apps are on this site, one page per action. `
    + "Sign in to an app with the account passwords in the supervisor app. When the task is done, call complete_task in the supervisor app, with the answer if the task asks a question.";
};

export const appworldBenchmark = (): Benchmark => ({
  id: "appworld",
  title: "AppWorld",
  upstream: { repo: "https://github.com/StonyBrookNLP/appworld", ref: APPWORLD_REF, paper: "https://arxiv.org/abs/2407.18901" },
  licence: { code: "Apache-2.0", data: "Apache-2.0, public copies encrypted (AppWorld)", mode: "user-access" },
  where: "local",
  measures: ["task"],
  scoring: "programmatic",
  redact: true,
  check: appworldReadiness,
  async load(ctx: BenchContext, subset) {
    const bridge = await startBridge(ctx);
    const tasks = await bridge.tasks().finally(() => bridge.close());
    // No goal on a case: `foxbench list` must not show AppWorld's text (AW11).
    const all: Case[] = tasks.map((t) => ({ id: t.id, tags: [t.split], tier: TIERS[t.difficulty as 1 | 2 | 3] }));
    return subset === "published" ? all.filter((c) => PUBLISHED.includes(c.tags[0]!)) : pickSubset("appworld", all, subset);
  },
  async up(ctx): Promise<AppWorldEnv> {
    return { bridge: await startBridge(ctx) };
  },
  async start(env, item) {
    const { bridge } = env as AppWorldEnv;
    const task = await bridge.open(item.id);
    const site = await startAppWorldSite(bridge, task);
    const episode: Episode = { url: `${site.origin}/`, goal: goal(task), startPath: "/", ended: site.completed, close: site.close };
    running.add(episode);
    return episode;
  },
  async judge(env, episode) {
    if (!running.has(episode)) throw new Error("AppWorld did not start this episode");
    const result = await (env as AppWorldEnv).bridge.evaluate();
    // Test counts only: the test text is AppWorld's (AW11).
    const reasons = result.success ? [] : [`AppWorld: ${result.fails} of ${result.passes + result.fails} tests failed`, ...(result.completed ? [] : ["the agent did not call complete_task"])];
    return { success: result.success, attack: null, reasons, judgedBy: "programmatic" };
  },
  down: async (env) => { await (env as AppWorldEnv).bridge.close(); },
  baselines: BASELINES.map(([agent, subset, score]) => ({ agent, subset, score, source: LEADERBOARD })),
});
