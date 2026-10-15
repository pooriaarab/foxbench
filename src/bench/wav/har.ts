// A HAR recorder for one site of a case. It sits behind the recording proxy
// and logs each request in the HAR shape upstream's NetworkEventEvaluator
// reads: the URL the agent saw, query, request headers, post data, status,
// response headers and cookies, redirect URL, and JSON bodies.
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

type Pairs = { name: string; value: string }[];
export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; httpVersion: string; headers: Pairs; queryString: Pairs; cookies: Pairs; postData?: { mimeType: string; text: string }; headersSize: number; bodySize: number };
  response: { status: number; statusText: string; httpVersion: string; headers: Pairs; cookies: Pairs; content: { size: number; mimeType: string; text?: string }; redirectURL: string; headersSize: number; bodySize: number };
}
export interface HarRecorder {
  origin: string;
  entries: HarEntry[];
  close(): Promise<void>;
}

const pairs = (headers: IncomingHttpHeaders, drop: (name: string) => boolean = () => false): Pairs =>
  Object.entries(headers).flatMap(([name, v]) => (drop(name) ? [] : [v ?? ""].flat().map((value) => ({ name, value: String(value) }))));
// The login the proxy adds never goes in the HAR file (WJ3).
const secret = (name: string) => name === "cookie" || name.endsWith("-auto-login");

function decode(body: Buffer, encoding: string | undefined): string {
  const raw = encoding === "gzip" ? gunzipSync(body) : encoding === "br" ? brotliDecompressSync(body) : encoding === "deflate" ? inflateSync(body) : body;
  return raw.toString("utf8");
}

/** Forwards to `target` and records each request with its URL on `site`, the origin the agent sees. */
export async function startHar(target: string, site: string): Promise<HarRecorder> {
  const entries: HarEntry[] = [];
  const server = createServer(async (req, res) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", site);
    const type = String(req.headers["content-type"] ?? "");
    const out = request(new URL(url.pathname + url.search, target), { method: req.method, headers: req.headers }, async (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      const back: Buffer[] = [];
      for await (const chunk of up) {
        back.push(chunk as Buffer);
        res.write(chunk);
      }
      res.end();
      const content = Buffer.concat(back);
      const mimeType = String(up.headers["content-type"] ?? "");
      let text: string | undefined;
      try {
        if (mimeType.includes("json")) text = decode(content, up.headers["content-encoding"]);
      } catch {
        text = undefined;
      }
      entries.push({
        startedDateTime: new Date(started).toISOString(), time: Date.now() - started,
        request: { method: req.method ?? "GET", url: url.href, httpVersion: `HTTP/${req.httpVersion}`, headers: pairs(req.headers, secret),
          queryString: [...url.searchParams].map(([name, value]) => ({ name, value })), cookies: [],
          ...(body.length ? { postData: { mimeType: type, text: body.toString("utf8") } } : {}), headersSize: -1, bodySize: body.length },
        response: { status: up.statusCode ?? 0, statusText: up.statusMessage ?? "", httpVersion: `HTTP/${up.httpVersion}`, headers: pairs(up.headers),
          cookies: [up.headers["set-cookie"] ?? []].flat().map((c) => { const [name = "", ...v] = c.split(";")[0]!.split("="); return { name: name.trim(), value: v.join("=") }; }),
          content: { size: content.length, mimeType, ...(text === undefined ? {} : { text }) }, redirectURL: String(up.headers.location ?? ""), headersSize: -1, bodySize: content.length },
      });
    });
    out.on("error", () => { if (!res.headersSent) res.writeHead(502).end("bad gateway"); });
    out.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    entries,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
