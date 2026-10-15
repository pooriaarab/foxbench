// ST-WebAgentBench (IBM, 2025): the 170 SuiteCRM tasks. It is a skip row. The
// scorer reads the browser: 93 task checks read the last page's DOM, 80 tasks
// run JavaScript in the page first, and every policy check reads URL history,
// clicks, typed text or page text. SuiteCRM 8 is a single-page app with hash
// routes, so foxbench's proxy trace and judge browser see only the app shell.
// A reduced check would not be CR or CuP, so the row says why instead.
import type { Benchmark, Readiness } from "./types.js";

/** The commit read on 2026-10-15; the `suitecrm` env loads its seed at the same commit. Apache-2.0. */
export const ST_REF = "67f56dd7df9eca1646c9e49407b087e950aa1e77";

const REASON = `the scorer of ST-WebAgentBench's 170 SuiteCRM tasks (upstream ${ST_REF.slice(0, 7)}) needs the agent's browser: 93 of 170 task checks read the last page's DOM, 80 tasks run JavaScript in the page first, and all 1,458 policy checks read URL history, clicks, typed text or page text; SuiteCRM 8 uses hash routes, so foxbench's HTTP trace cannot see them`;

export const stSuitecrmBenchmark = (): Benchmark => ({
  id: "st-suitecrm",
  title: "ST-WebAgentBench (SuiteCRM)",
  upstream: { repo: "https://github.com/segev-shlomov/ST-WebAgentBench", ref: ST_REF, paper: "https://arxiv.org/abs/2410.06703" },
  licence: { code: "Apache-2.0", data: "Apache-2.0", mode: "fetch-at-run" },
  where: "vm",
  measures: ["task", "policy"],
  scoring: "programmatic",
  async check(): Promise<Readiness> {
    return { ready: false, reason: REASON, fix: `add browser events (URLs, clicks, typed text, page text) from the agent's browser to foxbench; the suitecrm env is ready` };
  },
  load: async () => [],
  async up() {
    throw new Error(REASON);
  },
  async start() {
    throw new Error(REASON);
  },
  async judge() {
    throw new Error(REASON);
  },
  down: async () => {},
  baselines: [],
});
