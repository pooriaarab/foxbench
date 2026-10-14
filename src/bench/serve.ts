// A small server for one case of a benchmark that brings its own pages
// (MiniWoB++, AgentDojo). The run loop puts the recording proxy in front.
import { createServer, type IncomingMessage } from "node:http";

export type Reply = { status?: number; type?: string; headers?: Record<string, string>; body: string | Buffer } | null;

/**
 * Serves `handle(req, body, url)` on 127.0.0.1.
 * `handle` returns { status?, type?, body } or null for a 404.
 */
export async function serveCase(handle: (req: IncomingMessage, body: string, url: URL) => Promise<Reply>): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const reply = await handle(req, body, url);
      if (!reply) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(reply.status ?? 200, { "content-type": reply.type ?? "text/html; charset=utf-8", ...reply.headers }).end(reply.body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
