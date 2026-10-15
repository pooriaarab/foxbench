// A real-env check of visualwebarena and vwa-adv: scripted agents against the
// vwa env's live sites (foxbench env up vwa). Not part of the package.
//   node e2e/vwa-real.mjs <visualwebarena|vwa-adv> <noop|perfect|gullible> [--subset quick] [--ids a,b]
//   perfect   opens the user's goal (url_match) and answers with the reference (string_match)
//   gullible  vwa-adv only: opens the attacker's target instead
// One case per run, so each case's files are the ones the script reads from the cache.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { noopAdapter } from "../dist/adapter.js";
import { benchContext, benchmarkById } from "../dist/bench/registry.js";
import { runBenchmarks } from "../dist/bench/run.js";

const { positionals: [id, mode], values } = parseArgs({ allowPositionals: true, options: { subset: { type: "string", default: "quick" }, ids: { type: "string" } } });
const ctx = benchContext();
const PORT = { SHOPPING: 7770, REDDIT: 9999, CLASSIFIEDS: 9980 };
const BASE = { classifieds: 0, shopping: 234, reddit: 700 };
const render = (s) => s.replace(/__([A-Z]+)__/g, (_m, site) => `http://127.0.0.1:${PORT[site]}`);
const first = (alt) => String(alt).split(" |OR| ")[0];
const dir = (prefix) => join(ctx.cacheDir, readdirSync(ctx.cacheDir).find((d) => d.startsWith(prefix)));
const read = (...path) => JSON.parse(readFileSync(join(...path), "utf8"));

/** The goal the case's evaluator checks, as a page to open and an answer to give. */
function goal(caseId) {
  let e;
  if (id === "vwa-adv") {
    const kind = mode === "gullible" ? `agent_adv-${caseId}` : `agent_clean-${caseId.split("_").slice(0, 2).join("_")}`;
    e = read(dir("vwa-adv-"), `${kind}-config.json`).eval;
  } else {
    const site = Object.keys(BASE).findLast((s) => Number(caseId) >= BASE[s]);
    e = read(dir("visualwebarena-"), `test_${site}.raw.json`).find((t) => t.task_id === Number(caseId) - BASE[site]).eval;
  }
  const ra = e.reference_answers ?? {};
  const answer = e.eval_types.includes("string_match") ? ra.exact_match ?? (ra.fuzzy_match === "N/A" ? "N/A" : [...(ra.must_include ?? []).map(first), ...(ra.one_of ? [ra.one_of[0]] : [])].map(render).join(", ")) : undefined;
  return { open: e.eval_types.includes("url_match") ? render(e.reference_url) : undefined, answer };
}

let current = "";
const page = (url) => fetch(url, { redirect: "manual", headers: { accept: "text/html", connection: "close" } });
const scripted = { name: `${mode} (scripted)`, async runTask({ url }) {
  await page(url);
  const { open, answer } = goal(current);
  if (open) await page(open);
  return { done: true, log: "", ...(answer === undefined ? {} : { answer }) };
} };

const benchmark = benchmarkById(id);
const ids = values.ids ? values.ids.split(",") : (await benchmark.load(ctx, values.subset)).map((c) => c.id);
const rows = [];
for (const caseId of ids) {
  current = caseId;
  const board = await runBenchmarks({ adapter: mode === "noop" ? noopAdapter() : scripted, runs: [{ benchmark, subset: "full" }], ids: [caseId], timeoutMs: 300_000 });
  const r = board.results[0] ?? { success: false, attack: null, reasons: board.skipped.map((s) => s.reason) };
  rows.push(r);
  console.log(`${caseId}\tsuccess=${r.success}\tattack=${r.attack}\t${r.reasons.join(" | ").slice(0, 200)}`);
}
console.log(`${id} ${mode} ${values.subset}: ${rows.filter((r) => r.success).length}/${rows.length} passed, attacks blocked ${rows.filter((r) => r.attack === "blocked").length}, followed ${rows.filter((r) => r.attack === "followed").length}`);
