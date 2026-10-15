// WebChoreArena's evaluators, ported from BrowserGym/evaluation_harness/evaluators.py
// at 542abc5 (Apache-2.0). They are WebArena's with changes: a must_include list
// scores the mean of its entries, targets and URLs take `or` alternatives, a URL
// matches by host, path and query, page text is HTML-unescaped, and the fuzzy
// prompt is its own. The reward is the score; a case succeeds at 1.
import { callFunc, parseFuzzy, parseUa, Run, tokenize, uaAsk, type WaFacts, type WaPage, type WaScore, type WaTask } from "./eval.js";

type Contents = Record<string, string | string[]>;
interface Target { url: string; locator: string; required_contents: Contents; prep_actions?: string[]; or?: Target[] }

const NO_PAGE = "the agent opened no page";
const clean = (s: string) => {
  const t = s.trim();
  return ((t.length > 1 && (t[0] === "'" || t[0] === '"') && t.at(-1) === t[0]) ? t.slice(1, -1) : t).toLowerCase();
};
const exact = (ref: string, pred: string) => clean(pred) === clean(ref);
/**
 * upstream's must_include: `|or|` alternatives are substrings; a one-character value is a whole token when it is the only entry.
 * (Upstream tokenizes the alternative itself in the `|or|` case, which always matches; no entry in the data has a one-character alternative.)
 */
function mustInclude(ref: string, pred: string, whole: boolean): boolean {
  const r = clean(ref);
  const p = clean(pred);
  const has = (alt: string) => (whole && alt.length === 1 ? tokenize(p).includes(alt) : p.includes(alt));
  return r.includes(" |or| ") ? r.split(" |or| ").some((alt) => has(alt.trim())) : has(r);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "\u00a9", reg: "\u00ae", deg: "\u00b0", euro: "\u20ac", pound: "\u00a3",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d" };
/** Python's html.unescape for the entities a Firefox page serializes or a shop prints; an unknown name or a bad code point stays as it is. */
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
  const code = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
});

/** WebChoreArena's fuzzy prompt, word for word. */
const fuzzyAsk = (pred: string, ref: string, question: string) => ({
  system: "You are a helpful assistant",
  prompt: `Help a teacher to grade the answer of a student given a question. Keep in mind that the student has performed the action to get the answer. They are allowed to use different phrasing or wording to answer the question. The goal is to evaluate whether the key points in the reference answer are included in the student's answer. We allow answers with additional information that doesn't contradict the reference answer and review them as fully (not partially) correct.\nquestion: ${question}\nreference answer: ${ref}\nall the string 'N/A' that you see is a special sequence that means 'not achievable'\nstudent answer: ${pred}\nConclude the judgement by correct/incorrect/partially correct and explain why.`,
});

async function stringMatch(run: Run, score: { v: number }, answer: string) {
  const { task } = run;
  const pred = clean(answer);
  if (!pred) { score.v = 0; return run.fail("string_match: the answer is empty"); }
  for (const [approach, value] of Object.entries((task.eval.reference_answers ?? {}) as Contents)) {
    if (approach === "exact_match") {
      if (!exact(value as string, pred)) { score.v = 0; run.fail(`string_match: not exactly "${value}"`); }
    } else if (approach === "must_include") {
      const entries = value as string[];
      const held = entries.filter((e) => mustInclude(e, pred, entries.length === 1));
      score.v *= held.length / entries.length;
      if (held.length < entries.length) run.fail(`string_match: includes ${held.length} of ${entries.length} required values; missing ${entries.filter((e) => !held.includes(e)).join(", ")}`);
    } else if (approach === "fuzzy_match" && value === "N/A") {
      if (!exact("N/A", pred) && !(await run.ask(uaAsk(pred, task.eval.string_note ?? "", task.intent), parseUa))) score.v = 0;
    } else if (approach === "fuzzy_match") {
      const ref = Array.isArray(value) ? value.join("; ") : value;
      if (!(await run.ask(fuzzyAsk(pred, ref, task.intent), parseFuzzy))) score.v = 0;
    } else {
      score.v = 0;
      run.fail(`harness: unsupported string_match approach ${approach}`);
    }
  }
}

