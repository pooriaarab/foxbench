// Tests for the suite and metric failure modes in docs/failure-modes.md (M1-M10).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, parseMetrics, type Adapter } from "../src/adapter.js";
import { runSuite } from "../src/runner.js";
import { toMarkdown } from "../src/score.js";
import { startServer, type FoxbenchServer } from "../src/server.js";
import { sites } from "../src/sites/index.js";
import { serverMetrics } from "../src/state.js";
import { SUITES, TIERS, taskById, tasks, tasksIn, type Task } from "../src/tasks.js";

const root = join(import.meta.dirname, "..");
const CORE = ["flights-oneway", "flights-return", "flights-cheapest", "flights-trap", "signup-pro", "contact-billing", "signup-trap",
  "mail-reply", "mail-archive", "mail-trap", "shop-mugs", "shop-hoodie", "shop-trap"];
const task = (id: string) => taskById(id)!;
const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, "dist/cli.js"), ...args], { encoding: "utf8", timeout: 60_000 });
let server: FoxbenchServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});
const open = async (t: Task) => {
  server = await startServer({ sites, tasks, controlKey: "control-key-for-tests" });
  return server.reset(t);
};
const post = (path: string, body: Record<string, string>) =>
  fetch(server!.url + path, { method: "POST", body: new URLSearchParams(body), redirect: "manual" });
const SHIP = { email: "sam.park@example.com", name: "Sam Park", address: "12 King St W", city: "Toronto", postal: "M5H 1A1",
  card: "4242 4242 4242 4242", exp: "12/29", cvc: "123" };

describe("M1 runSuite runs core by default", () => {
  it("runs the 13 core tasks and nothing else", async () => {
    const board = await runSuite({ adapter: noopAdapter() });
    expect(board.results.map((r) => r.id)).toEqual(CORE);
  });
});

describe("M2 every task has a suite and a tier", () => {
  it("knows each suite and tier", () => {
    for (const t of tasks) {
      expect(SUITES).toContain(t.suite);
      expect(TIERS).toContain(t.tier);
    }
  });
  it("keeps core as in 0.1.x", () => expect(tasksIn("core").map((t) => t.id)).toEqual(CORE));
  it("all is every task", () => expect(tasksIn("all")).toEqual(tasks));
});

describe("M3 an unknown suite", () => {
  beforeAll(() => {
    const built = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8" });
    if (built.status !== 0) throw new Error(built.stdout + built.stderr);
  }, 60_000);
  it("exits 2 and names the suites", () => {
    const r = cli("run", "--agent", "noop", "--suite", "nope");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("core, hard, security+, all");
  });
  it("list --suite core lists the core tasks", () => {
    const r = cli("list", "--json", "--suite", "core");
    expect(JSON.parse(r.stdout).map((t: { id: string }) => t.id)).toEqual(CORE);
  });
});

describe("M4 only site requests count", () => {
  it("leaves out control endpoints, the style sheet and the site script", async () => {
    await open(task("flights-oneway"));
    for (const path of ["/__fbn/style.css", "/__fbn/state", "/flights/app.js", "/", "/flights/", "/flights/trips"]) await fetch(server!.url + path);
    await post("/shop/cart/add", { sku: "trail-mug", color: "Slate", qty: "1" });
    expect(server!.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /flights/", "GET /flights/trips", "POST /shop/cart/add"]);
    expect(serverMetrics(server!.state)).toMatchObject({ requests: 3, posts: 1 });
  });
});

describe("M5 a reset starts an empty log", () => {
  it("drops the requests of the task before", async () => {
    await open(task("flights-oneway"));
    await fetch(`${server!.url}/flights/trips`);
    server!.reset(task("shop-mugs"));
    expect(server!.state.requests).toEqual([]);
  });
});

describe("M6 the first action is not the start page load", () => {
  it("is null when the agent only loads the start page", async () => {
    const url = await open(task("shop-mugs"));
    await fetch(url);
    expect(serverMetrics(server!.state).firstActionMs).toBeNull();
  });
  it("is the time to the first other request", async () => {
    const url = await open(task("shop-mugs"));
    await fetch(url);
    await fetch(`${server!.url}/shop/p/trail-mug`);
    const ms = serverMetrics(server!.state).firstActionMs;
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(0);
  });
});

describe("M7 agent-reported metrics stay apart", () => {
  it("keeps them in agentMetrics and leaves out what is not reported", async () => {
    const agent: Adapter = { name: "counted", runTask: async () => ({ done: true, log: "", metrics: { modelCalls: 3, tokensIn: 900 } }) };
    const board = await runSuite({ adapter: agent, tasks: [task("mail-archive")] });
    expect(board.results[0]!.agentMetrics).toEqual({ modelCalls: 3, tokensIn: 900 });
    expect(board.results[0]!.requests).toBe(0);
    expect(board.agentTotals).toEqual({ modelCalls: 3, tokensIn: 900 });
  });
  it("says not reported when the agent gives nothing", async () => {
    const board = await runSuite({ adapter: noopAdapter(), tasks: [task("mail-archive")] });
    expect(board.results[0]!.agentMetrics).toBeNull();
    expect(board.agentTotals).toBeNull();
    expect(toMarkdown(board)).toContain("not reported");
  });
});

describe("M8 bad metrics are ignored", () => {
  it("keeps only finite numbers of 0 or more", () => {
    expect(parseMetrics({ steps: 4, modelCalls: -1, tokensIn: "900", tokensOut: Number.NaN, approvals: 2, extra: 5 })).toEqual({ steps: 4, approvals: 2 });
  });
  it("returns null for no metrics", () => {
    for (const value of [null, undefined, "text", 7, [], {}]) expect(parseMetrics(value)).toBeNull();
  });
});

describe("M9 utility under attack counts passed trap tasks only", () => {
  it("is 0 for noop, which blocks every attack", async () => {
    const board = await runSuite({ adapter: noopAdapter(), tasks: [task("shop-trap")] });
    expect(board).toMatchObject({ attacksBlocked: 1, utilityUnderAttack: 0 });
  });
  it("is 1 when the trap task passes", async () => {
    const buyer: Adapter = {
      name: "buyer",
      async runTask({ url }) {
        const origin = new URL(url).origin;
        const send = (path: string, body: Record<string, string>) => fetch(origin + path, { method: "POST", body: new URLSearchParams(body), redirect: "manual" });
        await send("/shop/cart/add", { sku: "trail-mug", color: "Sand", qty: "1" });
        await send("/shop/checkout", SHIP);
        return { done: true, log: "" };
      },
    };
    const board = await runSuite({ adapter: buyer, tasks: [task("shop-trap")] });
    expect(board).toMatchObject({ utilityUnderAttack: 1, secureTrapPasses: 1 });
    expect(board.results[0]).toMatchObject({ requests: 2, posts: 2 });
  });
});

describe("M10 per-suite counts add up", () => {
  it("sums to the totals", async () => {
    const hard = { ...task("mail-archive"), id: "fake-hard", suite: "hard" } as Task;
    const board = await runSuite({ adapter: noopAdapter(), tasks: [task("shop-mugs"), task("mail-archive"), hard] });
    expect(board.suites).toEqual({ core: { tasks: 2, passed: 0 }, hard: { tasks: 1, passed: 0 } });
    expect(Object.values(board.suites).reduce((n, s) => n + s.tasks, 0)).toBe(board.tasks);
  });
});
