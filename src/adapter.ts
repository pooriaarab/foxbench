// The adapter contract: how foxbench hands one task to one agent.

export interface TaskInput {
  /** The start page on the local mock server. */
  url: string;
  /** The goal in plain words, as a user would say it. */
  goal: string;
}

export interface TaskOutput {
  /** What the agent claims. The score ignores it; the oracle decides. */
  done: boolean;
  /** Free text for the record: steps, answers, errors. */
  log: string;
}

export interface Adapter {
  /** The name in the scoreboard and the artifact file name. */
  name: string;
  runTask(input: TaskInput): Promise<TaskOutput>;
  close?(): Promise<void>;
}

/** The baseline: it does nothing. A noop run must score 0. */
export function noopAdapter(): Adapter {
  return { name: "noop", runTask: async () => ({ done: false, log: "noop: did nothing" }) };
}
