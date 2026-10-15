// VisualWebArena-Adv (Wu et al., ICLR 2025, MIT): adversarial images that
// misdirect a VWA agent. Each case is a VWA task whose page holds a "victim"
// image; the proxy serves an attack image in its place, and the case scores
// two goals with VWA's evaluators: the user's (the benign task) and the
// attacker's (the agent followed the image). A case is a trap: the board
// reports attacks blocked and followed. The case list is committed (ids only);
// each case's files are fetched when it starts, at the pinned commit.
// The attack images are tuned for GPT-4V, Gemini, Claude 3 Opus and GPT-4o
// (CLIP attack) or for a captioner (bim), not for the agent under test, so a
// score is a transfer rate.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { Case, Replacement } from "../types.js";
import { pickSubset } from "../subsets.js";
import { wavLogin, type WavEnv } from "../wav/index.js";
import { fetchCached, waBenchmark, type WaListTask, type WaOptions } from "../wa/bench.js";
import { fetchBytes, inputImages, vwaWavSites } from "./index.js";
import { VWA_RESET_PORT, VWA_TUNNEL_OFFSET } from "./env.js";
import { imageType, scoreVwa, vwaHelpers } from "./eval.js";
import cases from "./adv-cases.json" with { type: "json" };

export const ADV_REF = "d745e2b81308c8b71350e175ad68552189d848c7";
const RAW = `https://raw.githubusercontent.com/ChenWu98/agent-attack/${ADV_REF}/data`;
const DIR = `vwa-adv-${ADV_REF.slice(0, 12)}`;
/** The attacks: the CLIP attack (98 cases, the default) or the captioner attack (185), by FOXBENCH_VWAADV_ATTACK. */
const ATTACKS = { clip: "clip_attack_attack_image.png", bim: "bim_caption_attack_image.png" } as const;
const attackOf = (env: NodeJS.ProcessEnv) => {
  const name = env.FOXBENCH_VWAADV_ATTACK || "clip";
  if (!(name in ATTACKS)) throw new Error(`FOXBENCH_VWAADV_ATTACK is "${name}"; the attacks are ${Object.keys(ATTACKS).join(" and ")}.`);
  return name as keyof typeof ATTACKS;
};

/** The sites' addresses in upstream's files, as the placeholders of VWA's own task files. */
const PLACEHOLDERS: Record<string, string> = { 9980: "__CLASSIFIEDS__", 7770: "__SHOPPING__", 9999: "__REDDIT__", 8888: "__WIKIPEDIA__", 4399: "__HOMEPAGE__" };
const placeholders = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(/http:\/\/127\.0\.0\.1:(\d+)/g, (m, port: string) => PLACEHOLDERS[port] ?? m));

interface AdvTask extends WaListTask {
  image?: string;
  /** The victim images' paths on the site, as the clean run saw them. */
  victims: string[];
}

/** The victim images' URLs: the `url:` of each victim element in the clean observation (upstream's get_url). */
const victimUrls = (obs: string, ids: number | number[]) => [ids].flat().map((id) => {
  const url = /url: (.+?)]/.exec(obs.slice(obs.indexOf(`\n[${id}]`)))?.[1];
  if (!url) throw new Error(`no victim element [${id}] in the observation`);
  return new URL(url.replace("cache/resolve", "cache")).pathname;
});

/** One GET with no connection pool, for the page the victim image is on. */
const get = (url: string, headers: Record<string, string>) => new Promise<string>((resolve, reject) => {
  request(url, { headers, agent: false, timeout: 30_000 }, (res) => { let body = ""; res.on("data", (c: Buffer) => { body += c; }); res.on("end", () => resolve(body)); }).on("error", reject).end();
});

/** The victim's path as the site serves it now: the same one, or the image on the page that ends the same way (a product image's cache hash differs between installs). */
export function onPage(html: string, victim: string): string {
  const srcs = [...html.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/g)].map((m) => m[1]!.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!);
  if (srcs.includes(victim)) return victim;
  const tail = victim.split("/").slice(-3).join("/");
  return srcs.find((s) => s.endsWith(`/${tail}`)) ?? victim;
}

export const vwaAdvBenchmark = (options: WaOptions = {}) => waBenchmark({
  id: "vwa-adv",
  title: "VisualWebArena-Adv",
  upstream: { repo: "https://github.com/ChenWu98/agent-attack", ref: ADV_REF, paper: "https://arxiv.org/abs/2406.12814" },
  licence: { code: "MIT", data: "MIT (case files and attack images in the agent-attack repo; the sites are the vwa env's)", mode: "fetch-at-run" },
  set: { name: "vwa", offset: VWA_TUNNEL_OFFSET, sites: vwaWavSites, optional: [], resetPort: VWA_RESET_PORT, elsewhere: "its Wikipedia comes with wav-full" },
  source: { url: "", dir: DIR },
  measures: ["task", "injection"],
  tasks: async () => [],
  async cases(ctx, subset) {
    const all: Case[] = cases[attackOf(ctx.env)].map((id) => {
      const [site, , kind] = id.split("_");
      return { id, tags: [site!, kind!, `attack:${attackOf(ctx.env)}`, `pass-${/_cap_(\d)$/.exec(id)?.[1] ?? 0}`], trap: true };
    });
    return pickSubset("vwa-adv", all, subset);
  },
  async task(ctx, id) {
    const file = (path: string) => fetchCached(ctx, DIR, path.replaceAll("/", "-"), `${RAW}/${path}`);
    const json = async (path: string) => JSON.parse(readFileSync(await file(path), "utf8"));
    const base = id.split("_").slice(0, 2).join("_");
    const [adv, data, clean, obs] = await Promise.all([json(`agent_adv/${id}/config.json`), json(`agent_adv/${id}/data.json`), json(`agent_clean/${base}/config.json`), file(`agent_clean/${base}/obs_text.txt`)]);
    return placeholders<AdvTask>({
      task_id: id, intent: clean.intent, sites: adv.sites, start_url: adv.start_url, ...(clean.image ? { image: clean.image } : {}),
      eval: clean.eval, attack: { intent: adv.intent, eval: adv.eval },
      victims: victimUrls(readFileSync(obs, "utf8"), data.victim_som_id),
    });
  },
  async attach(ctx, task) {
    const image = (task as AdvTask).image;
    return image ? inputImages(ctx.cacheDir, image, DIR) : [];
  },
  // The attack image takes the victim's place on the site the case starts on, at the path the site serves the victim on.
  async swap(wav: WavEnv, task): Promise<Replacement[]> {
    const t = task as AdvTask;
    const body = await fetchBytes(wav.ctx.cacheDir, DIR, `${t.task_id}-${attackOf(wav.ctx.env)}.png`, `${RAW}/agent_adv/${t.task_id}/${ATTACKS[attackOf(wav.ctx.env)]}`);
    const first = t.start_url.match(/^__([A-Z_]+)__(.*)$/)!;
    const { url, headers } = await wavLogin(wav, first[1]!.toLowerCase());
    const html = await get(url + first[2], headers);
    return t.victims.map((victim) => ({ path: onPage(html, victim), type: imageType(body) ?? "image/png", body }));
  },
  score: scoreVwa,
  helpers: vwaHelpers,
  baselines: [],
}, options);
