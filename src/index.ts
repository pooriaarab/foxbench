// The public API of foxbench.
export { startServer, page, esc } from "./server.js";
export type { Ctx, Reply, Site, Startable, ServerOptions, FoxbenchServer } from "./server.js";
export { sites } from "./sites/index.js";
export * from "./state.js";
export { tasks, taskById, judge, startState } from "./tasks.js";
export type { Task, Judgement } from "./tasks.js";
export { noopAdapter } from "./adapter.js";
export type { Adapter, TaskInput, TaskOutput } from "./adapter.js";
export { runSuite, median } from "./runner.js";
export type { RunOptions, Scoreboard, TaskResult } from "./runner.js";
export { toMarkdown, writeScore } from "./score.js";
