// The 91 WebMall tasks. They live in the authors' BrowserGym fork (`task_sets.json`),
// not in the WebMall repo, so the file is fetched at a pinned commit into the cache
// and read from there. Nothing is committed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchContext, Case } from "../types.js";
import { webmallSites } from "./env.js";

export const TASKS_REPO = "wbsg-uni-mannheim/BrowserGym";
/** The commit of 2025-07-29, the one the WebMall repo pins as its BrowserGym submodule. */
export const TASKS_REF = "1aaef63d737308144f13b32e37ab5dbc3688d070";
const TASKS_URL = `https://raw.githubusercontent.com/${TASKS_REPO}/${TASKS_REF}/browsergym/webmall/src/browsergym/webmall/task_sets.json`;

export interface UserDetails { name: string; street: string; house_number: string; zip: string; city: string; state: string; country: string; email: string }
export interface WebmallTask {
  id: string;
  category: string;
  /** What the agent gets, with the shop URLs filled in and the submit page replaced by "give the answer". */
  goal: string;
  type: "string" | "cart" | "checkout";
  /** The product URLs the answer, the cart or the order must hold. */
  answers: string[];
  user?: UserDetails;
}

/** The shop URLs the agent sees: the recording proxy's ports, which are also the sites' own URLs. */
const origin = (id: string) => `http://127.0.0.1:${webmallSites.find((s) => s.id === id)!.port}`;
const fill = (text: string) => text.replace(/\{\{URL_(\d)\}\}/g, (_, n: string) => origin(webmallSites[Number(n) - 1]!.id)).replaceAll("\\n", "\n");

interface RawTask { id: string; category: string; instruction: string; task: string; correct_answer: { type?: string; answers: string[] }; user_details?: Record<string, string>; payment_info?: Record<string, string> }

/** Upstream tells the agent to type the result into a page that shows it and sends nothing. Here the agent returns it. */
function goal(raw: RawTask): string {
  const example = /Example submission:\\n(.*?)\\n\\n/s.exec(raw.instruction)?.[1] ?? "";
  const how = `After solving the task, give the final result as your answer.\n\nIf the result is one or more product offers, give their exact full URL(s) separated by three ### characters.\nExample answer:\n${fill(example)}\n\nIf the result is any other kind of value(s), give the value(s).\n\nIf there is no result to return after completion of the task, answer "Done".`;
  const instruction = fill(raw.instruction).replace(/After solving the task[\s\S]*in all cases!/, how);
  const details = { ...raw.user_details, ...raw.payment_info } as Record<string, string>;
  return fill(instruction + raw.task).replace(/\{\{(\w+)\}\}/g, (all, key: string) => details[key] ?? all);
}

export function parseTasks(json: string): WebmallTask[] {
  return (JSON.parse(json) as { tasks: RawTask[] }[]).flatMap((set) => set.tasks).map((raw) => ({
    id: raw.id, category: raw.category, goal: goal(raw), type: (raw.correct_answer.type ?? "string") as WebmallTask["type"],
    answers: raw.correct_answer.answers.map(fill), ...(raw.user_details ? { user: raw.user_details as unknown as UserDetails } : {}),
  }));
}

/** task_sets.json at the pinned commit, fetched once. */
export async function loadTasks(ctx: BenchContext): Promise<WebmallTask[]> {
  const file = join(ctx.cacheDir, `webmall-tasks-${TASKS_REF.slice(0, 12)}.json`);
  if (!existsSync(file)) {
    const res = await fetch(TASKS_URL);
    if (!res.ok) throw new Error(`could not fetch the WebMall tasks (${res.status}) from ${TASKS_URL}`);
    mkdirSync(ctx.cacheDir, { recursive: true });
    writeFileSync(`${file}.part`, await res.text());
    renameSync(`${file}.part`, file);
  }
  return parseTasks(readFileSync(file, "utf8"));
}

export const toCase = (t: WebmallTask): Case => ({ id: t.id, tags: [t.category.toLowerCase(), t.type], goal: t.goal });
