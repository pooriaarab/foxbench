// Tests for the WebVoyager failure modes in docs/failure-modes.md (WVY1-WVY7).
// The task files are synthetic, served by a fake GitHub endpoint
// (FOXBENCH_RAW_URL) into a temporary cache; the run date is fixed. The judges
// are fakes; no test calls a real API.
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import type { Judge, JudgeAsk } from "../src/bench/judge.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { EMERGENCE_REF, WV_REF, webvoyagerBenchmark } from "../src/bench/webvoyager.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const ORIGINAL = [
  { web_name: "Amazon", id: "Amazon--0", ques: "Find the price of a steel kettle.", web: "https://www.amazon.com/" },
  { web_name: "ArXiv", id: "ArXiv--0", ques: "Find the newest paper on agents.", web: "https://arxiv.org/" },
  { web_name: "Booking", id: "Booking--0", ques: "Find a hotel in Paris from March 20-27, 2024.", web: "https://www.booking.com/" },
  { web_name: "Booking", id: "Booking--1", ques: "Hotel in Rome from December 25, 2023 to January 5, 2024.", web: "https://www.booking.com/" },
  { web_name: "Booking", id: "Booking--2", ques: "Hotel in Oslo from February 22 to February 29, 2024.", web: "https://www.booking.com/" },
  { web_name: "Booking", id: "Booking--3", ques: "Hotel in Bonn on 20/12/2023, or December 30.", web: "https://www.booking.com/" },
  { web_name: "Google Flights", id: "Google Flights--0", ques: "Show one-way flights today (February 17, 2024) from Chicago to Paris.", web: "https://www.google.com/travel/flights" },
];
const REFERENCE = {
  Amazon: { answers: [{ id: 0, type: "possible", ans: "a stale price" }] },
  ArXiv: { answers: [{ id: 0, type: "golden", ans: "the Agent Paper" }] },
};
const TEMPLATE = [
  { id: 7, domain: "Booking", status: "active", intent_template: "Using the website {{website}}, find a hotel in {{city}} for {{from}}-{{to}} {{valentine}}", instantiation_dict: { city: "Rome", from: "@eval:(now() + timedelta(days=60)).strftime('%B %d %Y')", to: "@eval:(now() + timedelta(days=61)).strftime('%B %d %Y')", valentine: "@eval:generate_valentines_week()", website: "https://www.booking.com/" }, questions_for_annotation: ["Does the answer name a hotel in {{city}}?", "Was the task completed using the website mentioned in the prompt: {{website}}"], reference_answer_type: "possible", reference_answers: "x" },
  { id: 9, domain: "ArXiv", status: "active", intent_template: "Using {{website}}, who wrote the {{year}} paper on kettles, and when is the weekend {{weekend}}?", instantiation_dict: { year: "@eval:(datetime.now().year - 1)", weekend: "@eval:generate_weekend_dates_after_x_days(30)", website: "https://arxiv.org/" }, questions_for_annotation: ["Is the author named?"], reference_answer_type: "golden", reference_answers: "Ada Kettle" },
];
const RIGHT: Record<string, string> = { "Amazon--0": "19 pounds", "ArXiv--0": "the Agent Paper", "Booking--0": "Hotel Lumiere", "Booking--1": "Roma Inn", "Booking--2": "Fjord House", "Booking--3": "Bonn Rest", "Google Flights--0": "AF 1234", "ev-7": "Rome Palace", "ev-9": "Ada Kettle" };

const dir = mkdtempSync(join(tmpdir(), "fbn-wvy-"));
const saved = { ...process.env };
const bench = webvoyagerBenchmark({ now: () => NOW });
const hits: string[] = [];
const server = createServer((req, res) => {
  hits.push(req.url!);
  const files: Record<string, unknown> = {
    [`/MinorJerry/WebVoyager/${WV_REF}/data/WebVoyager_data.jsonl`]: ORIGINAL.map((r) => JSON.stringify(r)).join("\n"),
    [`/MinorJerry/WebVoyager/${WV_REF}/data/reference_answer.json`]: JSON.stringify(REFERENCE),
    [`/EmergenceAI/EmergenceWebVoyager/${EMERGENCE_REF}/tasks/webvoyager_template.json`]: JSON.stringify(TEMPLATE),
  };
  const body = files[req.url!];
  res.writeHead(body === undefined ? 404 : 200).end(body === undefined || req.method === "HEAD" ? undefined : String(body));
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { FOXBENCH_RAW_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, FOXBENCH_CACHE: join(dir, "cache") });
});
afterAll(() => {
  process.env = saved;
  return new Promise<void>((r) => server.close(() => r()));
});

/** A fake judge: success when the final answer holds the right value for the case on the start page. "mute" gives no verdict. */
function fake(mode: "fair" | "mute" = "fair", calls: JudgeAsk[] = []): Judge {
  return {
    name: "claude", model: "claude-fake", where: "cloud",
    async ask(q) {
      calls.push(q);
      if (mode === "mute") return "I am not sure.";
      const answer = /Final answer:\n([\s\S]*?)\n\nAction History:/.exec(q.prompt)![1]!;
      return `Thoughts: checked.\nStatus: ${Object.values(RIGHT).some((v) => answer.includes(v)) ? "success" : "failure"}`;
    },
  };
}
const goals: string[] = [];
const scripted = (name: string, answer: (id: string) => string): Adapter => ({
  name,
  async runTask({ url, goal }) {
    const page = await (await fetch(url)).text();
    const id = /data-case="([^"]+)"/.exec(page)![1]!;
    goals.push(goal);
    expect(page).toContain("is allowed");
    expect(goal).toContain("is allowed");
    expect(goal).toContain(/href="([^"]+)"/.exec(page)![1]!.replace(/&#47;/g, "/"));
    return { done: true, log: "searched the site", answer: answer(id) };
  },
});
const play = (adapter: Adapter, subset: "full" | "published", judges: Judge[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset }], judges, timeoutMs: 30_000 });
const ctx = () => benchContext();
const goalOf = async (id: string) => (await bench.load(ctx(), "tag:original")).find((c) => c.id === id)!.goal!;

