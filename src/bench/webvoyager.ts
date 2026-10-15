// WebVoyager (He et al., 2024): 643 tasks on 15 live sites. `full` is the
// original task list with a date fix-up for Booking and Google Flights, whose
// 2023-24 dates sites now reject. `published` is the Emergence WebVoyager
// protocol (arXiv 2603.29020): 535 templated tasks, their dates instantiated
// by its own rules (parsed here, never evaluated), each with its annotation
// checklist. Both repos are fetched at pinned commits into the cache. The
// official judge is GPT-4V on screenshots; foxbench uses Claude through the
// judge interface, on the agent's answer, action history and the proxy trace.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { judgeWith, type Judge } from "./judge.js";
import { pickSubset } from "./subsets.js";
import { siteNote } from "./open-web.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness, Trace } from "./types.js";
import { locked } from "./webgames.js";

/** The `MinorJerry/WebVoyager` commit of 2024-03-04 (Apache-2.0). */
export const WV_REF = "5a7896738c10bfb8b9edccce6bb0e0411f8ae569";
/** The `EmergenceAI/EmergenceWebVoyager` commit of 2026-04-23 (MIT). */
export const EMERGENCE_REF = "0f8956d7ff00ccbd78b7d41003b6dca253cdf174";
const FILES = [
  { repo: "MinorJerry/WebVoyager", ref: WV_REF, path: "data/WebVoyager_data.jsonl" },
  { repo: "MinorJerry/WebVoyager", ref: WV_REF, path: "data/reference_answer.json" },
  { repo: "EmergenceAI/EmergenceWebVoyager", ref: EMERGENCE_REF, path: "tasks/webvoyager_template.json" },
];

interface Wv { id: string; site: string; kind: "original" | "emergence"; goal: string; web: string; checklist: string[]; golden?: string }
interface Original { web_name: string; id: string; ques: string; web: string }
interface Template { id: number; domain: string; intent_template: string; instantiation_dict: Record<string, string>; questions_for_annotation: string[]; reference_answer_type?: string; reference_answers?: string; status?: string }

const rawUrl = (ctx: BenchContext, f: (typeof FILES)[number]) => `${(ctx.env.FOXBENCH_RAW_URL ?? "https://raw.githubusercontent.com").replace(/\/+$/, "")}/${f.repo}/${f.ref}/${f.path}`;
const cached = (ctx: BenchContext, f: (typeof FILES)[number]) => join(ctx.cacheDir, `webvoyager-${f.ref.slice(0, 12)}`, f.path.split("/").at(-1)!);

