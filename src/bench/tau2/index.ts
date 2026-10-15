// tau2-bench as benchmarks: the agent works the shop's support desk (retail.ts)
// while a simulated customer talks to it in the chat at /user/. The customer
// is Claude with tau2's own user prompt and the task's scenario; the verdict
// is tau2's evaluate_simulation on the pages' tool calls and the chat. tau2's
// NL assertions go to the run's LLM judge, not tau2's default GPT-4.1.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickSubset } from "../subsets.js";
import type { Benchmark, BenchContext, Case, Episode } from "../types.js";
import { claudeUser, userReadiness, type UserChannel } from "../user.js";
import { fetchTau2, startBridge, TAU2_REF, type Tau2Bridge, type Tau2Event } from "./bridge.js";
import type { Tau2Site } from "./desk.js";
import { startAirlineSite } from "./airline.js";
import { startRetailSite } from "./retail.js";

type Domain = "retail" | "airline";
const DESKS = { retail: "the customer support desk of an online shop", airline: "the reservations desk of an airline" };
/** The same goal for every case of a domain: what the customer wants is only in the chat (T12). */
export const tau2Goal = (domain: Domain) => `You work ${DESKS[domain]}. A customer is waiting in the chat at /user/: read what they say there and help them, `
  + "following the policy at /policy. Use the desk's pages to look up the customer's records and to make changes. Talk to the customer only in the chat.";
const SITES = { retail: startRetailSite, airline: startAirlineSite };
const SUBMISSIONS = "https://github.com/sierra-research/tau2-bench/tree/main/web/leaderboard/public/submissions";
/** Published pass^1 on the full domain (plan 6.2). Their agents called tools, not pages, with a cloud user. */
const BASELINES: Record<Domain, [string, number][]> = {
  retail: [["Qwen3.5-397B-A17B (tool calls, cloud user)", 0.844], ["Claude Opus 4.5 (tool calls, cloud user)", 0.796], ["Nemotron-Orchestrator-8B (custom harness)", 0.842]],
  airline: [["Qwen3.5-397B-A17B (tool calls, cloud user)", 0.815], ["Claude Opus 4.5 (tool calls, cloud user)", 0.84], ["Nemotron-Orchestrator-8B (custom harness)", 0.56]],
};

interface Tau2Task { id: string; evaluation_criteria: { nl_assertions?: string[] | null; reward_basis: string[] } }
interface Tau2Env { [key: string]: unknown; ctx: BenchContext; bridge: Tau2Bridge; policy: string }

const running = new WeakMap<Episode, { id: string; site: Tau2Site; user: UserChannel; greeting: string; opening: Promise<string | null> }>();
const have = (cmd: string, env: NodeJS.ProcessEnv) => spawnSync(cmd, ["--version"], { env }).status === 0;

/** `user` replaces the Claude customer, for tests. */
export const tau2Benchmark = (domain: Domain, options: { user?: (scenario: { system: string; greeting: string }) => UserChannel } = {}): Benchmark => ({
  id: `tau2-${domain}`,
  title: `tau2-bench ${domain}`,
  upstream: { repo: "https://github.com/sierra-research/tau2-bench", ref: TAU2_REF, paper: "https://arxiv.org/abs/2506.07982" },
  licence: { code: "MIT", data: "MIT", mode: "fetch-at-run" },
  where: "local",
  measures: ["task", "policy", "ask-user"],
  // Airline's reward basis has no NL assertions, so code alone scores it.
  scoring: domain === "retail" ? "mixed" : "programmatic",
  async check(ctx) {
    for (const cmd of ["git", "uv"]) if (!have(cmd, ctx.env)) return { ready: false, reason: `${cmd} is not on the PATH (tau2 runs through uv)`, fix: cmd === "uv" ? "install uv: https://docs.astral.sh/uv/" : "install git" };
    return options.user ? { ready: true } : userReadiness(ctx);
  },
  async load(ctx, subset) {
    const dir = await fetchTau2(ctx);
    const data = join(dir, "data/tau2/domains", domain);
    const tasks = JSON.parse(readFileSync(join(data, "tasks.json"), "utf8")) as Tau2Task[];
    const splits = JSON.parse(readFileSync(join(data, "split_tasks.json"), "utf8")) as Record<string, string[]>;
    const all: Case[] = tasks.map((t) => ({
      id: t.id, tags: ["train", "test"].filter((s) => splits[s]?.includes(t.id)), goal: tau2Goal(domain),
      judge: t.evaluation_criteria.reward_basis.includes("NL_ASSERTION") && t.evaluation_criteria.nl_assertions?.length ? "llm" : "programmatic",
    }));
    return pickSubset(`tau2-${domain}`, all, subset);
  },
  async up(ctx): Promise<Tau2Env> {
    const dir = await fetchTau2(ctx);
    const judge = ctx.judges?.[0];
    const bridge = await startBridge(ctx, domain, async (q) => {
      if (!judge) throw new Error("no LLM judge for tau2's NL assertions (set ANTHROPIC_API_KEY)");
      return judge.ask(q);
    });
    return { ctx, bridge, policy: readFileSync(join(dir, "data/tau2/domains", domain, "policy.md"), "utf8") };
  },
  async start(env, item) {
    const { ctx, bridge, policy } = env as Tau2Env;
    await bridge.reset();
    const scenario = await bridge.task(item.id);
    const site = await SITES[domain](bridge, policy);
    const user = options.user ? options.user(scenario) : claudeUser(ctx, scenario);
    const episode: Episode = { url: `${site.origin}/`, goal: tau2Goal(domain), startPath: "/", userChannel: user, close: site.close };
    running.set(episode, { id: item.id, site, user, greeting: scenario.greeting, opening: user.opening() });
    return episode;
  },
  async judge(env, episode) {
    const run = running.get(episode);
    if (!run) throw new Error("tau2 did not start this episode");
    const opening = await run.opening;
    // The chat and the tool calls in the order they happened, after tau2's greeting and the customer's first line.
    const events: (Tau2Event & { at: number })[] = [
      ...run.user.turns.map((t) => ({ kind: t.from, text: t.text, at: t.at })),
      ...run.site.calls.map((c) => ({ kind: "call" as const, name: c.name, arguments: c.arguments, content: c.content, error: c.error, at: c.at })),
    ].toSorted((a, b) => a.at - b.at);
    const head: Tau2Event[] = [{ kind: "agent", text: run.greeting }, ...(opening ? [{ kind: "user" as const, text: opening }] : [])];
    const { reward, info } = await (env as Tau2Env).bridge.evaluate(run.id, [...head, ...events], run.user.stopped ? "user" : "agent");
    const nl = info.nl_assertions ?? [];
    const reasons = [
      ...(info.db_check && !info.db_check.db_match ? ["the database differs from tau2's gold database"] : []),
      ...nl.filter((a) => !a.met).map((a) => `NL assertion not met: ${a.nl_assertion}`),
    ];
    const success = reward > 1 - 1e-6;
    const judge = (env as Tau2Env).ctx.judges?.[0];
    return { success, score: reward, attack: null, reasons: success ? [] : reasons.length ? reasons : [`tau2 reward ${reward}`], judgedBy: nl.length && judge ? `llm:${judge.model}` : "programmatic" };
  },
  down: async (env) => { await (env as Tau2Env).bridge.close(); },
  baselines: BASELINES[domain].map(([agent, score]) => ({ agent, subset: "full", score, source: SUBMISSIONS })),
});
