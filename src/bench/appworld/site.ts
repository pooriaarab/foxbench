// AppWorld's apps as web pages, built at run time from AppWorld's own API
// docs, so the repo holds no AppWorld text. Each app lists its APIs; each API
// has a page with a form of its parameters. A form post runs the API; a page
// view runs only a read API (method GET), from its form (AW10). Each call
// goes to AppWorld through the bridge, and the page shows what it returned,
// as lists and as JSON. Everything beyond that is read off the docs too: ids
// in a result link to the page that takes them, free text gets a textarea, and
// a full page of a list links to the next (AW14-AW16).
import { serveCase } from "../serve.js";
import { esc, show } from "../tau2/desk.js";
import type { ApiDoc, AppWorldBridge, AppWorldTask } from "./bridge.js";

export interface AppWorldSite {
  origin: string;
  /** Settles when the agent has called complete_task (AW12). */
  completed: Promise<void>;
  close(): Promise<void>;
}

const RUN = "_run";
const LONG_TEXT = /^(body|text|content|description|message|comment|note|review|reply|answer)$/;
const PAGE = "page_index";
const SIZE = "page_limit";

const runUrl = (app: string, name: string, args: Iterable<[string, string]>) => `/${app}/${name}?${new URLSearchParams([...args, [RUN, "1"]])}`;
const needs = (doc: ApiDoc, skip: string) => doc.parameters.filter((p) => p.required && p.name !== "access_token" && p.name !== skip).length;

/** The page that takes the id a result key holds, as a link, or null (AW14). `x_id` tries `x_id`, then each shorter tail but never a bare `id`. */
function idLink(app: string, docs: ApiDoc[], text: string, key: string): string | null {
  if (!/^\d+$/.test(text) || !/_ids?$/.test(key)) return null;
  const parts = key.replace(/_ids$/, "_id").split("_");
  for (let i = 0; i < parts.length - 1; i++) {
    const field = parts.slice(i).join("_");
    const takers = docs.filter((d) => d.parameters.some((p) => p.name === field))
      .toSorted((a, b) => Number(b.method === "GET") - Number(a.method === "GET") || needs(a, field) - needs(b, field) || a.name.length - b.name.length || a.name.localeCompare(b.name));
    const doc = takers[0];
    if (!doc) continue;
    const query = new URLSearchParams([[field, text]]);
    return doc.method === "GET" && needs(doc, field) === 0 ? runUrl(app, doc.name, query) : `/${app}/${doc.name}?${query}`;
  }
  return null;
}

/** Previous and next page links of a read API that pages, when this page is full (AW16). */
function pager(app: string, doc: ApiDoc, args: [string, string][], result: unknown): string {
  const names = doc.parameters.map((p) => p.name);
  if (doc.method !== "GET" || !names.includes(PAGE) || !names.includes(SIZE) || !Array.isArray(result)) return "";
  const num = (name: string) => Number(args.find(([k]) => k === name)?.[1] || doc.parameters.find((p) => p.name === name)?.default || 0);
  const at = (index: number) => runUrl(app, doc.name, args.some(([k]) => k === PAGE) ? args.map(([k, v]): [string, string] => [k, k === PAGE ? String(index) : v]) : [...args, [PAGE, String(index)]]);
  const links = [num(PAGE) > 0 ? `<a href="${esc(at(num(PAGE) - 1))}">Previous page</a>` : "", num(SIZE) > 0 && result.length >= num(SIZE) ? `<a href="${esc(at(num(PAGE) + 1))}">Next page</a>` : ""];
  return `<nav>${links.filter(Boolean).join(" · ")}</nav>`;
}

function form(app: string, doc: ApiDoc, values: URLSearchParams): string {
  const get = doc.method === "GET";
  const fields = doc.parameters.map((p) => {
    const value = values.get(p.name) ?? "";
    const input = p.type === "string" && LONG_TEXT.test(p.name) ? `<textarea name="${esc(p.name)}">${esc(value)}</textarea>` : `<input name="${esc(p.name)}"${value ? ` value="${esc(value)}"` : ""}${p.name === "access_token" ? ' placeholder="filled from your sign-in when blank"' : ""}>`;
    return `<p><label>${esc(p.name)} (${esc(p.type)}${p.required ? ", required" : ""}) ${input}</label>
<small>${esc(p.description)}${p.default === null || p.default === undefined ? "" : ` Default: ${esc(JSON.stringify(p.default))}.`}</small></p>`;
  }).join("");
  return `<form method="${get ? "get" : "post"}" action="/${esc(app)}/${esc(doc.name)}">${get ? `<input type="hidden" name="${RUN}" value="1">` : ""}${fields}<p><button type="submit">${esc(doc.name)}</button></p></form>`;
}

export async function startAppWorldSite(bridge: AppWorldBridge, task: AppWorldTask): Promise<AppWorldSite> {
  let done: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { done = resolve; });
  const page = (title: string, body: string, status = 200) => ({ status, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Apps</title></head>
<body><header><a href="/">Apps</a> · ${Object.keys(task.apps).map((a) => `<a href="/${esc(a)}/">${esc(a)}</a>`).join(" · ")}</header><main><h1>${esc(title)}</h1>${body}</main></body></html>` });
  const site = await serveCase(async (req, body, url) => {
    const [app = "", api = ""] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!app) return page("Apps", `<ul>${Object.keys(task.apps).map((a) => `<li><a href="/${esc(a)}/">${esc(a)}</a></li>`).join("")}</ul>`);
    const docs = task.apps[app];
    if (!docs) return page("Not found", "", 404);
    if (!api) return page(app, `<ul>${docs.map((d) => `<li><a href="/${esc(app)}/${esc(d.name)}">${esc(d.name)}</a>: ${esc(d.description)}</li>`).join("")}</ul>`);
    const doc = docs.find((d) => d.name === api);
    if (!doc) return page("Not found", "", 404);
    const post = req.method === "POST";
    const args = post ? new URLSearchParams(body) : url.searchParams;
    const shown = [...args].filter(([k]) => k !== RUN);
    let result = "";
    let status = 200;
    if (post || (doc.method === "GET" && url.searchParams.has(RUN))) {
      try {
        const reply = await bridge.call(app, api, Object.fromEntries(shown));
        if (reply.completed) done?.();
        status = reply.error === undefined ? 200 : 400;
        result = reply.error === undefined ? `<section><h2>Result</h2>${show(reply.result, (text, key) => idLink(app, docs, text, key))}${pager(app, doc, shown, reply.result)}<script type="application/json" id="result">${esc(reply.json ?? JSON.stringify(reply.result))}</script></section>` : `<p role="alert">${esc(reply.error)}</p>`;
      } catch (error) {
        // A dead bridge is a harness fault, never an API error (AW13).
        return { status: 502, type: "text/plain", body: error instanceof Error ? error.message : String(error) };
      }
    }
    return page(`${app}: ${api}`, `<p>${esc(doc.description)}</p>${result}${form(app, doc, args)}`, status);
  });
  return { origin: site.url, completed, close: site.close };
}
