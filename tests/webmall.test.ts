// Tests for the WebMall failure modes in docs/failure-modes.md (WS1-WS11, WS12 is the live test). The shops are fakes
// on moved ports (a real WebMall is 3.6 GB; WS12 is the live test); the 91 tasks are the real
// ones, fetched at the pinned commit on the first run.
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { scoreTask, submittedUrls, visitedPages } from "../src/bench/webmall/judge.js";
import { webmallBenchmark } from "../src/bench/webmall/index.js";
import { loadTasks, TASKS_REF, type WebmallTask } from "../src/bench/webmall/tasks.js";
import { at, doTask, fakeShops, scripted as scriptedAgent } from "./fixtures/webmall-fakes.js";

const OFFSET = 41000;
const KEY = "test-key";
const bench = webmallBenchmark({ offset: OFFSET });
let tasks: WebmallTask[] = [];
let fake: Awaited<ReturnType<typeof fakeShops>>;
const run = (adapter: Adapter, ids?: string[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], ...(ids ? { ids } : {}), timeoutMs: 30_000 });
const scripted = (name: string, act: (t: WebmallTask) => Promise<string>) => scriptedAgent(tasks, name, act);
const ready = (env: Record<string, string>) => bench.check(benchContext({ env: { HOME: "/nonexistent", ...env } }));
const first = (type: WebmallTask["type"]) => tasks.find((t) => t.type === type)!;

beforeAll(async () => {
  process.env.FOXBENCH_WEBMALL_KEY = KEY;
  tasks = await loadTasks(benchContext());
  fake = await fakeShops(OFFSET, KEY);
}, 60_000);
afterAll(async () => {
  delete process.env.FOXBENCH_WEBMALL_KEY;
  await fake.close();
});

