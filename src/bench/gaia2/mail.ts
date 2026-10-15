// The mail pages, over ARE's Emails app: folders with paging, search, a
// message with its forms, and compose.
import { commas, done, esc, form, input, next, stamp, type Handler } from "./pages.js";

const FOLDERS = ["INBOX", "SENT", "DRAFT", "TRASH"];
const LIMIT = 10;
interface Mail { email_id: string; sender: string; recipients: string[]; cc: string[]; subject: string; content: string; timestamp: number; attachments: Record<string, unknown> | null }
const row = (folder: string, m: Mail) => `<li><a href="/mail/${folder}/${esc(m.email_id)}">${esc(m.subject)}</a> from ${esc(m.sender)}, ${stamp(m.timestamp)}</li>`;
const to = input("recipients", "To (commas)");
const text = `<p><label>Message <textarea name="content"></textarea></label></p>`;
const attach = input("attachment_paths", "Attach files (paths, commas)");

export const mail: Handler = async (api, { path, query, form: posted }) => {
  const folder = query.get("folder") ?? "INBOX";
  if (path === "/mail") {
    const offset = Number(query.get("offset") ?? 0);
    const q = query.get("q");
    const found = q ? await api.call("Emails", "search_emails", { query: q, folder_name: folder }) : await api.call("Emails", "list_emails", { folder_name: folder, offset, limit: LIMIT });
    const emails: Mail[] = Array.isArray(found) ? found : found.emails;
    const folders = FOLDERS.map((f) => `<a href="/mail?folder=${f}">${f}</a>`).join(" · ");
    const search = `<form><input type="hidden" name="folder" value="${esc(folder)}">${input("q", "Search this folder")}<button>Search</button></form>`;
    return { title: `Mail: ${folder}${q ? ` matching ${q}` : ""}`, body: `<p>${folders} · <a href="/mail/compose">Compose</a></p>${search}<ol>${emails.map((m) => row(folder, m)).join("")}</ol>${Array.isArray(found) ? "" : next(path, query, offset, emails.length, found.total_emails)}` };
  }
  if (path === "/mail/compose") {
    if (!posted) return { title: "Compose", body: form("/mail/compose", "Send", to + input("cc", "Cc (commas)") + input("subject", "Subject") + text + attach) };
    return done(await api.call("Emails", "send_email", { recipients: commas(posted.get("recipients")), cc: commas(posted.get("cc")), subject: posted.get("subject"), content: posted.get("content"), attachment_paths: commas(posted.get("attachment_paths")) }));
  }
  const m = /^\/mail\/(\w+)\/(\w+)(?:\/(reply|forward|move|delete))?$/.exec(path);
  if (!m) return null;
  const [, box, id, action] = m as unknown as [string, string, string, string | undefined];
  const base = `/mail/${box}/${id}`;
  const args = { email_id: id, folder_name: box };
  if (posted && action) {
    if (action === "reply") return done(await api.call("Emails", "reply_to_email", { ...args, content: posted.get("content"), attachment_paths: commas(posted.get("attachment_paths")) }));
    if (action === "forward") return done(await api.call("Emails", "forward_email", { ...args, recipients: commas(posted.get("recipients")) }));
    if (action === "move") return done(await api.call("Emails", "move_email", { email_id: id, source_folder_name: box, dest_folder_name: posted.get("dest_folder_name") }));
    return done(await api.call("Emails", "delete_email", args));
  }
  const e: Mail = await api.call("Emails", "get_email_by_id", args);
  return { title: e.subject, body: `<p>From ${esc(e.sender)} to ${esc(e.recipients.join(", "))}${e.cc.length ? `, cc ${esc(e.cc.join(", "))}` : ""}, ${stamp(e.timestamp)}</p><pre>${esc(e.content)}</pre>${e.attachments && Object.keys(e.attachments).length ? `<p>Attachments: ${esc(Object.keys(e.attachments).join(", "))}</p>` : ""}`
    + form(`${base}/reply`, "Reply", text + attach) + form(`${base}/forward`, "Forward", to)
    + form(`${base}/move`, "Move", input("dest_folder_name", `Move to (${FOLDERS.join(", ")})`)) + form(`${base}/delete`, "Delete", "") };
};
