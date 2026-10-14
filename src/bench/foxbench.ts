// The in-house suites as one benchmark. Each task is a case tagged with its
// suite, tier and site; each case gets its own server, on its own port, with
// a control key that no one gets (R1, S6). The verdict is the task's oracle.
import { randomBytes } from "node:crypto";
import { startServer, type FoxbenchServer } from "../server.js";
import { sites } from "../sites/index.js";
import { trainTasks } from "../gym/tasks.js";
import { judge, tasks, tasksIn, type Task } from "../tasks.js";
import { pickSubset } from "./subsets.js";
import type { Benchmark, Case, Episode } from "./types.js";

const toCase = (t: Task): Case => ({ id: t.id, tags: [t.suite, t.tier, t.site, ...(t.trap ? ["trap"] : [])], tier: t.tier, trap: Boolean(t.trap), suite: t.suite, goal: t.goal });
/** Each episode's server and task, for its judge and its close. */
const running = new WeakMap<Episode, { server: FoxbenchServer; task: Task }>();

/** `tasks` replaces the scored suites (runSuite); `fixedPorts` gives each site one port for the run (R6). */
export const foxbenchBenchmark = (options: { tasks?: Task[]; fixedPorts?: number } = {}): Benchmark => ({
  id: "foxbench",
  title: "foxbench core, hard and security+",
  upstream: { repo: "https://github.com/pooriaarab/foxbench", ref: "in-tree" },
  licence: { code: "MIT", data: "MIT", mode: "vendored" },
  where: "local",
  measures: ["task", "injection", "ask-user"],
  scoring: "programmatic",
  check: async () => ({ ready: true }),
  async load(_ctx, subset) {
    // Train tasks never enter full or a scored tag, though a train task's tier can be "hard"; only tag:train loads them (G1).
    if (subset === "tag:train") return trainTasks.map(toCase);
    return pickSubset("foxbench", (options.tasks ?? (subset.startsWith("tag:") ? tasks : tasksIn("all"))).map(toCase), subset);
  },
  up: async () => ({}),
  async start(_env, item) {
    const pool = options.tasks ?? [...tasks, ...trainTasks];
    const task = pool.find((t) => t.id === item.id);
    if (!task) throw new Error(`foxbench has no task ${item.id}`);
    const port = options.fixedPorts === undefined ? undefined : options.fixedPorts + Math.max(0, sites.findIndex((s) => s.id === task.site));
    const server = await startServer({ sites, tasks: pool, controlKey: randomBytes(24).toString("hex") });
    const url = server.reset(task);
    const episode: Episode = { url, goal: task.goal, startPath: new URL(url).pathname, close: () => server.close(), ...(port === undefined ? {} : { port }) };
    running.set(episode, { server, task });
    return episode;
  },
  async judge(_env, episode) {
    const run = running.get(episode);
    if (!run) throw new Error("foxbench did not start this episode");
    const { success, attack, reasons } = judge(run.task, run.server.state);
    return { success, attack, reasons, asks: run.server.state.questions.length, judgedBy: "programmatic" };
  },
  down: async () => {},
  baselines: [],
});
