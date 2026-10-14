// The in-house suites as one benchmark. Each task is a case tagged with its
// suite, tier and site; each case gets its own server, on its own port, with
// a control key that no one gets (R1, S6). The verdict is the task's oracle.
import { randomBytes } from "node:crypto";
import { startServer, type FoxbenchServer } from "../server.js";
import { sites } from "../sites/index.js";
import { judge, tasks, tasksIn, type Task } from "../tasks.js";
import type { Benchmark, Case, Episode } from "./types.js";

const toCase = (t: Task): Case => ({ id: t.id, tags: [t.suite, t.tier, t.site, ...(t.trap ? ["trap"] : [])], tier: t.tier, trap: Boolean(t.trap), goal: t.goal });
/** Each episode's server and task, for its judge and its close. */
const running = new WeakMap<Episode, { server: FoxbenchServer; task: Task }>();

export const foxbenchBenchmark: Benchmark = {
  id: "foxbench",
  title: "foxbench core, hard and security+",
  upstream: { repo: "https://github.com/pooriaarab/foxbench", ref: "in-tree" },
  licence: { code: "MIT", data: "MIT", mode: "vendored" },
  where: "local",
  measures: ["task", "injection", "ask-user"],
  scoring: "programmatic",
  check: async () => ({ ready: true }),
  async load(_ctx, subset) {
    // Train tasks never enter full; only a tag loads them.
    if (subset.startsWith("tag:")) return tasks.filter((t) => toCase(t).tags.includes(subset.slice(4))).map(toCase);
    return tasksIn("all").map(toCase);
  },
  up: async () => ({}),
  async start(_env, item) {
    const task = tasks.find((t) => t.id === item.id);
    if (!task) throw new Error(`foxbench has no task ${item.id}`);
    const server = await startServer({ sites, tasks, controlKey: randomBytes(24).toString("hex") });
    const url = server.reset(task);
    const episode: Episode = { url, goal: task.goal, startPath: new URL(url).pathname, close: () => server.close() };
    running.set(episode, { server, task });
    return episode;
  },
  async judge(_env, episode) {
    const run = running.get(episode);
    if (!run) throw new Error("foxbench did not start this episode");
    const { success, attack, reasons } = judge(run.task, run.server.state);
    return { success, attack, reasons, judgedBy: "programmatic" };
  },
  down: async () => {},
  baselines: [],
};
