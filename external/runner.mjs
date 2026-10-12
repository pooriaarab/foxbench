// The runner for external benchmarks. It works like foxbench's runSuite:
// one fresh server per case, the adapter gets { url, goal }, and a verdict
// comes from the server side, never from the agent's own report. The
// difference is the judge: each external suite brings the benchmark's own
// success check (MiniWoB++'s in-page reward, AgentDojo's utility and
// security functions). The scoreboard has the same shape as runSuite's, so
// toMarkdown and writeScore work on it.
import { createServer } from "node:http";
import { median } from "../dist/index.js";

/**
 * Serves `handle(req, body, url)` on 127.0.0.1 and logs the requests an
 * agent makes: page loads and posts, not style sheets or scripts.
 * `handle` returns { status?, type?, body } or null for a 404.
 */
export async function serveCase(handle) {
  const log = [];
  const started = Date.now();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const control = url.pathname.startsWith("/__ext/");
    if (!control && (req.method === "POST" || /(\/|\.html)$/.test(url.pathname) || !/\.[a-z0-9]+$/i.test(url.pathname))) {
      log.push({ method: req.method ?? "GET", path: url.pathname, at: Date.now() - started });
    }
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
    log,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }),
  };
}

/** Server metrics from the request log, as foxbench reports them (M4, M6). */
export function logMetrics(log, startPath) {
  const first = log.find((r) => !(r.method === "GET" && r.path === startPath));
  return { requests: log.length, posts: log.filter((r) => r.method === "POST").length, firstActionMs: first ? first.at : null, asks: 0 };
}

/**
 * Runs each case of `suite` once and returns a foxbench scoreboard.
 * A suite is { name, cases, start(case) } where start returns
 * { url, goal, startPath, ended?, judge(output), close() }, and may have
 * close() for the whole run. `ended` is a
 * promise that settles when the benchmark itself ends the episode (MiniWoB
 * does); the runner then stops the agent, as BrowserGym ends the episode.
 */
export async function runExternal({ adapter, suite, cases = suite.cases, timeoutMs = 600_000, graceMs = 30_000, onResult }) {
  const results = [];
  try {
    for (const item of cases) {
      const run = await suite.start(item);
      const started = Date.now();
      let output = { done: false, log: "" };
      let adapterError = false;
      let endedEarly = false;
      let timer;
      try {
        const work = adapter.runTask({ url: run.url, goal: run.goal });
        const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); });
        const ended = run.ended ? run.ended.then(() => "ended") : new Promise(() => {});
        const first = await Promise.race([work, limit, ended]);
        if (first === "ended") {
          endedEarly = true;
          await adapter.abort?.().catch(() => {});
          output = await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve({ done: false, log: "stopped at the end of the episode" }), graceMs))])
            .catch((error) => ({ done: false, log: `stopped at the end of the episode: ${error instanceof Error ? error.message : String(error)}` }));
        } else {
          output = first;
        }
      } catch (error) {
        output = { done: false, log: `adapter error: ${error instanceof Error ? error.message : String(error)}` };
        adapterError = true;
        await adapter.abort?.().catch(() => {});
      } finally {
        clearTimeout(timer);
      }
      const ms = Date.now() - started;
      const verdict = await run.judge(output);
      await run.close();
      const result = {
        id: item.id, suite: suite.name, tier: "external", site: suite.name, trap: verdict.trap ?? null,
        success: verdict.success, attack: verdict.attack ?? null, secure: verdict.attack === "blocked" && verdict.success,
        reasons: verdict.reasons, ms, done: Boolean(output.done), adapterError, endedEarly, log: String(output.log ?? "").slice(0, 4000),
        ...logMetrics(run.log, run.startPath), agentMetrics: output.metrics ?? null, ...verdict.extra,
      };
      results.push(result);
      onResult?.(result);
    }
  } finally {
    await adapter.close?.();
    await suite.close?.();
  }
  return scoreboard(adapter.name, results);
}

function scoreboard(agent, results) {
  const trapped = results.filter((r) => r.trap);
  const passed = results.filter((r) => r.success).length;
  const firsts = results.flatMap((r) => (r.firstActionMs === null ? [] : [r.firstActionMs]));
  const totals = {};
  for (const r of results) for (const [k, v] of Object.entries(r.agentMetrics ?? {})) if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
  const suites = {};
  for (const r of results) {
    const s = (suites[r.suite] ??= { tasks: 0, passed: 0 });
    s.tasks += 1;
    if (r.success) s.passed += 1;
  }
  return {
    agent, date: new Date().toISOString(), tasks: results.length, passed, successRate: results.length ? passed / results.length : 0,
    medianMs: median(results.map((r) => r.ms)), adapterErrors: results.filter((r) => r.adapterError).length,
    traps: trapped.length, attacksBlocked: trapped.filter((r) => r.attack === "blocked").length,
    attacksFollowed: trapped.filter((r) => r.attack === "followed").length, secureTrapPasses: trapped.filter((r) => r.secure).length,
    utilityUnderAttack: trapped.filter((r) => r.success).length, suites, medianRequests: median(results.map((r) => r.requests)),
    asks: 0, medianFirstActionMs: firsts.length ? median(firsts) : null, agentTotals: Object.keys(totals).length ? totals : null, results,
  };
}
