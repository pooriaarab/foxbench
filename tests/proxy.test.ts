// Tests for the recording proxy failure modes in docs/failure-modes.md
// (P1-P5). A toy site records what reaches it; the run loop puts the proxy in
// front of it, and the judge reads the trace the proxy hands over.
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { runBenchmarks } from "../src/bench/run.js";
import type { Benchmark, Episode, Trace } from "../src/bench/types.js";
import { runSuite } from "../src/runner.js";
import { taskById, tasksIn } from "../src/tasks.js";
import { freeBase } from "./free-base.js";
import { referenceAdapter } from "./reference.js";

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
let site = "";
let other = "";
const seen: IncomingHttpHeaders[] = [];
const sites: Server[] = [];
beforeAll(async () => {
  const home = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === "/away") return res.writeHead(302, { location: `${site}/home` }).end();
    if (req.url === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end("1");
    res.writeHead(200, { "content-type": "text/html" }).end(`<p>${req.method} ${req.url}</p>`);
  });
  const elsewhere = createServer((_req, res) => res.end("model reply"));
  sites.push(home, elsewhere);
  site = await listen(home);
  other = await listen(elsewhere);
});
afterAll(() => { for (const s of sites) s.close(); });

/** One case on the toy site; the judge keeps the trace it got. */
function toy(extra: Partial<Episode> = {}): { bench: Benchmark; traces: Trace[] } {
  const traces: Trace[] = [];
  const bench: Benchmark = {
    id: "toy", title: "toy", upstream: { repo: "test", ref: "test" }, licence: { code: "MIT", data: "MIT", mode: "vendored" },
    where: "local", measures: ["task"], scoring: "programmatic", baselines: [],
    check: async () => ({ ready: true }), load: async () => [{ id: "one", tags: [] }], up: async () => ({}), down: async () => {},
    start: async () => ({ url: `${site}/home`, goal: "Look around.", startPath: "/home", ...extra }),
    judge: async (_env, _episode, _output, trace) => (traces.push(trace), { success: true, attack: null, reasons: [], judgedBy: "programmatic" }),
  };
  return { bench, traces };
}
const agent = (work: (url: string) => Promise<unknown>): Adapter => ({ name: "scripted", runTask: async ({ url }) => (await work(url), { done: true, log: "" }) });
const play = (bench: Benchmark, adapter: Adapter) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }] });

/** Sends a request through the proxy as a browser that uses it as its HTTP proxy would. */
function viaProxy(proxy: string, target: string): Promise<string> {
  const { hostname, port } = new URL(proxy);
  return new Promise((resolve) => {
    request({ host: hostname, port, path: target }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c)).on("end", () => resolve(body));
    }).on("error", () => resolve("")).end();
  });
}

describe("P1 the agent never learns the site's port", () => {
  it("hands over the proxy URL and rewrites redirects to it", async () => {
    let start = "";
    let location = "";
    await play(toy().bench, agent(async (url) => {
      start = url;
      location = (await fetch(new URL("/away", url), { redirect: "manual" })).headers.get("location") ?? "";
    }));
    expect(new URL(start).origin).not.toBe(site);
    expect(new URL(start).pathname).toBe("/home");
    expect(location).toBe(`${new URL(start).origin}/home`);
  });
});

describe("P2 one trace per case, and the metrics come from it", () => {
  it("logs each request and counts only posts and page loads", async () => {
    const { bench, traces } = toy();
    const board = await play(bench, agent(async (url) => {
      for (const path of ["/home", "/app.js", "/__fbn/state", "/next"]) await fetch(new URL(path, url));
      await fetch(new URL("/form", url), { method: "POST", body: "a=1" });
    }));
    expect(traces[0]!.requests.map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(["GET /home 200", "GET /app.js 200", "GET /__fbn/state 200", "GET /next 200", "POST /form 200"]);
    expect(traces[0]!.requests[0]).toMatchObject({ host: new URL(site).host, bytes: "<p>GET /home</p>".length, type: "text/html", egress: false });
    expect(board.results[0]).toMatchObject({ requests: 3, posts: 1, egress: { requests: 0, bytes: 0 } });
  });
});

describe("P3 injected headers reach the site only", () => {
  it("adds the benchmark's header to each site request", async () => {
    seen.length = 0;
    await play(toy({ headers: { "x-auto-login": "admin" } }).bench, agent(async (url) => {
      expect(JSON.stringify(await (await fetch(url)).text())).not.toContain("admin");
    }));
    expect(seen.at(-1)!["x-auto-login"]).toBe("admin");
  });
});

describe("P4 a request to another host is egress", () => {
  it("logs absolute-URL and CONNECT requests with their host and bytes", async () => {
    const { bench, traces } = toy();
    const board = await play(bench, agent(async (url) => {
      expect(await viaProxy(url, `${other}/v1/chat`)).toBe("model reply");
      expect(await viaProxy(url, `${new URL(url).origin}/home`)).toBe("<p>GET /home</p>");
      await new Promise<void>((resolve) => {
        const socket = connect(Number(new URL(url).port), "127.0.0.1", () => socket.write(`CONNECT ${new URL(other).host} HTTP/1.1\r\n\r\n`));
        socket.once("data", () => { socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"); socket.on("close", () => resolve()); });
      });
    }));
    const egress = traces[0]!.requests.filter((r) => r.egress);
    expect(egress.map((r) => `${r.method} ${r.host}`)).toEqual([`GET ${new URL(other).host}`, `CONNECT ${new URL(other).host}`]);
    expect(egress.every((r) => r.bytes > 0)).toBe(true);
    expect(board.results[0]!.egress).toEqual({ requests: 2, bytes: egress[0]!.bytes + egress[1]!.bytes });
    expect(board.egress.requests).toBe(2);
  });
});

describe("P5 the proxy ends with its case and keeps a fixed port", () => {
  it("refuses a late request, and listens on Episode.port", async () => {
    let late = "";
    const port = await freeBase(11000, 100, [0]);
    await play(toy({ port }).bench, agent(async (url) => { late = url; }));
    expect(new URL(late).port).toBe(String(port));
    await expect(fetch(late)).rejects.toThrow();
  });
});

describe("the in-house suites through the proxy", () => {
  it("noop scores 0 and the reference solver passes, with 0 egress", async () => {
    expect((await runSuite({ adapter: noopAdapter(), tasks: [taskById("shop-mugs")!] })).passed).toBe(0);
    const board = await runSuite({ adapter: referenceAdapter(), tasks: tasksIn("hard") });
    expect(board).toMatchObject({ passed: board.tasks, egress: { requests: 0, bytes: 0 } });
    expect(board.results.every((r) => r.requests > 0)).toBe(true);
  });
});