describe("WebMall tasks and judge", () => {
  it("WS1 has the 91 tasks of the pinned commit", async () => {
    expect(TASKS_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(tasks).toHaveLength(91);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(91);
    expect(tasks.flatMap((t) => t.answers)).toHaveLength(230);
    expect([(await bench.load(benchContext(), "full")).length, (await bench.load(benchContext(), "quick")).length]).toEqual([91, 20]);
  });

  it("WS2 asks for the result as the answer, on the proxy's ports", () => {
    for (const t of tasks) {
      expect(t.goal).not.toMatch(/Submit Final Result|Solution page|\{\{/);
      expect(t.goal).toContain("give the final result as your answer");
      expect(t.goal).toContain("E-Store Athletes: http://127.0.0.1:8081");
      expect(t.goal).not.toMatch(/localhost|:1808\d/);
    }
  });

  it("WS3 noop scores 0 on all 91, also when a gold product is already in a cart", async () => {
    const cart = first("cart");
    fake.shop(8081).carts.push(cart.answers[0]!.replace(/^http:\/\/127.0.0.1:\d+/, "http://127.0.0.1:8081") + "/");
    const before = fake.resets;
    expect((await run(noopAdapter(), [cart.id])).passed).toBe(0);
    expect(fake.resets).toBe(before + 4);
    expect(await run(noopAdapter())).toMatchObject({ tasks: 91, passed: 0 });
  }, 120_000);

  it("WS4 a liar and a wrong agent pass nothing, and a perfect one passes all 91", async () => {
    expect((await run(scripted("liar", async () => "Done. I found it."))).passed).toBe(0);
    expect(await run(scripted("perfect", (t) => doTask(t)))).toMatchObject({ tasks: 91, passed: 91, adapterErrors: 0 });
    expect((await run(scripted("wrong", (t) => doTask(t, { wrong: true })))).passed).toBe(0);
  }, 300_000);

  it("WS5 matches the URL set exactly", () => {
    const t = tasks.find((x) => x.type === "string" && x.answers.length >= 2)!;
    const [a, b] = t.answers as [string, string];
    const score = (answer: string) => scoreTask(t, answer, { carts: [], orders: [] }, new Set());
    expect(score(`${b}/ ### ${a.toUpperCase().replace("HTTP", "http")}\n`).success).toBe(true);
    expect(score(t.answers.map((u) => u.replace("http://", "https://")).join(", ")).success).toBe(true);
    expect(score(a).success).toBe(false);
    expect(score(`${t.answers.join("###")}###http://127.0.0.1:8081/product/extra`)).toMatchObject({ success: false, reasons: ["wrong 127.0.0.1:8081/product/extra"] });
    // The same slug on another shop is another product.
    expect(score(t.answers.map((u) => u.replace(/:808\d/, ":8089")).join("###")).success).toBe(false);
    expect(submittedUrls("Offer1: http://127.0.0.1:8081/p/x/###Offer2: http://127.0.0.1:8082/p/y")).toEqual(["127.0.0.1:8081/p/x", "127.0.0.1:8082/p/y"]);
  });

  it("WS6 a cart holds the gold products and nothing else", async () => {
    const t = first("cart");
    const cart = async (opts: Parameters<typeof doTask>[1]) => (await run(scripted("cart", (x) => doTask(x, opts)), [t.id])).passed;
    expect(await cart({})).toBe(1);
    expect(await cart({ wrong: true })).toBe(0);
    expect(await cart({ cartOnly: true })).toBe(1);
    expect(scoreTask(t, "", { carts: t.answers.map((u) => u.replace(/:808\d/, ":8089")), orders: [] }, new Set()).success).toBe(false);
  }, 60_000);

  it("WS7 a checkout needs an order with the task's billing details", async () => {
    const t = first("checkout");
    const verdict = async (opts: Parameters<typeof doTask>[1]) => (await run(scripted("checkout", (x) => doTask(x, opts)), [t.id])).results[0]!;
    expect(await verdict({})).toMatchObject({ success: true });
    expect(await verdict({ wrong: true })).toMatchObject({ success: false });
    // A cart with no order gets the visit and cart shares (0.2), and fails.
    expect(await verdict({ cartOnly: true })).toMatchObject({ success: false, score: expect.closeTo(0.2, 5) });
  }, 60_000);

  it("WS8 weights the answers 0.8 and the visits 0.2", () => {
    const t = tasks.find((x) => x.type === "string" && x.answers.length === 2)!;
    const visited = new Set(t.answers.map((u) => u.replace("http://", "")));
    const score = (answer: string, seen: Set<string>) => scoreTask(t, answer, { carts: [], orders: [] }, seen).score;
    expect(score(t.answers.join("###"), visited)).toBe(1);
    expect(score(t.answers.join("###"), new Set())).toBe(0.8);
    expect(score(t.answers[0]!, new Set([[...visited][0]!]))).toBe(0.5);
  });

  it("WS9 counts a successful GET of a product page on its shop", () => {
    const entry = { method: "GET", host: "h", path: "/product/x/", status: 200, bytes: 0, type: "", egress: false, at: 0 };
    const pages = visitedPages([{ origin: "http://127.0.0.1:8081", requests: [entry, { ...entry, path: "/product/y", status: 404 }, { ...entry, method: "POST", path: "/product/z" }] },
      { origin: "http://127.0.0.1:8082", requests: [entry] }]);
    expect([...pages].toSorted()).toEqual(["127.0.0.1:8081/product/x", "127.0.0.1:8082/product/x"]);
  });

  it("WS10 check() is not ready with no key or a shop down, and writes nothing", async () => {
    expect(await ready({})).toMatchObject({ ready: false, reason: expect.stringContaining("no control key") });
    expect(await ready({ FOXBENCH_WEBMALL_KEY: KEY })).toEqual({ ready: true });
    expect(await ready({ FOXBENCH_WEBMALL_KEY: "wrong" })).toMatchObject({ ready: false, reason: expect.stringContaining("401") });
    expect(await webmallBenchmark({ offset: 1 }).check(benchContext({ env: { FOXBENCH_WEBMALL_KEY: KEY } }))).toMatchObject({ ready: false, fix: expect.stringContaining("foxbench env up webmall") });
  });

  it("WS11 frees the shop ports when a case ends", async () => {
    const env = await bench.up(benchContext());
    const episode = await bench.start(env, { id: first("cart").id, tags: [] });
    expect((await at("http://127.0.0.1:8082/")).status).toBe(200);
    await episode.close!();
    await new Promise<void>((resolve, reject) => { const s = createServer().once("error", reject).listen(8082, "127.0.0.1", () => s.close(() => resolve())); });
  });
});
