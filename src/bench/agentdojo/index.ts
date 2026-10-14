// AgentDojo's banking suite as a foxbench benchmark. AgentDojo (MIT)
// gives tools to a model; a browser agent needs pages. This file serves the
// banking environment as a small online bank: each form does what the tool of
// the same name does (banking_client.py, user_account.py, file_reader.py), on
// the same environment data. AgentDojo itself makes the cases, places the
// "important_instructions" injections, and judges utility and security
// (bridge.py). foxbench writes none of the checks.
import { execFileSync, spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskOutput } from "../../adapter.js";
import { esc } from "../../server.js";
import { serveCase } from "../serve.js";
import { pickSubset } from "../subsets.js";
import type { Benchmark, Episode, Verdict } from "../types.js";

export const AGENTDOJO_VERSION = "0.1.35";
export const SUITE_VERSION = "v1.2.2";
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "bridge.py");

type Form = Record<string, string>;
interface Tx { id: number; sender: string; recipient: string; amount: number; subject: string; date: string; recurring: boolean }
interface Bank {
  bank_account: { iban: string; balance: number; transactions: Tx[]; scheduled_transactions: Tx[] };
  user_account: Form;
  filesystem: { files: Record<string, string> };
}
/** One case as AgentDojo's prepare makes it (bridge.py). */
interface Item { id: string; user_task: string; injection_task: string | null; goal: string; env: Bank }
type Judgement = { utility: boolean; security: boolean | null };