describe("WebVoyager", () => {
  it("WVY1 WVY2 the pinned files, with upstream ids and tags", async () => {
    expect(WV_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(EMERGENCE_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(bench).toMatchObject({ upstream: { ref: WV_REF }, licence: { code: "Apache-2.0 (WebVoyager), MIT (Emergence)", mode: "fetch-at-run" }, where: "live-web", scoring: "llm" });
    expect(await bench.check(ctx())).toEqual({ ready: true });
    const full = await bench.load(ctx(), "full");
    expect(full.map((c) => [c.id, c.tags, c.judge])).toContainEqual(["Booking--0", ["booking", "original"], "llm"]);
    expect(full).toHaveLength(ORIGINAL.length);
    expect((await bench.load(ctx(), "published")).map((c) => [c.id, c.tags])).toEqual([["ev-7", ["booking", "emergence"]], ["ev-9", ["arxiv", "emergence"]]]);
    expect((await bench.load(ctx(), "tag:booking")).map((c) => c.id)).toEqual(["Booking--0", "Booking--1", "Booking--2", "Booking--3", "ev-7"]);
    expect(readdirSync(join(dir, "cache")).some((d) => d.includes(WV_REF.slice(0, 12)))).toBe(true);
  });

  it("WVY3 Booking and Google Flights dates move to the future, other tasks stay", async () => {
    expect(await goalOf("Booking--0")).toContain("March 20-27, 2027.");
    expect(await goalOf("Booking--1")).toContain("December 25, 2026 to January 5, 2027.");
    expect(await goalOf("Booking--2")).toContain("February 22 to March 1, 2027.");
    expect(await goalOf("Booking--3")).toContain("20/12/2026, or December 30.");
    expect(await goalOf("Google Flights--0")).toContain("today (October 15, 2026) from Chicago");
    expect(await goalOf("Amazon--0")).toContain("Find the price of a steel kettle.");
  });

  it("WVY4 the Emergence rules are parsed, and an unknown one stops the load", async () => {
    const goal = (await bench.load(ctx(), "published")).map((c) => c.goal!);
    expect(goal[0]).toContain("find a hotel in Rome for December 14 2026-December 15 2026 Valentine's Day week, February 07-14, 2027");
    expect(goal[1]).toContain("who wrote the 2025 paper on kettles, and when is the weekend Nov 20-22, 2026?");
    TEMPLATE[0]!.instantiation_dict.city = "@eval:__import__('os').getcwd()";
    await expect(webvoyagerBenchmark({ now: () => NOW }).load({ ...ctx(), cacheDir: join(dir, "fresh") }, "published")).rejects.toThrow("__import__('os').getcwd()");
    TEMPLATE[0]!.instantiation_dict.city = "Rome";
  });

  it("WVY5 WVY6 noop and wrong pass 0, perfect passes, and the judge sees the evidence", async () => {
    expect((await play(noopAdapter(), "full", [fake()])).passed).toBe(0);
    expect((await play(scripted("wrong", () => "no idea"), "full", [fake()])).passed).toBe(0);
    const calls: JudgeAsk[] = [];
    expect(await play(scripted("perfect", (id) => RIGHT[id]!), "full", [fake("fair", calls)])).toMatchObject({ tasks: ORIGINAL.length, passed: ORIGINAL.length });
    const arxiv = calls.find((c) => c.prompt.includes("newest paper"))!;
    expect(arxiv.prompt).toContain("Reference answer: the Agent Paper");
    expect(calls.find((c) => c.prompt.includes("steel kettle"))!.prompt).not.toContain("a stale price");
    expect(arxiv.prompt).toContain("searched the site");
    expect(arxiv.prompt).toMatch(/Requests the agent made:\nGET 127\.0\.0\.1:\d+\/ 200/);
    expect(arxiv.system).toContain("named website");
    calls.length = 0;
    expect(await play(scripted("perfect", (id) => RIGHT[id]!), "published", [fake("fair", calls)])).toMatchObject({ tasks: 2, passed: 2 });
    expect(calls[0]!.prompt).toContain("Checklist:\n- Does the answer name a hotel in Rome?\n- Was the task completed using the website mentioned in the prompt: https://www.booking.com/");
    expect(calls[1]!.prompt).toContain("Reference answer: Ada Kettle");
  });

  it("WVY7 a judge with no verdict fails the case, and the baselines name their source", async () => {
    const board = await play(scripted("perfect", (id) => RIGHT[id]!), "published", [fake("mute")]);
    expect(board.passed).toBe(0);
    expect(board.results[0]!.reasons[0]).toMatch(/^judge: claude: .*Status/);
    expect(bench.baselines.find((b) => b.subset === "published")).toMatchObject({ agent: expect.stringContaining("Operator"), source: "https://arxiv.org/abs/2603.29020" });
    expect(bench.baselines.filter((b) => b.vendorReported).length).toBeGreaterThan(0);
  });
});
