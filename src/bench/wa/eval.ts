// WebArena's evaluators, ported from VAB-WebArena-Lite's evaluators.py (Apache-2.0)
// at 9055fc2: string_match, url_match and program_html, multiplied as upstream's
// EvaluatorComb does. WebArena-Lite and WebChoreArena share them. The fuzzy
// cases go to the configured Claude judges; program_html reads a page that the
// caller opens in a judge browser (page.ts).
import { judgeWith, type Judge, type JudgeResult } from "../judge.js";

type Contents = Record<string, string | string[]>;
export interface WaTarget {
  url: string;
  locator: string;
  required_contents: Contents;
  prep_actions?: string[];
}
export interface WaTask {
  intent: string;
  eval: {
    eval_types: string[];
    reference_answers?: Contents | null;
    reference_url?: string;
    url_note?: string;
    string_note?: string;
    program_html?: WaTarget[];
  };
}
/** The part of a judge browser that program_html reads. */
export interface WaPage {
  goto(url: string): Promise<void>;
  evaluate(js: string): Promise<unknown>;
  content(): Promise<string>;
}
/** What the evaluators read from one finished case. */
export interface WaFacts {
  answer: string | undefined;
  /** The page the agent ended on, as a canonical URL (`http://127.0.0.1:<site port>/...`). */
  finalUrl: string | undefined;
  /** Opens the judge browser on first use, so a case with no program_html never starts Firefox. */
  page?: () => Promise<WaPage>;
  judges: Judge[];
  /** `func:` helpers beyond the ported ones, by name. `__page__` comes through as the judge browser's page. */
  helpers?: Record<string, (...args: (string | WaPage | undefined)[]) => Promise<string> | string>;
  /** How long program_html waits after loading a page; upstream sleeps 3 s. */
  settleMs?: number;
}
export interface WaScore {
  success: boolean;
  reasons: string[];
  /** A fuzzy match ran, so the case is `llm`. */
  llm: boolean;
  judges?: JudgeResult[];
}

const clean = (s: string) => {
  const quoted = s.length > 1 && (s[0] === "'" || s[0] === '"') && s.at(-1) === s[0];
  return (quoted ? s.slice(1, -1) : s).toLowerCase();
};

