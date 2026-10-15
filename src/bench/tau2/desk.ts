// The parts every tau2 support desk shares: one server per case, every tool
// call recorded in order, a page that shows a tool's result or tau2's error,
// and plain forms. retail.ts and airline.ts bring their routes and forms.
import type { IncomingMessage } from "node:http";
import { serveCase } from "../serve.js";
import type { Tau2Bridge, Tau2Reply } from "./bridge.js";

/** `at` is performance.now() when the call ran, to order it among the chat lines. */
export interface Tau2Call { name: string; arguments: Record<string, unknown>; content: string; error: boolean; at: number }

export interface Tau2Site {
  origin: string;
  /** Every tool call the pages made since the last reset, in order. */
  calls: Tau2Call[];
  /** A fresh tau2 environment and no calls (T5). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export type Page = { status: number; html: string };

export const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const field = (name: string, label = name) => `<p><label>${esc(label)} <input name="${name}"></label></p>`;
export const formOf = (action: string, title: string, inner: string) => `<form method="post" action="${esc(action)}"><h2>${esc(title)}</h2>${inner}<p><button type="submit">${esc(title)}</button></p></form>`;
export const parse = (content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
};

/** Any tool result as nested lists. `link` turns an id into a link, or returns null (T6). */
export function show(value: unknown, link: (text: string, key: string) => string | null, key = ""): string {
  if (Array.isArray(value)) return `<ul>${value.map((v) => `<li>${show(v, link, key)}</li>`).join("")}</ul>`;
  if (value && typeof value === "object") return `<dl>${Object.entries(value).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${show(v, link, k)}</dd>`).join("")}</dl>`;
  const href = link(String(value), key);
  return href ? `<a href="${esc(href)}">${esc(value)}</a>` : esc(value);
}

export interface Desk {
  /** One tool call, recorded. */
  call(name: string, args: Record<string, unknown>): Promise<Tau2Reply>;
  /** The page for one read: the tool's result, or its error with 400. */
  read(title: string, name: string, args: Record<string, unknown>, more?: (value: unknown) => string): Promise<Page>;
  /** The page for one write. */
  write(name: string, args: Record<string, unknown>): Promise<Page>;
  page(title: string, body: string): string;
}

export async function startDesk(bridge: Tau2Bridge, o: { nav: string; link: (text: string, key: string) => string | null },
  handle: (desk: Desk, req: IncomingMessage, body: string, url: URL) => Promise<Page>): Promise<Tau2Site> {
  const calls: Tau2Call[] = [];
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Support desk</title></head>
<body><header><a href="/">Support desk</a> · ${o.nav} · <a href="/policy">Policy</a> · <a href="/calculator">Calculator</a> · <a href="/transfer">Transfer to a human</a></header>
<main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  const alert = (title: string, text: string) => ({ status: 400, html: page(title, `<p role="alert">${esc(text)}</p>`) });
  const desk: Desk = {
    page,
    async call(name, args) {
      const reply = await bridge.call(name, args);
      calls.push({ name, arguments: args, ...reply, at: performance.now() });
      return reply;
    },
    async read(title, name, args, more = () => "") {
      const reply = await desk.call(name, args);
      if (reply.error) return alert(title, reply.content);
      const value = parse(reply.content);
      return { status: 200, html: page(title, show(value, o.link) + more(value)) };
    },
    async write(name, args) {
      const reply = await desk.call(name, args);
      return reply.error ? alert("Not done", reply.content) : { status: 200, html: page("Done", show(parse(reply.content), o.link)) };
    },
  };
  const site = await serveCase(async (req, body, url) => {
    try {
      const { status, html } = await handle(desk, req, body, url);
      return { status, body: html };
    } catch (error) {
      // A dead bridge is a harness fault, never a tool error (T7).
      return { status: 502, type: "text/plain", body: error instanceof Error ? error.message : String(error) };
    }
  });
  return { origin: site.url, calls, reset: async () => { calls.length = 0; await bridge.reset(); }, close: site.close };
}

/** The pages both domains have: the policy, the calculator and the transfer. Null for another path. */
export function commonPage(desk: Desk, path: string, q: (name: string) => string, policy: string): Promise<Page> | Page | null {
  if (path === "/policy") return { status: 200, html: desk.page("Policy", `<pre>${esc(policy)}</pre>`) };
  if (path === "/calculator") {
    return q("expression") ? desk.read("Calculator", "calculate", { expression: q("expression") }) : { status: 200, html: desk.page("Calculator", `<form>${field("expression", "Expression")}<p><button>Calculate</button></p></form>`) };
  }
  if (path === "/transfer") return { status: 200, html: desk.page("Transfer to a human", formOf("/transfer", "Transfer", `<p><label>Summary <textarea name="summary"></textarea></label></p>`)) };
  return null;
}
