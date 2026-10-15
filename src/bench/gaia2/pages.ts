// What the app pages share: the page and request shapes, one tool call that
// throws ARE's own error, and small HTML pieces. A page view makes one read
// call and a form makes one write call (GP1); the arguments go to ARE's tool
// as the form gave them, so ARE's own judge scores what the pages did.
export interface Req { path: string; query: URLSearchParams; /** The posted form, or null for a GET. */ form: URLSearchParams | null }
export interface Page { title: string; body: string; status?: number }
export interface Api { call(app: string, tool: string, args?: Record<string, unknown>): Promise<any> }
/** A page for one app: null when the path is not its own. */
export type Handler = (api: Api, req: Req) => Promise<Page | null>;
/** ARE's tool raised: the page shows its message with status 400, and nothing changed (GP5). */
export class ToolError extends Error {}

export const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const input = (name: string, label: string, value: unknown = "", extra = "") => `<p><label>${esc(label)} <input name="${name}" value="${esc(value)}"${extra}></label></p>`;
export const form = (action: string, title: string, inner: string) => `<form method="post" action="${esc(action)}"><h2>${esc(title)}</h2>${inner}<p><button type="submit">${esc(title)}</button></p></form>`;
export const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
/** A comma separated field as a list, without blanks. */
export const commas = (text: string | null) => (text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const done = (value: unknown): Page => ({ title: "Done", body: `<pre>${esc(typeof value === "string" ? value : JSON.stringify(value))}</pre>` });
/** `?offset=` paging for a list the tool pages with offset and limit. */
export const next = (path: string, query: URLSearchParams, offset: number, shown: number, total: number) =>
  offset + shown < total ? `<p><a href="${esc(path)}?${new URLSearchParams({ ...Object.fromEntries(query), offset: String(offset + shown) })}">Next</a></p>` : "";