/** An approximation of NLTK's word_tokenize: punctuation splits off, a comma or colon between digits and an inner period stay. */
export function tokenize(s: string): string[] {
  return s.replace(/([;@#$%&?!()[\]{}<>"])/g, " $1 ").replace(/([:,])(?!\d)/g, " $1 ").replace(/(n't|'(?:s|m|d|ll|re|ve)\b)/g, " $1").replace(/\.(?=\s|$)/g, " . ").split(/\s+/).filter(Boolean);
}

const exactMatch = (ref: string, pred: string) => clean(pred) === clean(ref);
function mustInclude(ref: string, pred: string): boolean {
  const r = clean(ref);
  const p = clean(pred);
  if (tokenize(r).length !== 1) return p.includes(r);
  const tokens = tokenize(p);
  for (const t of tokens) if (t.includes("/")) tokens.push(...t.split("/"));
  return tokens.includes(r);
}

/** WebArena's fuzzy-match prompt, word for word. */
const fuzzyAsk = (pred: string, ref: string, question: string) => ({
  system: "You are a helpful assistant",
  prompt: `Help a teacher to grade the answer of a student given a question. Keep in mind that the student may use different phrasing or wording to answer the question. The goal is to evaluate whether the answer is semantically equivalent to the reference answer.\nquestion: ${question}\nreference answer: ${ref}\nall the string 'N/A' that you see is a special sequence that means 'not achievable'\nstudent answer: ${pred}\nConclude the judgement by 'correct', 'incorrect', or 'partially correct'. Only output one of these options, and nothing else.`,
});
const uaAsk = (pred: string, ref: string, question: string) => ({
  system: "You are a helpful assistant",
  prompt: `task: ${question}\nactual unachievable reason: ${ref}\nreported unachievable reason: ${pred}\nThe task described above is inherently unachievable due to the reason specified under 'actual unachievable reason'. An individual previously attempted this task and was unable to complete it. They provided a reason for their failure, which is listed under 'reported unachievable reason'. Your role is to review both the actual and reported reasons. Determine if the reported reason aligns with the actual reason, even if implicitly. If the stated reason is in line with the actual reason, respond with 'same'. Otherwise, respond with 'different'.`,
});
const parseFuzzy = (reply: string) => {
  const r = reply.toLowerCase();
  if (r.includes("partially correct") || r.includes("incorrect")) return { success: false, reasons: ["the judge says the answer is not correct"] };
  if (!r.includes("correct")) throw new Error(`no verdict in the reply: ${reply.slice(0, 80)}`);
  return { success: true, reasons: [] };
};
const parseUa = (reply: string) => {
  const r = reply.toLowerCase();
  if (r.includes("different")) return { success: false, reasons: ["the judge says the reason differs from the real one"] };
  if (!r.includes("same")) throw new Error(`no verdict in the reply: ${reply.slice(0, 80)}`);
  return { success: true, reasons: [] };
};

class Run {
  reasons: string[] = [];
  results = new Map<string, JudgeResult>();
  llm = false;
  constructor(readonly task: WaTask, readonly facts: WaFacts) {}
  fail(reason: string) { this.reasons.push(reason); }
  /** One judge call; each judge's results over a case's calls are merged into one row. */
  async ask(q: { system: string; prompt: string }, parse: (r: string) => { success: boolean; reasons: string[] }): Promise<boolean> {
    this.llm = true;
    const v = await judgeWith(this.facts.judges, q, parse);
    for (const j of v.judges ?? []) {
      const had = this.results.get(j.judge);
      this.results.set(j.judge, had ? { ...had, success: had.success && j.success, reasons: [...had.reasons, ...j.reasons] } : j);
    }
    if (!v.success) this.fail(v.reasons[0] ?? "the judge failed the answer");
    return v.success;
  }
  /** exact_match, must_include or fuzzy_match of `pred` against `contents`, as one string_match or program_html target does. */
  async contents(contents: Contents, pred: string, what: string): Promise<void> {
    // Nothing to compare: a judge is never asked about an empty answer or page.
    if (!pred.trim()) return this.fail(`${what}: the answer is empty`);
    for (const [approach, value] of Object.entries(contents)) {
      if (approach === "exact_match") {
        if (!exactMatch(value as string, pred)) this.fail(`${what}: not exactly "${value}"`);
      } else if (approach === "must_include") {
        for (const entry of value as string[]) if (!entry.split(" |OR| ").some((alt) => mustInclude(alt, pred))) this.fail(`${what}: does not include "${entry}"`);
      } else if (approach === "must_exclude") {
        for (const entry of value as string[]) if (mustInclude(entry, pred)) this.fail(`${what}: includes "${entry}"`);
      } else if (approach === "fuzzy_match" && value === "N/A") {
        if (!exactMatch("N/A", pred)) await this.ask(uaAsk(pred, this.task.eval.string_note ?? "", this.task.intent), parseUa);
      } else if (approach === "fuzzy_match") {
        await this.ask(fuzzyAsk(pred, (value as string[]).join(", "), this.task.intent), parseFuzzy);
      } else {
        this.fail(`harness: unsupported ${what} approach ${approach}`);
      }
    }
  }
}

const cleanUrl = (u: string) => u.replace("localhost", "127.0.0.1").replace(/\/$/, "");

function urlMatch(run: Run) {
  const { finalUrl } = run.facts;
  const e = run.task.eval;
  const rule = e.url_note ?? "EXACT";
  if (rule !== "EXACT" && rule !== "GOLD in PRED") return run.fail(`harness: unsupported url_note ${rule}`);
  if (!finalUrl) return run.fail("url_match: the agent opened no page");
  const pred = cleanUrl(finalUrl);
  const refs = (e.reference_url ?? "").split(" |OR| ").map(cleanUrl);
  if (!(rule === "EXACT" ? refs.includes(pred) : refs.some((r) => pred.includes(r)))) run.fail(`url_match: ended on ${finalUrl}, not ${e.reference_url}`);
}

/** Upstream's `func:` expressions are Python calls with string arguments; `__page__` is the judge browser. */
async function callFunc(expr: string, run: Run, page: WaPage | undefined): Promise<string> {
  const m = /^(\w+)\((.*)\)$/s.exec(expr.trim());
  if (!m) throw new Error(`unreadable func ${expr}`);
  const [, name, rest] = m;
  const args = [...rest!.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(__page__)/g)].map((a) => a[1] ?? a[2] ?? "__page__");
  const helperArgs = args.map((a) => (a === "__page__" ? page : a));
  if (name === "reddit_get_post_url") {
    // http://host/f/<subreddit>/<post id>/... is the post's own URL; anything else stays as it is.
    const u = new URL(args[0]!);
    const [, f, sub, id] = u.pathname.split("/");
    return f === "f" && sub && id ? `${u.protocol}//${u.host}/f/${sub}/${id}/` : args[0]!;
  }
  if (name === "gitlab_get_project_memeber_role") {
    const who = JSON.stringify(`@${args[1]}`);
    const index = await page!.evaluate(`(() => { const e = document.querySelectorAll("td[data-label='Account'] span.gl-avatar-labeled-sublabel"); for (let i = 0; i < e.length; i++) if (e[i].outerText === ${who}) return i; return -1; })()`);
    return String(await page!.evaluate(`(() => document.querySelectorAll("td.col-max-role span")[${Number(index)}].outerText)()`).catch(() => ""));
  }
  const helper = run.facts.helpers?.[name!];
  if (!helper) throw new Error(`unknown helper ${name}`);
  return helper(...helperArgs);
}

async function programHtml(run: Run) {
  const { facts } = run;
  let page: WaPage | undefined;
  const open = async () => (page ??= await facts.page?.());
  for (const [i, target] of (run.task.eval.program_html ?? []).entries()) {
    const what = `program_html ${i + 1}`;
    try {
      if ((target.url === "last" || target.url.includes("__last_url__")) && !facts.finalUrl) { run.fail(`${what}: the agent opened no page`); continue; }
      const target_url = target.url.startsWith("func:") ? await callFunc(target.url.slice(5).replaceAll("__last_url__", facts.finalUrl!), run, undefined) : target.url;
      const p = await open();
      if (!p) { run.fail(`harness: ${what} needs the judge browser`); continue; }
      await p.goto(target_url === "last" ? facts.finalUrl! : target_url);
      await new Promise((r) => setTimeout(r, facts.settleMs ?? 3000));
      let got: string;
      const loc = target.locator.trim();
      if (!loc) got = await p.content();
      else if (loc.startsWith("document.") || loc.startsWith("[...document.")) {
        for (const prep of target.prep_actions ?? []) await p.evaluate(`(() => ${prep})()`).catch(() => {});
        // A page or locator that gives nothing reads as an empty string (upstream's "the page is wrong").
        got = String((await p.evaluate(`(() => ${loc})()`).catch(() => "")) || "");
      } else if (loc.startsWith("func:")) got = await callFunc(loc.slice(5), run, p);
      else { run.fail(`harness: unsupported ${what} locator ${loc.slice(0, 40)}`); continue; }
      await run.contents(target.required_contents, got, what);
    } catch (error) {
      run.fail(`harness: ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Scores one case as upstream does: the product of its eval_types (WE8). */
export async function scoreWa(task: WaTask, facts: WaFacts): Promise<WaScore> {
  const run = new Run(task, facts);
  for (const type of task.eval.eval_types) {
    if (type === "string_match") await run.contents(task.eval.reference_answers ?? {}, clean(facts.answer ?? ""), "string_match");
    else if (type === "url_match") urlMatch(run);
    else if (type === "program_html") await programHtml(run);
    else run.fail(`harness: unsupported eval type ${type}`);
  }
  const judges = [...run.results.values()];
  return { success: run.reasons.length === 0, reasons: run.reasons, llm: run.llm, ...(judges.length ? { judges } : {}) };
}
