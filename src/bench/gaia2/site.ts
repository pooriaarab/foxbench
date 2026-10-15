// The pages of one gaia2 case: the notification feed, and every app and tool
// ARE gives the agent as a plain form. A read is a GET, a write is a POST.
// The pages only collect arguments; ARE's own tool code runs them (G3).
import { serveCase } from "../serve.js";
import type { Gaia2Bridge, Gaia2Tool } from "./bridge.js";
import { calendar } from "./calendar.js";
import { contacts } from "./contacts.js";
import { mail } from "./mail.js";
import { esc, ToolError, type Api, type Handler } from "./pages.js";

/** The apps that have pages of their own; every other app, and every tool, stays on the generic forms. */
const HANDLERS: Handler[] = [mail, calendar, contacts];
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><header><a href="/">Phone</a> · <a href="/mail">Mail</a> · <a href="/calendar">Calendar</a> · <a href="/contacts">Contacts</a> · <a href="/notifications">Notifications</a> · <a href="/apps">All tools</a></header><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
const html = (status: number, title: string, inner: string) => ({ status, body: page(title, inner) });
/** wait_for_notification moves ARE's clock, so it is a POST although ARE calls it a read. */
const isWrite = (t: Gaia2Tool) => t.write || t.name === "wait_for_notification";

export const goal = "You are the assistant on the user's phone. The user's messages arrive in the feed at /notifications, and so do events from the apps while you work "
  + "(a new email, a reply, a delivered order). Use the apps at /apps to do what the user asks: each tool is a form. Tell the user the result with AgentUserInterface send_message_to_user, "
  + "and ask there when something is unclear. Some tasks need waiting: SystemApp wait_for_notification jumps to the next event.";

export async function startSite(bridge: Gaia2Bridge, tools: Gaia2Tool[]): Promise<{ origin: string; close(): Promise<void> }> {
  const apps = [...new Set(tools.map((t) => t.app))];
  // Form text for ARE: strings as they are, everything else as JSON; a blank argument is left out.
  const api: Api = { call: async (app, tool, args = {}) => {
    const reply = await bridge.call(app, tool, Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])));
    if (reply.error) throw new ToolError(reply.content);
    return JSON.parse(reply.content);
  } };
  const site = await serveCase(async (req, body, url) => {
    const path = url.pathname;
    try {
      if (path === "/") return html(200, "Phone", `<p>${esc(goal)}</p>`);
      if (path === "/apps") return html(200, "Apps", `<ul>${apps.map((a) => `<li><a href="/apps/${esc(a)}">${esc(a)}</a></li>`).join("")}</ul>`);
      if (path === "/notifications") return html(200, "Notifications", `<ol>${(await bridge.notifications()).map((n) => `<li>${esc(n.type)} at ${Math.round(n.at)} s: ${esc(n.message)}</li>`).join("")}</ol>`);
      for (const handler of HANDLERS) {
        const found = await handler(api, { path, query: url.searchParams, form: req.method === "POST" ? new URLSearchParams(body) : null });
        if (found) return html(found.status ?? 200, found.title, found.body);
      }
      const m = /^\/apps\/(\w+)(?:\/(\w+))?$/.exec(path);
      if (!m) return null;
      const app = tools.filter((t) => t.app === m[1]);
      const tool = app.find((t) => t.name === m[2]);
      if (!m[2]) return app.length ? html(200, m[1]!, `<ul>${app.map((t) => `<li><a href="${path}/${esc(t.name)}">${esc(t.name)}</a>${isWrite(t) ? " (changes things)" : ""}: ${esc(t.description?.split("\n")[0] ?? "")}</li>`).join("")}</ul>`) : null;
      if (!tool) return null;
      const write = isWrite(tool);
      const form = `<form method="${write ? "post" : "get"}" action="${esc(path)}"><p>${esc(tool.description ?? "")}</p><input type="hidden" name="go" value="1">${tool.args.map((a) =>
        `<p><label>${esc(a.name)} (${esc(a.type)}${a.required ? "" : ", optional"}): ${esc(a.description ?? "")} <input name="${esc(a.name)}"></label></p>`).join("")}<p><button type="submit">${esc(tool.name)}</button></p></form>`;
      const sent = new URLSearchParams(write ? body : url.search);
      if (req.method !== (write ? "POST" : "GET") || !sent.has("go")) return html(200, `${m[1]} ${tool.name}`, form);
      const reply = await bridge.call(tool.app, tool.name, Object.fromEntries(tool.args.flatMap((a) => (sent.has(a.name) ? [[a.name, sent.get(a.name)!]] : []))));
      return html(reply.error ? 400 : 200, `${m[1]} ${tool.name}`, `${form}<h2>Result</h2><pre>${esc(reply.content)}</pre>`);
    } catch (error) {
      if (error instanceof ToolError) return html(400, "Not done", `<p role="alert">${esc(error.message)}</p>`);
      return { status: 502, type: "text/plain", body: error instanceof Error ? error.message : String(error) };
    }
  });
  return { origin: site.url, close: site.close };
}
