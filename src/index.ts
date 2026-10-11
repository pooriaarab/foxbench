// The public API of foxbench.
export { startServer, page, esc } from "./server.js";
export type { Ctx, Reply, Site, Startable, ServerOptions, FoxbenchServer } from "./server.js";
export { sites } from "./sites/index.js";
export * from "./state.js";
export { tasks, taskById, tasksIn, judge, startState, SUITES, TIERS } from "./tasks.js";
export type { Task, Judgement, Suite, Tier } from "./tasks.js";
export { noopAdapter, parseMetrics } from "./adapter.js";
export type { Adapter, AgentMetrics, TaskInput, TaskOutput } from "./adapter.js";
export { runSuite, median } from "./runner.js";
export type { RunOptions, Scoreboard, TaskResult } from "./runner.js";
export { toMarkdown, writeScore } from "./score.js";
export { mcpAdapter } from "./mcp.js";
export type { McpAdapterOptions } from "./mcp.js";
