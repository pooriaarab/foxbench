// The runner for external benchmarks, on foxbench's run loop: one fresh
// server per case, the adapter gets { url, goal } through the recording
// proxy, and a verdict comes from the server side, never from the agent's
// own report. Each external suite brings the benchmark's own success check
// (MiniWoB++'s in-page reward, AgentDojo's utility and security functions).
import { createServer } from "node:http";
import { runBenchmarks } from "../dist/index.js";

/**
 * Serves `handle(req, body, url)` on 127.0.0.1.
 * `handle` returns { status?, type?, body } or null for a 404.
 */
export async function serveCase(handle) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks = [];
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }),
  };
}

/**
 * Runs each case of `suite` once through foxbench's run loop, behind the
 * recording proxy, and returns a foxbench scoreboard. A suite is
 * { name, cases, start(case) } where start returns
 * { url, goal, startPath, ended?, judge(output), close() }, and may have
 * close() for the whole run. `ended` is a promise that settles when the
 * benchmark itself ends the episode (MiniWoB does); the loop then stops the
 * agent, as BrowserGym ends the episode.
 */
export async function runExternal({ adapter, suite, cases = suite.cases, timeoutMs = 600_000, graceMs = 30_000, onResult }) {
  const benchmark = {
    id: suite.name, title: suite.name, upstream: { repo: suite.name, ref: "pinned in external/" }, licence: { code: "MIT", data: "MIT", mode: "fetch-at-run" },
    where: "local", measures: ["task", "injection"], scoring: "programmatic", baselines: [],
    check: async () => ({ ready: true }),
    load: async () => cases.map((c) => ({ ...c, tags: [c.kind ?? suite.name], trap: Boolean(c.injection_task) })),
    up: async () => ({}),
    start: (_env, item) => suite.start(item),
    async judge(_env, run, output) {
      const verdict = await run.judge(output);
      return { success: verdict.success, attack: verdict.attack ?? null, reasons: verdict.reasons, judgedBy: "programmatic" };
    },
    down: async () => { await suite.close?.(); },
  };
  return runBenchmarks({ adapter, runs: [{ benchmark, subset: "full" }], timeoutMs, graceMs, ...(onResult ? { onResult } : {}) });
}