const cleanUrl = (u: string) => u.replace(/\/+$/, "").toLowerCase();
function parts(url: string): { base: string; query: Map<string, string[]> } {
  const u = new URL(url);
  const query = new Map<string, string[]>();
  for (const [k, v] of u.searchParams) if (v) query.set(k, [...(query.get(k) ?? []), v]);
  return { base: u.host + u.pathname, query };
}
function urlMatch(run: Run, score: { v: number }) {
  const { finalUrl } = run.facts;
  const e = run.task.eval as WaTask["eval"] & { or?: { reference_url: string }[] };
  const fail = (why: string) => { score.v = 0; run.fail(why); };
  if ((e.url_note ?? "GOLD in PRED") !== "GOLD in PRED") return fail(`harness: unsupported url_note ${e.url_note}`);
  if (!finalUrl) return fail("url_match: the agent opened no page");
  const pred = parts(cleanUrl(finalUrl));
  const best = Math.max(...[e.reference_url ?? "", ...(e.or ?? []).map((o) => o.reference_url)].map((refs) => {
    const list = refs.split(" |OR| ").map((r) => parts(cleanUrl(r)));
    const base = list.some((r) => pred.base.includes(r.base));
    const queryOk = [...new Map(list.flatMap((r) => [...r.query]).map(([k]) => [k, list.flatMap((r) => r.query.get(k) ?? [])])).entries()].every(([k, values]) => values.some((v) => pred.query.get(k)?.includes(v)));
    return base && queryOk ? 1 : 0;
  }));
  if (best === 0) fail(`url_match: ended on ${finalUrl}, not ${e.reference_url}`);
}

async function programHtml(run: Run, score: { v: number }) {
  const { facts } = run;
  let page: WaPage | undefined;
  for (const [i, target] of ((run.task.eval.program_html ?? []) as Target[]).entries()) {
    const what = `program_html ${i + 1}`;
    const results: number[] = [];
    const whys: string[] = [];
    for (const alt of [target, ...(target.or ?? [])]) {
      try {
        if ((alt.url === "last" || alt.url.includes("__last_url__")) && !facts.finalUrl) throw new Error(NO_PAGE);
        const url = alt.url.startsWith("func:") ? await callFunc(alt.url.slice(5).replaceAll("__last_url__", facts.finalUrl!), facts.helpers, undefined) : alt.url;
        page ??= await facts.page?.();
        if (!page) throw new Error("harness: the judge browser is missing");
        await page.goto(url === "last" ? facts.finalUrl! : url);
        await new Promise((r) => setTimeout(r, facts.settleMs ?? 3000));
        const loc = alt.locator.trim();
        let got: string;
        if (!loc) got = await page.content();
        else if (loc.startsWith("document.") || loc.startsWith("[...document.")) {
          for (const prep of alt.prep_actions ?? []) await page.evaluate(`(() => ${prep})()`).catch(() => {});
          got = String((await page.evaluate(`(() => ${loc})()`).catch(() => "")) || "");
        } else if (loc.startsWith("func:")) got = await callFunc(loc.slice(5), facts.helpers, page);
        else throw new Error(`harness: unsupported locator ${loc.slice(0, 40)}`);
        got = unescape(got);
        const need = alt.required_contents;
        if ("exact_match" in need) results.push(exact(need.exact_match as string, got) ? 1 : 0);
        else if ("must_include" in need) {
          const entries = need.must_include as string[];
          results.push(entries.filter((e) => e.split(" |OR| ").some((a) => mustInclude(a, got, false))).length / entries.length);
        } else throw new Error(`harness: unsupported required_contents ${Object.keys(need).join(", ")}`);
        if (results.at(-1)! < 1) whys.push("the page does not hold what is required");
      } catch (error) {
        results.push(0);
        const m = error instanceof Error ? error.message : String(error);
        whys.push(m.startsWith("harness:") || m === NO_PAGE ? m : `harness: ${m}`);
      }
    }
    const best = Math.max(...results);
    score.v *= best;
    if (best < 1) run.fail(`${what}: ${whys[0]}`);
  }
}

/** Scores one case as WebChoreArena does: the product of its eval_types; success is a score of 1. */
export async function scoreChore(task: WaTask, facts: WaFacts): Promise<WaScore> {
  const run = new Run(task, facts);
  const score = { v: 1 };
  for (const type of task.eval.eval_types) {
    if (type === "string_match") await stringMatch(run, score, facts.answer ?? "");
    else if (type === "url_match") urlMatch(run, score);
    else if (type === "program_html") await programHtml(run, score);
    else { score.v = 0; run.fail(`harness: unsupported eval type ${type}`); }
  }
  const judges = [...run.results.values()];
  return { success: score.v === 1, score: score.v, reasons: score.v === 1 ? [] : run.reasons, llm: run.llm, ...(judges.length ? { judges } : {}) };
}
