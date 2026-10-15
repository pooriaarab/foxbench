// VisualWebArena (Carnegie Mellon, MIT): 910 visually grounded tasks on
// Classifieds, Shopping and Reddit, run on the vwa env and scored with
// WebArena's evaluators plus VWA's (eval.ts). The task files and the input
// images are fetched at VWA's pinned commit into the cache, never committed.
// Cases start through wavStart like WebArena-Lite's, on the vwa env's three
// sites. A task that needs Wikipedia (35) fails with a reason: the vwa env does
// not run it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { waBenchmark, fetchCached, type WaListTask, type WaOptions } from "../wa/bench.js";
import type { Replacement } from "../types.js";
import type { WavSet, WavSite } from "../wav/index.js";
import { wavSites } from "../wav/index.js";
import { CLASSIFIEDS_PORT, VWA_COMMIT, VWA_RESET_PORT, VWA_TUNNEL_OFFSET } from "./env.js";
import { scoreVwa, vwaHelpers, type VwaTask } from "./eval.js";

const RAW = `https://raw.githubusercontent.com/web-arena-x/visualwebarena/${VWA_COMMIT}`;
const DIR = `visualwebarena-${VWA_COMMIT.slice(0, 12)}`;
/** VWA numbers each site's file from 0; the case ids number the three files in turn. */
const FILES = [["classifieds", 0], ["shopping", 234], ["reddit", 700]] as const;

/** The sites of the vwa env: the WebArena-Verified shopping and reddit as wav-core runs them, and Classifieds, which has no env-ctrl and signs in through its form (users from VWA's env_config.py). */
export const vwaWavSites: WavSite[] = [
  ...wavSites.filter((s) => s.id === "shopping" || s.id === "reddit"),
  { id: "classifieds", port: CLASSIFIEDS_PORT, ctrlPort: 0, containerPort: CLASSIFIEDS_PORT, health: "/index.php?page=search", login: { user: "blake.sullivan@gmail.com", password: "Password.123" } },
];
const SET: WavSet = { name: "vwa", offset: VWA_TUNNEL_OFFSET, sites: vwaWavSites, optional: [], resetPort: VWA_RESET_PORT, elsewhere: "its Wikipedia comes with wav-full" };

/** An input image of a task: fetched once into the cache, whole or not at all (like fetchCached, but bytes). */
async function inputImage(cacheDir: string, path: string): Promise<Buffer> {
  const file = join(cacheDir, DIR, "images", path);
  if (!existsSync(file)) {
    const res = await fetch(`${RAW}/${path}`);
    if (!res.ok) throw new Error(`${RAW}/${path}: ${res.status}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.${process.pid}`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${file}.${process.pid}`, file);
  }
  return readFileSync(file);
}

export const vwaBenchmark = (options: WaOptions = {}) => waBenchmark({
  id: "visualwebarena",
  title: "VisualWebArena",
  upstream: { repo: "https://github.com/web-arena-x/visualwebarena", ref: VWA_COMMIT, paper: "https://arxiv.org/abs/2401.13649" },
  licence: { code: "MIT", data: "MIT (task files and input images in the VWA repo; site data in the WebArena-Verified images and the Classifieds compose zip)", mode: "fetch-at-run" },
  set: SET,
  source: { url: `${RAW}/config_files/vwa/test_classifieds.raw.json`, dir: DIR, name: "test_classifieds.raw.json" },
  async tasks(ctx, classifieds) {
    const read = async ([site, base]: (typeof FILES)[number]) => {
      const file = site === "classifieds" ? classifieds : await fetchCached(ctx, DIR, `test_${site}.raw.json`, `${RAW}/config_files/vwa/test_${site}.raw.json`);
      return (JSON.parse(readFileSync(file, "utf8")) as (VwaTask & WaListTask & { image?: string | string[]; overall_difficulty: string })[]).map((t): WaListTask => ({
        ...t, task_id: base + t.task_id, tags: [`overall:${t.overall_difficulty}`, ...([t.image ?? []].flat().length ? ["image-input"] : [])],
        // A reference image that is a path is in the repo at the pinned commit.
        eval: JSON.parse(JSON.stringify(t.eval).replace(/"eval_fuzzy_image_match":"([^"]*)"/g, (_m, refs: string) => `"eval_fuzzy_image_match":"${refs.split(" |OR| ").map((r) => (/^(https?:|__)/.test(r) ? r : `${RAW}/${r}`)).join(" |OR| ")}"`)),
      }));
    };
    return (await Promise.all(FILES.map(read))).flat();
  },
  async attach(ctx, task) {
    const images = (task as WaListTask & { image?: string | string[] }).image;
    return Promise.all([images ?? []].flat().map(async (path, i): Promise<Replacement> => ({ path: `/foxbench-input/${i}${path.slice(path.lastIndexOf("."))}`, type: "image/png", body: await inputImage(ctx.cacheDir, path) })));
  },
  score: scoreVwa,
  helpers: vwaHelpers,
  // VWA's paper reports GPT-4 and BLIP-2 judged numbers; none is pinned here, so no baseline row claims a Claude-judged comparison.
  baselines: [],
}, options);
