// WebArena-Lite: 165 tasks of WebArena, checked by hand for correctness and
// feasibility (VAB-WebArena-Lite, THUDM/VisualAgentBench, Apache-2.0). The task
// list is fetched at the pinned commit, never committed.
import { readFileSync } from "node:fs";
import { shoppingRest } from "./shopping.js";
import { waBenchmark, type WaListTask, type WaOptions } from "./bench.js";

export const LITE_REF = "9055fc299c366ef34700d1710215fb60a0d8c35e";
const SOURCE = `https://raw.githubusercontent.com/THUDM/VisualAgentBench/${LITE_REF}/VAB-WebArena-Lite/new/test_webarena_lite.raw.json`;
export const liteBenchmark = (options: WaOptions = {}) => waBenchmark({
  id: "webarena-lite",
  title: "WebArena-Lite",
  upstream: { repo: "https://github.com/THUDM/VisualAgentBench", ref: LITE_REF, paper: "https://arxiv.org/abs/2411.02337" },
  licence: { code: "Apache-2.0", data: "unstated (task list in VisualAgentBench; scraped site data in the WebArena images)", mode: "fetch-at-run" },
  source: { url: SOURCE, dir: `webarena-lite-${LITE_REF.slice(0, 12)}` },
  tasks: async (_ctx, file) => JSON.parse(readFileSync(file, "utf8")) as WaListTask[],
  // The scores below were judged by GPT-4; foxbench's fuzzy cases use Claude, so a Claude-judged number is not the same column.
  baselines: [
    { agent: "WebRL Llama-3.1-70B (ICLR version)", subset: "full", score: 0.473, source: "https://arxiv.org/abs/2411.02337" },
    { agent: "WebAgent-R1 8B", subset: "full", score: 0.448, source: "https://arxiv.org/abs/2505.16421" },
    { agent: "ColorBrowserAgent (GPT-5)", subset: "full", score: 0.726, source: "https://arxiv.org/abs/2601.07262" },
  ],
  helpers: shoppingRest,
}, options);