async function fetchAll(ctx: BenchContext): Promise<string[]> {
  return Promise.all(FILES.map(async (f) => {
    const file = cached(ctx, f);
    await locked(join(file, ".."), async () => {
      if (existsSync(file)) return;
      const res = await fetch(rawUrl(ctx, f));
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.repo} ${f.path}`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(`${file}.part`, await res.text());
      renameSync(`${file}.part`, file);
    });
    return readFileSync(file, "utf8");
  }));
}

const DAY = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const monthOf = (name: string) => MONTHS.findIndex((m) => m.slice(0, 3).toLowerCase() === name.slice(0, 3).toLowerCase());
const pad = (n: number) => String(n).padStart(2, "0");
/** Python's weekday(): Monday is 0. */
const weekday = (t: number) => (new Date(t).getUTCDay() + 6) % 7;

/** strftime for the formats the published rules use. */
function strftime(t: number, fmt: string): string {
  const d = new Date(t);
  return fmt.replace(/%([BbdY])/g, (_m, c: string) => c === "B" ? MONTHS[d.getUTCMonth()]! : c === "b" ? MONTHS[d.getUTCMonth()]!.slice(0, 3) : c === "d" ? pad(d.getUTCDate()) : String(d.getUTCFullYear()));
}

/** The Sunday before Valentine's Day, and the Sunday after it. */
const week = (y: number) => { const start = Date.UTC(y, 1, 14) - (weekday(Date.UTC(y, 1, 14)) + 1) * DAY; return [start, start + 7 * DAY] as const; };

function valentinesWeek(now: number): string {
  let year = new Date(now).getUTCFullYear();
  let [start, end] = week(year);
  if (now > end) [start, end] = week(++year);
  return `Valentine's Day week, ${strftime(start, "%B %d")}-${strftime(end, "%d")}, ${year}`;
}

function weekendAfter(now: number, days: number): string {
  const target = now + days * DAY;
  const friday = target + ((4 - weekday(target) + 7) % 7) * DAY;
  return `${strftime(friday, "%b %d")}-${strftime(friday + 2 * DAY, "%d")}, ${new Date(friday).getUTCFullYear()}`;
}

/** One `@eval:` rule of the Emergence template. Throws on a shape it does not know (WVY4). */
export function emergenceRule(rule: string, now: number): string {
  const year = new Date(now).getUTCFullYear();
  let m: RegExpExecArray | null;
  if ((m = /^\(datetime\.now\(\)\.year(?: ([+-]) (\d+))?\)$/.exec(rule))) return String(year + (m[1] === "-" ? -1 : 1) * Number(m[2] ?? 0));
  if ((m = /^\(now\(\)(?: \+ timedelta\(days=(-?\d+)\))?\)\.strftime\('([^']+)'\)$/.exec(rule))) return strftime(now + Number(m[1] ?? 0) * DAY, m[2]!);
  if (rule === "generate_valentines_week()") return valentinesWeek(now);
  if ((m = /^generate_weekend_dates_after_x_days\((\d+)\)$/.exec(rule))) return weekendAfter(now, Number(m[1]));
  if ((m = /^str\(datetime\.now\(\)\.year - (\d+)\)\+'-'\+str\(datetime\.now\(\)\.year\)\[-(\d+):\]$/.exec(rule))) return `${year - Number(m[1])}-${String(year).slice(-Number(m[2]))}`;
  throw new Error(`webvoyager: unknown Emergence date rule ${rule}`);
}

const fill = (text: string, values: Record<string, string>) => Object.entries(values).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), text);

function instantiate(t: Template, now: number): Wv {
  const values = Object.fromEntries(Object.entries(t.instantiation_dict).map(([k, v]) => [k, v.startsWith("@eval:") ? emergenceRule(v.slice(6), now) : v]));
  return {
    id: `ev-${t.id}`, site: t.domain, kind: "emergence", goal: fill(t.intent_template, values), web: values.website ?? "",
    checklist: t.questions_for_annotation.map((q) => fill(q, values)),
    ...(t.reference_answer_type === "golden" && t.reference_answers ? { golden: t.reference_answers } : {}),
  };
}

const leap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

/** Moves the 2023-24 dates of a Booking or Google Flights task to the first future occurrence (WVY3). */
export function freshDates(text: string, now: number): string {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const out = text.replace(/today \([^)]*\)/, `today (${strftime(now, "%B")} ${d.getUTCDate()}, ${year})`);
  const first = /\b(2023|2024)\b/.exec(out);
  if (!first) return out;
  const before = out.slice(0, first.index);
  const dates = [...before.matchAll(new RegExp(`${MONTH_RE}\\.?\\s+(\\d{1,2})|(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}|(\\d{1,2})/(\\d{1,2})/$`, "g"))];
  const last = dates.at(-1);
  const [month, day] = !last ? [0, 1] : last[1] ? [monthOf(last[1]), Number(last[2])] : last[4] ? [monthOf(last[4]), Number(last[3])] : [Number(last[6]) - 1, Number(last[5])];
  const base = Date.UTC(year, month, day) > now + DAY ? year : year + 1;
  const moved = out.replace(/\b(2023|2024)\b/g, (y) => String(base + Number(y) - Number(first[1])));
  return moved.replace(/\b(Feb(?:ruary)?)\.? 29,? (\d{4})/g, (all, _f, y: string) => leap(Number(y)) ? all : `March 1, ${y}`);
}

async function loadAll(ctx: BenchContext, now: number): Promise<Wv[]> {
  const [data, reference, template] = await fetchAll(ctx);
  const golden = JSON.parse(reference!) as Record<string, { answers: { id: number; type: string; ans: string }[] }>;
  const originals = data!.split("\n").filter(Boolean).map((l): Wv => {
    const r = JSON.parse(l) as Original;
    const dated = r.web_name === "Booking" || r.web_name === "Google Flights";
    const ref = golden[r.web_name]?.answers.find((a) => `${r.web_name}--${a.id}` === r.id);
    return { id: r.id, site: r.web_name, kind: "original", goal: dated ? freshDates(r.ques, now) : r.ques, web: r.web, checklist: [], ...(ref?.type === "golden" && !dated ? { golden: ref.ans } : {}) };
  });
  return [...originals, ...(JSON.parse(template!) as Template[]).filter((t) => !t.status?.includes("remove")).map((t) => instantiate(t, now))];
}

const JUDGE = `You judge whether a web agent completed a user's task on a live website. You get the task, sometimes a checklist or a reference answer, the agent's final answer, its own account of its actions, and the requests it made.
The task succeeds only when the final answer does what the task asks and the action history shows it was done on the named website: a task done on another site fails, and so does an answer with no sign of the steps. Live sites change, so a reference answer may be out of date; trust the action history over it. When there is a checklist, every item must hold.
Reply in two lines:
Thoughts: <your reasoning>
Status: "success" or "failure"`;

const hosts = (trace: Trace) => [...new Set(trace.requests.map((r) => r.host))].slice(0, 30).join(", ") || "(none)";
const requests = (trace: Trace) => trace.requests.slice(0, 200).map((r) => `${r.method} ${r.host}${r.path} ${r.status}`).join("\n") || "(none)";
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const toCase = (t: Wv): Case => ({ id: t.id, tags: [slug(t.site), t.kind], judge: "llm", goal: t.goal });

const parse = (reply: string) => {
  const m = /Status:\s*"?(success|failure)"?/i.exec(reply);
  if (!m) throw new Error("the reply has no Status line");
  const success = m[1]!.toLowerCase() === "success";
  return { success, reasons: success ? [] : [`judged a failure: ${(/Thoughts:\s*([^\n]*)/.exec(reply)?.[1] ?? "").slice(0, 300)}`] };
};

/** A local start page with the task and a link to its site (WVY6). */
async function startPage(t: Wv) {
  const html = `<!doctype html><meta charset="utf-8"><title>WebVoyager</title><main data-case="${escape(t.id)}"><p>${escape(t.goal)}</p>
<p>Start at <a href="${escape(t.web)}">${escape(t.web)}</a>.</p>
<p>${escape(siteNote(t.web))}</p></main>`;
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const started = new WeakMap<Episode, Wv>();

export const webvoyagerBenchmark = (o: { now?: () => Date } = {}): Benchmark => {
  let tasks: Wv[] = [];
  const read = async (ctx: BenchContext) => (tasks = await loadAll(ctx, (o.now ?? (() => new Date()))().getTime()));
  return {
    id: "webvoyager",
    title: "WebVoyager",
    upstream: { repo: "https://github.com/MinorJerry/WebVoyager", ref: WV_REF, paper: "https://arxiv.org/abs/2401.13919" },
    licence: { code: "Apache-2.0 (WebVoyager), MIT (Emergence)", data: "Apache-2.0 (WebVoyager), MIT (Emergence)", mode: "fetch-at-run" },
    where: "live-web",
    measures: ["task", "info-seeking"],
    scoring: "llm",
    async check(ctx): Promise<Readiness> {
      if (FILES.every((f) => existsSync(cached(ctx, f)))) return { ready: true };
      const res = await fetch(rawUrl(ctx, FILES[0]!), { method: "HEAD" }).catch(() => null);
      return res?.ok ? { ready: true } : { ready: false, reason: res ? `the WebVoyager task file is not reachable (HTTP ${res.status})` : "GitHub is not reachable, and the WebVoyager tasks are not in the cache", fix: "connect to the network once; the cache is used after that" };
    },
    async load(ctx, subset) {
      const all = await read(ctx);
      const pool = subset === "published" ? all.filter((t) => t.kind === "emergence") : subset.startsWith("tag:") ? all : all.filter((t) => t.kind === "original");
      return pickSubset("webvoyager", pool.map(toCase), subset);
    },
    async up(ctx) {
      await read(ctx);
      return { judges: ctx.judges ?? [] };
    },
    async start(_env, item) {
      const task = tasks.find((t) => t.id === item.id);
      if (!task) throw new Error(`webvoyager has no case ${item.id}`);
      const page = await startPage(task);
      const episode: Episode = { url: page.url, goal: `${task.goal}\n\nDo this on ${task.web}. ${siteNote(task.web)} When you are done, reply with your answer.`, startPath: "/", close: page.close };
      started.set(episode, task);
      return episode;
    },
    async judge(env, episode, output, trace) {
      const task = started.get(episode);
      if (!task) throw new Error("webvoyager did not start this episode");
      const extra = [task.checklist.length ? `Checklist:\n${task.checklist.map((q) => `- ${q}`).join("\n")}` : "", task.golden ? `Reference answer: ${task.golden}` : ""].filter(Boolean).join("\n\n");
      return judgeWith(env.judges as Judge[], {
        system: JUDGE,
        prompt: `Task: ${task.goal}\nNamed website: ${task.web}\n\n${extra ? `${extra}\n\n` : ""}Final answer:\n${String(output.answer ?? "") || "(none)"}\n\nAction History:\n${String(output.log ?? "") || "(none)"}\n\nHosts the agent reached: ${hosts(trace)}\n\nRequests the agent made:\n${requests(trace)}`,
      }, parse);
    },
    down: async () => {},
    baselines: [
      { agent: "Fara-7B (GPT-4o judge, vendor-run)", subset: "full", score: 0.735, source: "https://huggingface.co/microsoft/Fara-7B", vendorReported: true },
      { agent: "Fara1.5-9B (vendor-run)", subset: "full", score: 0.866, source: "https://github.com/microsoft/fara", vendorReported: true },
      { agent: "UI-TARS-1.5-7B (Microsoft's run)", subset: "full", score: 0.664, source: "https://huggingface.co/microsoft/Fara-7B", vendorReported: true },
      { agent: "OpenAI Operator (Emergence clean protocol, human-annotated)", subset: "published", score: 0.686, source: "https://arxiv.org/abs/2603.29020" },
    ],
  };
};
