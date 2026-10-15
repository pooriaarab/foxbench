// AppWorld's apps as web pages, built at run time from AppWorld's own API
// docs, so the repo holds no AppWorld text. Each app lists its APIs; each API
// has a page with a form of its parameters. A form post runs the API; a page
// view runs only a read API (method GET), from its form (AW10). Each call
// goes to AppWorld through the bridge, and the page shows what it returned,
// as lists and as JSON.
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
const noLink = () => null;

function form(app: string, doc: ApiDoc): string {
  const get = doc.method === "GET";
  const fields = doc.parameters.map((p) => `<p><label>${esc(p.name)} (${esc(p.type)}${p.required ? ", required" : ""}) <input name="${esc(p.name)}"${p.name === "access_token" ? ' placeholder="filled from your sign-in when blank"' : ""}></label>
<small>${esc(p.description)}${p.default === null || p.default === undefined ? "" : ` Default: ${esc(JSON.stringify(p.default))}.`}</small></p>`).join("");
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
    let result = "";
    let status = 200;
    if (post || (doc.method === "GET" && url.searchParams.has(RUN))) {
      try {
        const reply = await bridge.call(app, api, Object.fromEntries([...args].filter(([k]) => k !== RUN)));
        if (reply.completed) done?.();
        status = reply.error === undefined ? 200 : 400;
        result = reply.error === undefined ? `<section><h2>Result</h2>${show(reply.result, noLink)}<script type="application/json" id="result">${esc(reply.json ?? JSON.stringify(reply.result))}</script></section>` : `<p role="alert">${esc(reply.error)}</p>`;
      } catch (error) {
        // A dead bridge is a harness fault, never an API error (AW13).
        return { status: 502, type: "text/plain", body: error instanceof Error ? error.message : String(error) };
      }
    }
    return page(`${app}: ${api}`, `<p>${esc(doc.description)}</p>${result}${form(app, doc)}`, status);
  });
  return { origin: site.url, completed, close: site.close };
}
