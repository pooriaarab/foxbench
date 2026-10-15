// The recording proxy. The agent gets its 127.0.0.1 URL; it forwards each
// request to the case's site and logs it, so every benchmark gets the same
// trace and metrics. It adds the headers a benchmark asks for (auto-login)
// without the agent seeing them. The same port works as the HTTP proxy of the
// agent's browser: a request to any other host is forwarded, or tunnelled for
// CONNECT, and logged as egress. It never decrypts.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import type { Replacement, TraceEntry } from "./types.js";
import { serveUser, USER_PATH, type UserChannel } from "./user.js";

export interface RecordingProxy {
  /** The proxy's origin, http://127.0.0.1:<port>. */
  origin: string;
  trace: TraceEntry[];
  close(): Promise<void>;
}

export async function startProxy(target: string, options: { headers?: Record<string, string>; port?: number; user?: UserChannel; replace?: Replacement[] } = {}): Promise<RecordingProxy> {
  const site = new URL(target);
  const trace: TraceEntry[] = [];
  const started = Date.now();
  let origin = "";
  const tunnels = new Set<{ destroy(): void }>();
  const server = createServer((req, res) => {
    // An absolute URL means a browser uses this as its HTTP proxy.
    const absolute = /^https?:\/\//i.test(req.url ?? "");
    const asked = new URL(req.url ?? "/", absolute ? undefined : site);
    const egress = absolute && asked.origin !== origin && asked.origin !== site.origin;
    const to = egress ? asked : new URL(asked.pathname + asked.search, site);
    const entry: TraceEntry = { method: req.method ?? "GET", host: to.host, path: to.pathname, status: 502, bytes: 0, type: "", egress, at: Date.now() - started };
    trace.push(entry);
    // The user's chat is the proxy's own page, on the agent's origin (Q1).
    if (options.user && !egress && to.pathname === USER_PATH) {
      entry.type = "text/html";
      void serveUser(options.user, req, res).then((status) => { entry.status = status; });
      return;
    }
    // A listed path is the proxy's own answer, for GET only and never for another host (P7, P8).
    const swap = !egress && entry.method === "GET" ? options.replace?.find((r) => r.path === to.pathname) : undefined;
    if (swap) {
      entry.status = 200;
      entry.type = swap.type;
      entry.bytes = swap.body.length;
      res.writeHead(200, { "content-type": swap.type, "content-length": swap.body.length, "cache-control": "no-store" }).end(swap.body);
      return;
    }
    const send = to.protocol === "https:" ? httpsRequest : httpRequest;
    const out = send(to, { method: entry.method, headers: { ...req.headers, host: to.host, ...(egress ? {} : options.headers) } }, (up) => {
      entry.status = up.statusCode ?? 502;
      entry.type = String(up.headers["content-type"] ?? "").split(";")[0]!;
      // A redirect to the site's own origin comes back through the proxy.
      const location = up.headers.location;
      if (!egress && location?.startsWith(site.origin)) up.headers.location = origin + location.slice(site.origin.length);
      res.writeHead(entry.status, up.headers);
      up.on("data", (chunk: Buffer) => { entry.bytes += chunk.length; });
      up.pipe(res);
    });
    out.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway"); });
    req.pipe(out);
  });
  server.on("connect", (req, socket, head) => {
    const [host = "", port = "443"] = (req.url ?? "").split(":");
    const entry: TraceEntry = { method: "CONNECT", host: req.url ?? "", path: "", status: 502, bytes: 0, type: "", egress: true, at: Date.now() - started };
    trace.push(entry);
    tunnels.add(socket);
    const up = connect(Number(port), host, () => {
      entry.status = 200;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    socket.on("data", (chunk: Buffer) => { entry.bytes += chunk.length; });
    up.on("data", (chunk: Buffer) => { entry.bytes += chunk.length; });
    tunnels.add(up);
    up.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    socket.on("error", () => up.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE" && options.port
      ? new Error(`port ${options.port} is in use, and this case needs its proxy there (the site keeps one origin); multi-site WebArena-Verified cases must run serially or on separate hosts`)
      : error));
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    trace,
    close: () => new Promise((resolve) => {
      for (const t of tunnels) t.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
