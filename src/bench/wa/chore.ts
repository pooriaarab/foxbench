// WebChoreArena: 532 tedious tasks (heavy memory, calculation, long-term memory)
// on the WebArena sites (WebChoreArena/WebChoreArena, Apache-2.0). The task list
// and the small set are fetched at the pinned commit, never committed.
import { readFileSync } from "node:fs";
import { waBenchmark, fetchCached, type WaListTask, type WaOptions } from "./bench.js";
import { scoreChore } from "./chore-eval.js";

export const CHORE_REF = "542abc538fd9558362119714989166904d82f5f4";
const RAW = `https://raw.githubusercontent.com/WebChoreArena/WebChoreArena/${CHORE_REF}/AgentOccam/config_files`;
const DIR = `webchorearena-${CHORE_REF.slice(0, 12)}`;

interface ChoreTask extends WaListTask { type_main: string; required_obs: string }

export const choreBenchmark = (options: WaOptions = {}) => waBenchmark({
  id: "webchorearena",
  title: "WebChoreArena",
  upstream: { repo: "https://github.com/WebChoreArena/WebChoreArena", ref: CHORE_REF, paper: "https://arxiv.org/abs/2506.01952" },
  licence: { code: "Apache-2.0", data: "unstated (task list in the WebChoreArena repo; scraped site data in the WebArena images)", mode: "fetch-at-run" },
  source: { url: `${RAW}/test_webchore.raw.json`, dir: DIR },
  async tasks(ctx, file) {
    const small = new Set((readFileSync(await fetchCached(ctx, DIR, "small_set_ids.txt", `${RAW}/small_set_ids.txt`), "utf8").match(/\d+/g) ?? []).map(Number));
    return (JSON.parse(readFileSync(file, "utf8")) as ChoreTask[]).map((t) => ({ ...t, tags: [t.type_main, `obs:${t.required_obs}`, ...(small.has(t.task_id) ? ["small"] : [])] }));
  },
  score: scoreChore,
  // Published scores: BrowserGym and AgentOccam on the full 532 tasks. Their fuzzy cases were judged by GPT-4o; foxbench's use Claude.
  baselines: [
    { agent: "BrowserGym + Gemini 2.5 Pro", subset: "full", score: 0.449, source: "https://github.com/WebChoreArena/WebChoreArena#-final-results" },
    { agent: "AgentOccam + Gemini 2.5 Pro", subset: "full", score: 0.378, source: "https://github.com/WebChoreArena/WebChoreArena#-final-results" },
    { agent: "BrowserGym + Claude 3.7 Sonnet", subset: "full", score: 0.231, source: "https://github.com/WebChoreArena/WebChoreArena#-final-results" },
    { agent: "AgentOccam + GPT-4o", subset: "full", score: 0.068, source: "https://github.com/WebChoreArena/WebChoreArena#-final-results" },
  ],
}, options);
