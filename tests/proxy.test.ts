// Tests for the recording proxy failure modes in docs/failure-modes.md
// (P1-P6). A toy site records what reaches it; the run loop puts the proxy in
// front of it, and the judge reads the trace the proxy hands over.
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, createServer as createTcp } from "node:net";
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

describe("P6 a busy Episode.port fails the case at once", () => {
  it("names the port in a harness reason and never runs the agent", async () => {
    const port = await freeBase(11200, 100, [0]);
    const holder = createTcp();
    await new Promise<void>((r) => holder.listen(port, "127.0.0.1", r));
    let ran = false;
    try {
      const board = await play(toy({ port }).bench, agent(async () => { ran = true; }));
      expect(board.results[0]!.success).toBe(false);
      expect(board.results[0]!.reasons[0]).toMatch(new RegExp(`^harness: port ${port} is in use`));
      expect(ran).toBe(false);
    } finally {
      await new Promise((r) => holder.close(r));
    }
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

/** A request's status, type and body. */
async function fetchBody(url: URL, init?: RequestInit) {
  const r = await fetch(url, init);
  return { status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) };
}

describe("replacements", () => {
  const PNG = Buffer.from("fake image bytes");
  const replace = [{ path: "/img/victim.png", type: "image/png", body: PNG }];

  it("P7 serves a listed path itself with a GET, and forwards everything else", async () => {
    const { bench, traces } = toy({ replace });
    seen.length = 0;
    let got: Awaited<ReturnType<typeof fetchBody>>[] = [];
    await play(bench, agent(async (url) => {
      got = [await fetchBody(new URL("/img/victim.png", url)), await fetchBody(new URL("/img/other.png", url)), await fetchBody(new URL("/img/victim.png", url), { method: "POST", body: "x" })];
    }));
    expect(got[0]).toMatchObject({ status: 200, type: "image/png" });
    expect(got[0]!.body.equals(PNG)).toBe(true);
    expect(got[1]!.body.toString()).toBe("<p>GET /img/other.png</p>");
    expect(got[2]!.body.toString()).toBe("<p>POST /img/victim.png</p>");
    expect(seen).toHaveLength(2);
    expect(traces).toHaveLength(1);
  });

  it("P8 logs a replacement like any request, and never serves it for another host", async () => {
    const { bench, traces } = toy({ replace });
    let viaHttpProxy = "";
    await play(bench, agent(async (url) => {
      await fetchBody(new URL("/img/victim.png", url));
      viaHttpProxy = await viaProxy(url, `${other}/img/victim.png`);
    }));
    const hit = traces[0]!.requests.find((r) => r.path === "/img/victim.png" && !r.egress)!;
    expect(hit).toMatchObject({ method: "GET", status: 200, bytes: PNG.length, type: "image/png" });
    expect(viaHttpProxy).toBe("model reply");
    expect(traces[0]!.requests.find((r) => r.egress)).toMatchObject({ path: "/img/victim.png" });
  });
});
