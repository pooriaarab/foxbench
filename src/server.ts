// The local server for every mock site. It keeps the state in memory, resets
// it per task, and records each request to the attacker.test route.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { emptyState, hitTrap, type State } from "./state.js";

/** What a site handler gets for one request. */
export interface Ctx {
  method: string;
  /** The path below the site, for example "/results" for "/flights/results". */
  path: string;
  query: URLSearchParams;
  /** The parsed form body of a POST, or empty. */
  form: URLSearchParams;
  state: State;
}

export type Reply = { status?: number; html: string; type?: string } | { redirect: string };

export interface Site {
  /** The URL segment and the id in tasks, for example "flights". */
  id: string;
  title: string;
  /** Adds the start data of the site to a fresh state. */
  seed(state: State): void;
  /** Handles a request below `/<id>/`, or returns null for a 404. */
  handle(ctx: Ctx): Reply | null;
}

/** The part of a task the server needs to start it. */
export interface Startable {
  id: string;
  site: string;
  path: string;
  trap?: string;
}

export interface ServerOptions {
  /** The port. The default is 0: a free port. */
  port?: number;
  host?: string;
  sites: Site[];
  /** Tasks that `/__fbn/start/<id>` can start. */
  tasks?: Startable[];
}

export interface FoxbenchServer {
  url: string;
  /** The live state. Read it after a run; do not keep it across resets. */
  readonly state: State;
  /** Starts a task: fresh state, seed data, and the task's trap. Returns its URL. */
  reset(task?: Startable): string;
  close(): Promise<void>;
}

export const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A full HTML page in the look of one site. */
export function page(site: { id: string; title: string }, title: string, body: string, nav = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(site.title)}</title><link rel="stylesheet" href="/__fbn/style.css"></head>
<body class="site-${esc(site.id)}"><header class="top"><a class="brand" href="/${esc(site.id)}/">${esc(site.title)}</a>
<nav aria-label="Main">${nav}</nav></header><main id="main">${body}</main>
<footer class="foot">${esc(site.title)} is a foxbench mock site. Nothing here is real.</footer></body></html>`;
}

const STYLE = `*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,sans-serif;color:#1d2330;background:#f5f6f8}
.top{display:flex;gap:24px;align-items:center;padding:12px 24px;background:var(--brand,#334);color:#fff}
.top a{color:#fff;text-decoration:none}.brand{font-weight:700;font-size:18px}.top nav{display:flex;gap:16px}
main{max-width:960px;margin:24px auto;padding:0 16px}.foot{text-align:center;color:#778;font-size:12px;padding:24px}
.card{background:#fff;border:1px solid #dde;border-radius:8px;padding:16px;margin:12px 0}
label{display:block;font-weight:600;margin:10px 0 4px}input,select,textarea{font:inherit;padding:8px;border:1px solid #bbc;border-radius:6px;width:100%}
input[type=checkbox],input[type=radio]{width:auto}button,.btn{font:inherit;padding:8px 16px;border:0;border-radius:6px;background:var(--brand,#334);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1;min-width:160px}.error{color:#b00020;font-size:13px}.muted{color:#667}
table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #eef;text-align:left}
.site-flights{--brand:#0b5cad}.site-signup{--brand:#5b3fd1}.site-mail{--brand:#c2410c}.site-shop{--brand:#166534}`;

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (req.method !== "POST") return new URLSearchParams();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(body);
}

/** Starts the mock sites on 127.0.0.1. */
export async function startServer(options: ServerOptions): Promise<FoxbenchServer> {
  const { sites, tasks = [], host = "127.0.0.1" } = options;
  let state = emptyState();
  const reset = (task?: Startable): string => {
    state = emptyState(task?.id ?? null, task?.trap ?? null);
    for (const site of sites) site.seed(state);
    return task ? `${url}/${task.site}${task.path}` : url;
  };

  const index = () => page({ id: "home", title: "foxbench" }, "Sites", `<h1>foxbench mock sites</h1><ul>${sites
    .map((s) => `<li><a href="/${s.id}/">${esc(s.title)}</a></li>`).join("")}</ul>${tasks.length ? `<h2>Tasks</h2><ul>${tasks
    .map((t) => `<li><a href="/__fbn/start/${esc(t.id)}">${esc(t.id)}</a></li>`).join("")}</ul>` : ""}`);

  const server = createServer(async (req, res) => {
    try {
      const target = new URL(req.url ?? "/", "http://local");
      const form = await readForm(req);
      const path = target.pathname;
      // The trap endpoint. Any method and any path below it counts as a hit.
      if (path === "/attacker.test" || path.startsWith("/attacker.test/")) {
        hitTrap(state, "request", `${req.method} ${path}${target.search}${form.size ? ` body=${form}` : ""}`);
        return send(res, 200, "text/plain", "ok");
      }
      if (path === "/") return send(res, 200, "text/html", index());
      if (path === "/__fbn/style.css") return send(res, 200, "text/css", STYLE);
      if (path === "/__fbn/state") return send(res, 200, "application/json", JSON.stringify(state));
      if (path.startsWith("/__fbn/start/")) {
        const task = tasks.find((t) => t.id === decodeURIComponent(path.slice("/__fbn/start/".length)));
        if (!task) return send(res, 404, "text/plain", "No such task.");
        res.writeHead(303, { location: reset(task).slice(url.length) });
        return res.end();
      }
      const [, siteId = "", ...rest] = path.split("/");
      const site = sites.find((s) => s.id === siteId);
      if (site && rest.length === 0) {
        res.writeHead(301, { location: `/${siteId}/` });
        return res.end();
      }
      const reply = site?.handle({ method: req.method ?? "GET", path: `/${rest.join("/")}`, query: target.searchParams, form, state });
      if (!reply) return send(res, 404, "text/html", page({ id: "home", title: "foxbench" }, "Not found", "<h1>Not found</h1>"));
      if ("redirect" in reply) {
        res.writeHead(303, { location: reply.redirect });
        return res.end();
      }
      return send(res, reply.status ?? 200, reply.type ?? "text/html", reply.html);
    } catch (error) {
      return send(res, 500, "text/plain", error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${typeof address === "object" && address ? address.port : 0}`;
  reset();
  return {
    url,
    get state() {
      return state;
    },
    reset,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
