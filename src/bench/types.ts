// The common shape of every benchmark foxbench runs: the in-house suites,
// MiniWoB++, AgentDojo and the public benchmarks to come. The run loop knows
// only this interface; each benchmark brings its own cases and its own judge.
import type { TaskOutput } from "../adapter.js";
import type { Judge, JudgeResult } from "./judge.js";
import type { UserChannel } from "./user.js";

/** What every benchmark call gets: where the cache is, which Firefox, the environment. */
export interface BenchContext {
  /** Fetched upstream code and data, never committed. FOXBENCH_CACHE or ~/.cache/foxbench. */
  cacheDir: string;
  /** The Firefox binary for benchmarks that need a browser of their own (a judge browser). */
  firefox?: string;
  env: NodeJS.ProcessEnv;
  /** The LLM judges of this run, by name, for cases marked `judge: "llm"`. The first decides. */
  judges?: Judge[];
  /** The model that plays the user where a benchmark has one (--user-model). benchContext() sets the default. */
  userModel?: string;
}

/** One case of a benchmark. Ids are stable across versions, so boards stay comparable. */
export interface Case {
  id: string;
  tags: string[];
  tier?: "easy" | "medium" | "hard";
  trap?: boolean;
  /** The group the board counts it under, for example an in-house suite. The default is the benchmark id. */
  suite?: string;
  /** The goal text, for `foxbench list`. Absent for benchmarks whose licence forbids showing it. */
  goal?: string;
  /** "llm" when an LLM judge scores this case; the default is the benchmark's own code. */
  judge?: "programmatic" | "llm";
}

/** What the agent gets for one case. */
export interface Episode {
  url: string;
  goal: string;
  /** The start path: the first load of it is not an action (M6). */
  startPath: string;
  /** Settles when the benchmark itself ends the episode (MiniWoB); the run loop then stops the agent. */
  ended?: Promise<void>;
  /** Headers the proxy adds to each request to the site, such as an auto-login header. The agent never sees them. */
  headers?: Record<string, string>;
  /** The port the agent sees, so a site keeps its origin across cases (R6). The default is a free port. */
  port?: number;
  /** The person who gave the goal, served as a chat at /user/ (src/bench/user.ts). */
  userChannel?: UserChannel;
  /** Stops what this case started, for example its own server, after the judge. */
  close?(): Promise<void>;
}

/** The environment a benchmark brought up: nothing, a local server, or a tunnel to a VM. */
export type Env = Record<string, unknown>;

/** One request the agent made, as the recording proxy logs it. */
export interface TraceEntry {
  method: string;
  host: string;
  path: string;
  status: number;
  /** Response bytes; for a CONNECT tunnel, the bytes both ways. */
  bytes: number;
  /** The response's content type, without parameters. */
  type: string;
  /** A request to a host that is not the case's site (P4). */
  egress: boolean;
  /** Milliseconds from the start of the case. */
  at: number;
}

export interface Trace {
  requests: TraceEntry[];
}

export interface Verdict {
  success: boolean;
  /** Partial credit, a rubric average or a reward, where the benchmark has one. */
  score?: number;
  attack: "followed" | "blocked" | null;
  /** Why the case failed. Empty when it passed. */
  reasons: string[];
  /** Questions the agent asked the user, where the benchmark has a user to ask. */
  asks?: number;
  judgedBy: "programmatic" | `llm:${string}`;
  /** Each LLM judge's verdict, when one or more judged the case. */
  judges?: JudgeResult[];
}

export type SubsetName = "quick" | "published" | "full" | `tag:${string}`;

export type Readiness = { ready: true } | { ready: false; reason: string; fix?: string };

/** A published score on the same subset, with its source. */
export interface Baseline {
  agent: string;
  subset: string;
  /** Success rate from 0 to 1. */
  score: number;
  source: string;
  vendorReported?: boolean;
}

export interface Benchmark {
  /** "foxbench", "miniwob", "webarena-verified". */
  id: string;
  title: string;
  /** The pinned commit or tag of the upstream code. */
  upstream: { repo: string; ref: string; paper?: string };
  licence: {
    code: string;
    data: string;
    mode: "vendored" | "fetch-at-run" | "user-access" | "hosted-by-upstream";
  };
  where: "local" | "vm" | "live-web" | "upstream-hosted" | "user-instance";
  measures: Array<"task" | "injection" | "privacy" | "policy" | "harm" | "ask-user" | "info-seeking">;
  /** Who scores: code, an LLM judge, or both. Named apart from judge(), which does the scoring. */
  scoring: "programmatic" | "llm" | "mixed";
  /** The detector this benchmark scores, with its version. When set, no agent runs: judge() alone scores each case, and the board reports precision, recall and F1. */
  detector?: string;
  /** The licence forbids showing the benchmark's text: boards keep case ids and verdicts only, with no agent log. */
  redact?: boolean;
  /** Preflight. A skip carries the reason that goes in the board. */
  check(ctx: BenchContext): Promise<Readiness>;
  /** The cases of a subset. */
  load(ctx: BenchContext, subset: SubsetName): Promise<Case[]>;
  /** Brings the environment up. Idempotent. */
  up(ctx: BenchContext): Promise<Env>;
  /** Resets the state for one case and hands back what the agent gets. */
  start(env: Env, item: Case): Promise<Episode>;
  /** The benchmark's own scorer. Reads state, trace and the agent output, never `done`. */
  judge(env: Env, episode: Episode, output: TaskOutput, trace: Trace): Promise<Verdict>;
  /** Stops local servers. VMs stop only through `foxbench env down`. */
  down(env: Env): Promise<void>;
  baselines: Baseline[];
}
