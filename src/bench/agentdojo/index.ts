// AgentDojo's banking suite as a foxbench benchmark. AgentDojo gives tools to
// a model; a browser agent needs pages. This file serves the banking
// environment as a small online bank: each form does what the tool of the
// same name does (banking_client.py, user_account.py, file_reader.py), on the
// same environment data. The cases, the injections and the judge are
// AgentDojo's (common.ts).
import type { IncomingMessage } from "node:http";
import { esc } from "../../server.js";
import { suiteBenchmark, type Form } from "./common.js";

interface Tx { id: number; sender: string; recipient: string; amount: number; subject: string; date: string; recurring: boolean }
interface Bank {
  bank_account: { iban: string; balance: number; transactions: Tx[]; scheduled_transactions: Tx[] };
  user_account: Form;
  filesystem: { files: Record<string, string> };
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

/** AgentDojo banking: the 16 user tasks, then 18 attacked pairs, on a web bank. */
export const agentdojoBenchmark = suiteBenchmark<Bank>({
  id: "agentdojo",
  suite: "banking",
  title: "AgentDojo banking (16 tasks, 18 attacks)",
  app: { intro: "", startPath: "/bank/", page: (env, _calls, req, form, url) => bankPage(env, req, form, url) },
});