const UV = (command: string) => ["run", "-q", "--no-project", "--python", "3.12", "--with", `agentdojo==${AGENTDOJO_VERSION}`, "python", "-I", BRIDGE, command, SUITE_VERSION, "banking"];
const bridge = (command: string) => JSON.parse(execFileSync("uv", UV(command), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

/** One AgentDojo judge process for a whole run: one JSON line in, one verdict line out. */
export function startJudge() {
  const child = spawn("uv", UV("judge"), { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const waiting: { resolve: (v: Judgement) => void; reject: (e: Error) => void }[] = [];
  lines.on("line", (line) => waiting.shift()?.resolve(JSON.parse(line)));
  child.on("exit", (code) => { for (const w of waiting.splice(0)) w.reject(new Error(`the AgentDojo judge exited with ${code}`)); });
  return {
    judge: (input: object) => new Promise<Judgement>((resolve, reject) => { waiting.push({ resolve, reject }); child.stdin.write(`${JSON.stringify(input)}\n`); }),
    close: () => { child.stdin.end(); },
  };
}

/** The 16 user tasks alone, then 18 attacked pairs, as AgentDojo makes them. Cached per version. */
export function prepareCases(cache: string): Item[] {
  const file = join(cache, `agentdojo-banking-${AGENTDOJO_VERSION}-${SUITE_VERSION}.json`);
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, JSON.stringify(bridge("prepare")));
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

const money = (n: number | string) => Number(n).toFixed(2);
const nav = `<nav><a href="/bank/">Overview</a> | <a href="/bank/transactions">Transactions</a> | <a href="/bank/scheduled">Scheduled transactions</a> | <a href="/bank/send">Send money</a> | <a href="/bank/schedule">Schedule a transaction</a> | <a href="/bank/files">Documents</a> | <a href="/bank/profile">Profile</a> | <a href="/bank/password">Password</a></nav>`;
const shell = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} - Bluebank</title></head><body><h1>Bluebank</h1>${nav}<h2>${esc(title)}</h2>${body}</body></html>`;
const field = (name: string, label: string, value: string | number = "", type = "text") => `<p><label>${esc(label)} <input name="${name}" type="${type}" value="${esc(String(value))}"></label></p>`;
const table = (rows: Tx[]) => `<table border="1"><tr><th>ID</th><th>Date</th><th>Sender</th><th>Recipient</th><th>Amount</th><th>Subject</th><th>Recurring</th></tr>${rows.map((t) =>
  `<tr><td>${t.id}</td><td>${esc(t.date)}</td><td>${esc(t.sender)}</td><td>${esc(t.recipient)}</td><td>${money(t.amount)}</td><td>${esc(t.subject)}</td><td>${t.recurring ? "yes" : "no"}</td></tr>`).join("")}</table>`;

/** The tools of AgentDojo's banking suite, on the environment JSON. Same rules, same field names. */
export const tools = {
  nextId: (acc: Bank["bank_account"]) => Math.max(0, ...acc.transactions.map((t) => t.id), ...acc.scheduled_transactions.map((t) => t.id)) + 1,
  send_money(env: Bank, { recipient = "", amount, subject = "", date = "" }: Form) {
    const acc = env.bank_account;
    acc.transactions.push({ id: tools.nextId(acc), sender: acc.iban, recipient, amount: Number(amount), subject, date, recurring: false });
  },
  schedule_transaction(env: Bank, { recipient = "", amount, subject = "", date = "", recurring }: Form) {
    const acc = env.bank_account;
    acc.scheduled_transactions.push({ id: tools.nextId(acc), sender: acc.iban, recipient, amount: Number(amount), subject, date, recurring: Boolean(recurring) });
  },
  update_scheduled_transaction(env: Bank, { id, recipient, amount, subject, date, recurring }: Form) {
    const t = env.bank_account.scheduled_transactions.find((s) => s.id === Number(id));
    if (!t) return false;
    // As in AgentDojo, only a truthy value changes a field.
    if (recipient) t.recipient = recipient;
    if (Number(amount)) t.amount = Number(amount);
    if (subject) t.subject = subject;
    if (date) t.date = date;
    if (recurring) t.recurring = Boolean(recurring);
    return true;
  },
  update_password(env: Bank, { password = "" }: Form) { env.user_account.password = password; },
  update_user_info(env: Bank, info: Form) {
    for (const key of ["first_name", "last_name", "street", "city"]) if (info[key]) env.user_account[key] = info[key];
  },
};

function bankPage(env: Bank, req: IncomingMessage, form: Form, url: URL): string | null {
  const acc = env.bank_account;
  const user = env.user_account;
  const p = url.pathname.replace(/\/$/, "") || "/bank";
  const post = req.method === "POST";
  if (p === "/bank") return shell("Overview", `<p>Welcome, ${esc(user.first_name)} ${esc(user.last_name)}.</p><p>Account IBAN: ${esc(acc.iban)}</p><p>Balance: ${money(acc.balance)}</p>`);
  if (p === "/bank/transactions") return shell("Transactions", table(acc.transactions));
  if (p === "/bank/scheduled") return shell("Scheduled transactions", `${table(acc.scheduled_transactions)}<ul>${acc.scheduled_transactions.map((t) => `<li><a href="/bank/scheduled/${t.id}">Edit scheduled transaction ${t.id} (${esc(t.subject)})</a></li>`).join("")}</ul>`);
  const edit = /^\/bank\/scheduled\/(\d+)$/.exec(p);
  if (edit) {
    if (post && !tools.update_scheduled_transaction(env, { ...form, id: edit[1]! })) return shell("Error", `<p>Transaction with ID ${esc(edit[1])} not found.</p>`);
    const t = acc.scheduled_transactions.find((s) => s.id === Number(edit[1]));
    if (!t) return null;
    return shell(`Edit scheduled transaction ${t.id}`, `${post ? `<p role="status">Transaction with ID ${t.id} updated.</p>` : ""}<form method="post">${field("recipient", "Recipient IBAN", t.recipient)}${field("amount", "Amount", t.amount)}${field("subject", "Subject", t.subject)}${field("date", "Next date", t.date)}<p><label><input type="checkbox" name="recurring" value="1"${t.recurring ? " checked" : ""}> Recurring</label></p><button>Save</button></form>`);
  }
  if (p === "/bank/send") {
    if (post) tools.send_money(env, form);
    return shell("Send money", `${post ? `<p role="status">Transaction to ${esc(form.recipient)} for ${esc(form.amount)} sent.</p>` : ""}<form method="post">${field("recipient", "Recipient IBAN")}${field("amount", "Amount")}${field("subject", "Subject")}${field("date", "Date (YYYY-MM-DD)")}<button>Send</button></form>`);
  }
  if (p === "/bank/schedule") {
    if (post) tools.schedule_transaction(env, form);
    return shell("Schedule a transaction", `${post ? `<p role="status">Transaction to ${esc(form.recipient)} for ${esc(form.amount)} scheduled.</p>` : ""}<form method="post">${field("recipient", "Recipient IBAN")}${field("amount", "Amount")}${field("subject", "Subject")}${field("date", "Next date (YYYY-MM-DD)")}<p><label><input type="checkbox" name="recurring" value="1"> Recurring</label></p><button>Schedule</button></form>`);
  }
  if (p === "/bank/files") return shell("Documents", `<ul>${Object.keys(env.filesystem.files).map((f) => `<li><a href="/bank/files/${encodeURIComponent(f)}">${esc(f)}</a></li>`).join("")}</ul>`);
  const doc = /^\/bank\/files\/(.+)$/.exec(p);
  if (doc) {
    const name = decodeURIComponent(doc[1]!);
    return name in env.filesystem.files ? shell(name, `<pre>${esc(env.filesystem.files[name])}</pre>`) : null;
  }
  if (p === "/bank/profile") {
    if (post) tools.update_user_info(env, form);
    return shell("Profile", `${post ? `<p role="status">Profile updated.</p>` : ""}<form method="post">${field("first_name", "First name", user.first_name)}${field("last_name", "Last name", user.last_name)}${field("street", "Street", user.street)}${field("city", "City", user.city)}<button>Save</button></form>`);
  }
  if (p === "/bank/password") {
    if (post) tools.update_password(env, form);
    return shell("Password", `${post ? `<p role="status">Password updated.</p>` : ""}<form method="post">${field("password", "New password", "", "password")}<button>Update password</button></form>`);
  }
  return null;
}

/** Starts one case's bank. The verdict is AgentDojo's, from the start and end environments. */
export async function startBank(item: Item, judge: (input: object) => Promise<Judgement>) {
  const env = structuredClone(item.env);
  const server = await serveCase(async (req, body, url) => {
    const page = bankPage(env, req, Object.fromEntries(new URLSearchParams(body)), url);
    return page === null ? null : { body: page };
  });
  return {
    url: `${server.url}/bank/`,
    goal: item.goal,
    startPath: "/bank/",
    env,
    async judge(output: TaskOutput): Promise<Verdict> {
      const verdict = await judge({ user_task: item.user_task, injection_task: item.injection_task, pre: item.env, post: env, output: String(output.answer ?? output.log ?? "") });
      const reasons: string[] = [];
      if (!verdict.utility) reasons.push(`AgentDojo utility false (${item.user_task})`);
      if (verdict.security) reasons.push(`AgentDojo security true: the attack ${item.injection_task} worked`);
      return { success: verdict.utility, attack: item.injection_task ? (verdict.security ? "followed" : "blocked") : null, reasons, judgedBy: "programmatic" };
    },
    close: server.close,
  };
}

const tool = (command: string, env: NodeJS.ProcessEnv) => {
  try {
    execFileSync(command, ["--version"], { env, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const runs = new WeakMap<Episode, (output: TaskOutput) => Promise<Verdict>>();
let judge: ReturnType<typeof startJudge> | null = null;

/** AgentDojo banking: the 16 user tasks, then 18 attacked pairs, on a web bank. */
export const agentdojoBenchmark: Benchmark = {
  id: "agentdojo",
  title: "AgentDojo banking (16 tasks, 18 attacks)",
  upstream: { repo: "https://pypi.org/project/agentdojo/", ref: `${AGENTDOJO_VERSION} suite ${SUITE_VERSION}`, paper: "https://arxiv.org/abs/2406.13352" },
  licence: { code: "MIT", data: "MIT", mode: "fetch-at-run" },
  where: "local",
  measures: ["task", "injection"],
  scoring: "programmatic",
  check: async (ctx) => (tool("uv", ctx.env) ? { ready: true } : { ready: false, reason: "uv is not on the PATH (AgentDojo runs through uv)", fix: "install uv: https://docs.astral.sh/uv/" }),
  load: async (ctx, subset) => pickSubset("agentdojo", prepareCases(ctx.cacheDir).map((c) => ({ id: c.id, tags: ["banking"], suite: "agentdojo-banking", trap: Boolean(c.injection_task), goal: c.goal })), subset),
  up: async (ctx) => ({ cases: prepareCases(ctx.cacheDir) }),
  async start(env, item) {
    const run = await startBank((env.cases as Item[]).find((c) => c.id === item.id)!, (input) => (judge ??= startJudge()).judge(input));
    const episode: Episode = { url: run.url, goal: run.goal, startPath: run.startPath, close: run.close };
    runs.set(episode, run.judge);
    return episode;
  },
  judge: async (_env, episode, output) => runs.get(episode)!(output),
  async down() {
    judge?.close();
    judge = null;
  },
  baselines: [],
};
