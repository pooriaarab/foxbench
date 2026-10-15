// Every benchmark foxbench knows, and how a --suite name maps to them.
import { homedir } from "node:os";
import { join } from "node:path";
import { SUITES } from "../tasks.js";
import { agentdojoBenchmark } from "./agentdojo/index.js";
import { browsecompBenchmark } from "./browsecomp.js";
import { appworldBenchmark } from "./appworld/index.js";
import { assistantbenchBenchmark } from "./assistantbench.js";
import { travelBenchmark } from "./agentdojo/travel.js";
import { workspaceBenchmark } from "./agentdojo/workspace.js";
import { eiaBenchmark } from "./eia.js";
import { browsesafeBenchmark } from "./browsesafe.js";
import { slackBenchmark } from "./agentdojo/slack.js";
import { foxbenchBenchmark } from "./foxbench.js";
import { gaiaBenchmark } from "./gaia.js";
import { gaia2Benchmark } from "./gaia2/index.js";
import { miniwobBenchmark } from "./miniwob/index.js";
import { onlineMind2webBenchmark } from "./online-mind2web.js";
import type { BenchContext, Benchmark, Readiness, SubsetName } from "./types.js";
import { DEFAULT_USER_MODEL } from "./user.js";
import { tau2Benchmark } from "./tau2/index.js";
import { webarenaVerified } from "./wav/index.js";
import { waiBenchmark } from "./wai/index.js";
import { mind2web2Benchmark } from "./mind2web2.js";
import { odysseysBenchmark } from "./odysseys.js";
import { deepshopBenchmark } from "./deepshop.js";
import { webtailbenchBenchmark } from "./webtailbench.js";
import { webvoyagerBenchmark } from "./webvoyager.js";
import { webgamesBenchmark } from "./webgames.js";
import { mypcbenchBenchmark } from "./mypcbench/index.js";
import { redteamcuaBenchmark } from "./redteamcua.js";
import { waspBenchmark } from "./wasp/index.js";
import { stSuitecrmBenchmark } from "./st-suitecrm.js";
import { stwabBenchmark } from "./stwab.js";
import { webmallBenchmark } from "./webmall/index.js";

const foxbench = foxbenchBenchmark();
// One entry per line, so two PRs that each add a benchmark do not conflict.
export const benchmarks: Benchmark[] = [
  foxbench,
  miniwobBenchmark,
  agentdojoBenchmark,
  slackBenchmark,
  travelBenchmark,
  workspaceBenchmark,
  webgamesBenchmark(),
  eiaBenchmark(),
  browsesafeBenchmark(),
  waiBenchmark(),
  webarenaVerified(),
  assistantbenchBenchmark(),
  tau2Benchmark("retail"),
  tau2Benchmark("airline"),
  gaiaBenchmark(),
  gaia2Benchmark(),
  onlineMind2webBenchmark(),
  appworldBenchmark(),
  browsecompBenchmark(),
  odysseysBenchmark(),
  mind2web2Benchmark(),
  webtailbenchBenchmark(),
  deepshopBenchmark(),
  mypcbenchBenchmark(),
  stSuitecrmBenchmark(),
  webvoyagerBenchmark(),
  redteamcuaBenchmark(),
  waspBenchmark(),
  stwabBenchmark(),
  webmallBenchmark(),
];

export const benchmarkById = (id: string): Benchmark | undefined => benchmarks.find((b) => b.id === id);

export function benchContext(over: Partial<BenchContext> = {}): BenchContext {
  const env = over.env ?? process.env;
  return { cacheDir: env.FOXBENCH_CACHE ?? join(homedir(), ".cache", "foxbench"), userModel: DEFAULT_USER_MODEL, ...(env.FIREFOX ? { firefox: env.FIREFOX } : {}), env, ...over };
}

/** The names --suite takes: the in-house suites, all, and each benchmark id. */
export const suiteNames = (): string[] => [...SUITES, "all", ...benchmarks.map((b) => b.id)];

/**
 * Maps "core", "all" or "miniwob,core" to benchmarks and subsets. An in-house
 * suite is the foxbench benchmark with that tag. Throws on an unknown name.
 */
export function resolveSuites(spec: string, subset: SubsetName = "full"): { benchmark: Benchmark; subset: SubsetName }[] {
  const names = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !suiteNames().includes(n));
  if (unknown.length || !names.length) throw new Error(`Unknown suite "${unknown.join(", ") || spec}". The suites are ${suiteNames().join(", ")}.`);
  return names.flatMap((name) => {
    if (name === "all") return benchmarks.map((benchmark) => ({ benchmark, subset }));
    if ((SUITES as readonly string[]).includes(name)) return [{ benchmark: foxbench, subset: `tag:${name}` as const }];
    return [{ benchmark: benchmarkById(name)!, subset }];
  });
}

/** A benchmark's check(), with a throw turned into a not-ready row. */
export async function readiness(benchmark: Benchmark, ctx: BenchContext): Promise<Readiness> {
  try {
    return await benchmark.check(ctx);
  } catch (error) {
    return { ready: false, reason: `check() threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
