// Fixed subsets per benchmark, committed in src/bench/subsets/<id>.json, so
// two quick runs see the same cases. `published` is the subset of the
// baselines; a benchmark with no list runs everything for it.
import browsecomp from "./subsets/browsecomp.json" with { type: "json" };
import browsesafe from "./subsets/browsesafe.json" with { type: "json" };
import foxbench from "./subsets/foxbench.json" with { type: "json" };
import miniwob from "./subsets/miniwob.json" with { type: "json" };
import odysseys from "./subsets/odysseys.json" with { type: "json" };
import tau2Airline from "./subsets/tau2-airline.json" with { type: "json" };
import tau2Retail from "./subsets/tau2-retail.json" with { type: "json" };
import webarenaVerified from "./subsets/webarena-verified.json" with { type: "json" };
import webgames from "./subsets/webgames.json" with { type: "json" };
import type { Case, SubsetName } from "./types.js";

export type SubsetLists = Record<string, { quick?: string[]; published?: string[] }>;
const LISTS: SubsetLists = {
  foxbench,
  miniwob,
  webgames,
  browsesafe,
  "webarena-verified": webarenaVerified,
  "tau2-retail": tau2Retail,
  "tau2-airline": tau2Airline,
  browsecomp,
  odysseys,
};

/** The cases of a subset, from a benchmark's full list. Throws when a list names a case the benchmark lacks (L5). */
export function pickSubset(id: string, all: Case[], subset: SubsetName, lists: SubsetLists = LISTS): Case[] {
  if (subset.startsWith("tag:")) return all.filter((c) => c.tags.includes(subset.slice(4)));
  const list = subset === "quick" || subset === "published" ? lists[id]?.[subset] : undefined;
  if (!list) return subset === "quick" ? all.slice(0, 20) : all;
  const missing = list.filter((want) => !all.some((c) => c.id === want));
  if (missing.length) throw new Error(`${id}: the ${subset} list names ${missing.join(", ")}, which the benchmark does not have`);
  return list.map((want) => all.find((c) => c.id === want)!);
}
