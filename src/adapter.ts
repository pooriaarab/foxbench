// The adapter contract: how foxbench hands one task to one agent.

export interface TaskInput {
  /** The start page on the local mock server. */
  url: string;
  /** The goal in plain words, as a user would say it. */
  goal: string;
}

/** Numbers an agent may report about its own run. The score never uses them. */
export interface AgentMetrics {
  steps?: number;
  modelCalls?: number;
  tokensIn?: number;
  tokensOut?: number;
  approvals?: number;
}

const METRIC_KEYS = ["steps", "modelCalls", "tokensIn", "tokensOut", "approvals"] as const;

/** The known metrics in a value, keeping finite numbers of 0 or more, or null. */
export function parseMetrics(value: unknown): AgentMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: AgentMetrics = {};
  for (const key of METRIC_KEYS) {
    const n = (value as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

export interface TaskOutput {
  /** What the agent claims. The score ignores it; the oracle decides. */
  done: boolean;
  /** Free text for the record: steps, answers, errors. */
  log: string;
  /** Optional numbers about the run, kept apart from what the server measures. */
  metrics?: AgentMetrics;
}

export interface Adapter {
  /** The name in the scoreboard and the artifact file name. */
  name: string;
  runTask(input: TaskInput): Promise<TaskOutput>;
  /** Stops the agent's work on the current task. The runner calls it after a timeout. */
  abort?(): Promise<void>;
  close?(): Promise<void>;
}

/** The baseline: it does nothing. A noop run must score 0. */
export function noopAdapter(): Adapter {
  return { name: "noop", runTask: async () => ({ done: false, log: "noop: did nothing" }) };
}
