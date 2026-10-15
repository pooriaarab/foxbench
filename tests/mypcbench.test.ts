// Tests for the MyPCBench failure modes in docs/failure-modes.md (MB1-MB12).
// The task file is made up and served from a fake raw-file server into a temp
// cache; the VM is 17 fake apps and a fake reset service on free local ports.
// The judge is a fake that is fair: an item passes only when its evidence is
// there. No test calls a real API.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as tcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import type { Judge, JudgeAsk } from "../src/bench/judge.js";
import { MYPCBENCH_COMMIT, RESET_PORT, mypcApps } from "../src/bench/mypcbench/env.js";
import { mypcbenchBenchmark } from "../src/bench/mypcbench/index.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";

const rubric = (criterion: string, weight: number) => ({ criterion, type: "llm_judge", weight });
const TASKS = [
  { id: "bank-a001", app: "gringotts", instruction: "What is the balance of my Gringotts checking account?", apps_involved: ["Gringotts"], category: "retrieval", difficulty: "easy", grading: { type: "llm_judge", rubrics: [rubric("Reports the checking balance of 4213.55 [answer:4213.55]", 1)] } },
  { id: "mail-b002", app: "multi_app", instruction: "Email Dwight that I am in, and put the meeting in my calendar.", apps_involved: ["HooliMail", "HooliCalendar", "Firefox"], category: "situated_action", difficulty: "medium", grading: { type: "llm_judge", rubrics: [rubric("Sends the email [write:/api/emails]", 0.5), rubric("Adds the calendar event [write:/api/events]", 0.5)] } },
  { id: "desk-c003", app: "multi_app", instruction: "Write the report in LibreOffice Calc.", apps_involved: ["Gringotts", "LibreOffice Calc"], category: "aggregation", difficulty: "hard", grading: { type: "llm_judge", rubrics: [rubric("Makes the sheet [answer:sheet]", 1)] } },
  { id: "shop-d004", app: "hoolishop", instruction: "What does the stapler cost at HooliShop?", apps_involved: ["HooliShop"], category: "retrieval", difficulty: "easy", grading: { type: "llm_judge", rubrics: [rubric("States the price 12.99 [answer:12.99]", 1)] } },
];
const ANSWER: Record<string, string> = { "bank-a001": "The balance is 4213.55", "mail-b002": "Done: emailed Dwight and added the meeting", "shop-d004": "It costs 12.99" };
const WRITES: Record<string, [string, string][]> = { "mail-b002": [["HooliMail", "/api/emails"], ["HooliCalendar", "/api/events"]] };

const dir = mkdtempSync(join(tmpdir(), "fbn-mpc-"));
const saved = { ...process.env };
const file = JSON.stringify(TASKS);
let served = file;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const servers: Server[] = [];
const seen: { cookies: Record<string, string[]>; resets: number; hits: string[] } = { cookies: {}, resets: 0, hits: [] };
let offset = 0;
let agentOffset = 0;

const isFree = (port: number) => new Promise<boolean>((r) => { const s = tcp(); s.once("error", () => r(false)); s.listen(port, "127.0.0.1", () => s.close(() => r(true))); });
const listen = (s: Server, port: number) => new Promise<void>((r) => s.listen(port, "127.0.0.1", r));

beforeAll(async () => {
  const ports = [...mypcApps.map((a) => a.port), RESET_PORT];
  for (let tries = 0; tries < 100; tries++) {
    offset = 20000 + Math.floor(Math.random() * 20000);
    agentOffset = 41000 + Math.floor(Math.random() * 10000);
    const need = [...ports.map((p) => p + offset), ...ports.map((p) => p + agentOffset)];
    if ((await Promise.all(need.map(isFree))).every(Boolean)) break;
  }
  for (const app of mypcApps) {
    const s = createServer((req, res) => {
      (seen.cookies[app.id] ??= []).push(String(req.headers.cookie ?? ""));
      seen.hits.push(`${req.method} ${app.id} ${req.url}`);
      res.writeHead(200, { "content-type": "text/html" }).end("<html><body>ok</body></html>");
    });
    servers.push(s);
    await listen(s, app.port + offset);
  }
  const reset = createServer((req, res) => {
    if (req.url === "/reset" && req.method === "POST") seen.resets++;
    res.writeHead(200).end();
  });
  servers.push(reset);
  await listen(reset, RESET_PORT + offset);
  const raw = createServer((req, res) => res.writeHead(req.url?.includes(`/ljang0/MyPCBench/${MYPCBENCH_COMMIT}/tasks/final/all_tasks_with_grading.json`) ? 200 : 404).end(served));
  servers.push(raw);
  await listen(raw, 0);
  Object.assign(process.env, { FOXBENCH_RAW_URL: `http://127.0.0.1:${(raw.address() as { port: number }).port}`, FOXBENCH_CACHE: join(dir, "cache"), MYPCBENCH_HOST: "127.0.0.1" });
});
afterAll(async () => {
  process.env = saved;
  await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

/** A fair fake judge: an item passes only when the answer or a write request holds its marker. "mute" gives no verdict. */
function fake(mode: "fair" | "mute" | "short" = "fair", calls: JudgeAsk[] = []): Judge {
  return {
    name: "claude", model: "claude-fake", where: "cloud",
    async ask(q) {
      calls.push(q);
      if (mode === "mute") return "I cannot tell.";
      const answer = /Final answer:\n([\s\S]*?)\n\nWrite requests/.exec(q.prompt)![1]!;
      const writes = q.prompt.split("Write requests")[1]!;
      const items = [...q.prompt.matchAll(/^(\d+)\. (.*)$/gm)];
      return items.slice(0, mode === "short" ? 1 : undefined).map(([, n, text]) => {
        const marker = /\[(answer|write):([^\]]+)\]/.exec(text!)!;
        return `${n}: ${(marker[1] === "answer" ? answer : writes).includes(marker[2]!) ? "met" : "not met"}`;
      }).join("\n");
    },
  };
}

/** A scripted agent: reads the apps' URLs from the goal, makes the writes it is told to, and answers. */
const agent = (name: string, o: { answer?: (id: string) => string; writes?: (id: string) => [string, string][] }): Adapter => ({
  name,
  async runTask({ url, goal }) {
    const task = TASKS.find((t) => goal.includes(t.instruction))!;
    const urls = Object.fromEntries([...goal.matchAll(/^- (.+): (http:\/\/127\.0\.0\.1:\d+)$/gm)].map((m) => [m[1]!, m[2]!]));
    await fetch(url);
    for (const [app, path] of o.writes?.(task.id) ?? []) await fetch(urls[app]! + path, { method: "POST", body: "{}" });
    return { done: true, log: "I did everything and the log says so", answer: o.answer?.(task.id) ?? "" };
  },
});
const perfect = agent("perfect", { answer: (id) => ANSWER[id]!, writes: (id) => WRITES[id] ?? [] });
const bench = (o: { sha256?: string } = {}) => mypcbenchBenchmark({ sha256: o.sha256 ?? sha(file), offset, agentOffset, resetWaitMs: 5000 });
const play = (adapter: Adapter, judges: Judge[] = [fake()], ids?: string[]) => runBenchmarks({ adapter, runs: [{ benchmark: bench(), subset: "full" }], judges, ids, timeoutMs: 30_000 });
const ctx = () => benchContext();

describe("MyPCBench", () => {
  it("MB1 the task file is fetched at the pinned commit, checked, and never committed", async () => {
    const b = mypcbenchBenchmark();
    expect(b).toMatchObject({ upstream: { repo: "https://github.com/ljang0/MyPCBench", ref: MYPCBENCH_COMMIT }, licence: { code: "MIT", mode: "fetch-at-run" }, scoring: "llm" });
    await expect(mypcbenchBenchmark({ sha256: "0".repeat(64), offset }).load(ctx(), "full")).rejects.toThrow("SHA-256");
    await bench().load(ctx(), "full");
    const files = readdirSync(join(dir, "cache"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, "cache", files[0]!), "utf8")).toBe(file);
    const tracked = spawnSync("git", ["ls-files", "*all_tasks*", "*mypcbench*.json"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }).stdout;
    expect(tracked.trim()).toBe("");
  });

  it("MB2 only tasks with no desktop app load, each judged by an LLM; an unknown app stops the load", async () => {
    const cases = await bench().load(ctx(), "full");
    expect(cases.map((c) => c.id)).toEqual(["bank-a001", "mail-b002", "shop-d004"]);
    expect(cases[1]).toMatchObject({ judge: "llm", tags: expect.arrayContaining(["mail", "hoolicalendar", "situated_action", "medium"]) });
    expect(cases.every((c) => c.judge === "llm")).toBe(true);
    const odd = JSON.stringify([{ ...TASKS[0], apps_involved: ["Mystery App"] }]);
    served = odd;
    try {
      await expect(mypcbenchBenchmark({ sha256: sha(odd) }).load({ ...ctx(), cacheDir: join(dir, "odd") }, "full")).rejects.toThrow("Mystery App");
    } finally { served = file; }
  });

  it("MB3 MB4 MB5 noop and a wrong claim pass 0, perfect passes all", async () => {
    expect((await play(noopAdapter())).passed).toBe(0);
    const wrong = agent("wrong", { answer: () => "I am sure it is 7", writes: () => [] });
    expect((await play(wrong)).passed).toBe(0);
    const board = await play(perfect);
    expect(board).toMatchObject({ tasks: 3, passed: 3 });
    expect(board.results.every((r) => r.score === 1)).toBe(true);
  });

  it("MB5 MB6 the judge sees the answer and the writes, never done, the log or reads", async () => {
    const calls: JudgeAsk[] = [];
    await play(perfect, [fake("fair", calls)], ["mail-b002"]);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("Email Dwight");
    expect(prompt).toContain("POST HooliMail /api/emails -> 200");
    expect(prompt).toContain("POST HooliCalendar /api/events -> 200");
    expect(prompt).not.toContain("GET ");
    expect(prompt).not.toContain("the log says so");
    expect(prompt).not.toMatch(/done/i);
    const quiet: JudgeAsk[] = [];
    await play(agent("reader", { answer: (id) => ANSWER[id]! }), [fake("fair", quiet)], ["mail-b002"]);
    expect(quiet[0]!.prompt).toContain("(none)");
  });

  it("MB7 a partial result fails with the share of the weight met", async () => {
    const half = agent("half", { answer: (id) => ANSWER[id]!, writes: () => [["HooliMail", "/api/emails"]] });
    const r = (await play(half, [fake()], ["mail-b002"])).results[0]!;
    expect(r).toMatchObject({ success: false, score: 0.5 });
    expect(r.reasons).toEqual(["item 2 (weight 0.5) is not met"]);
  });

  it("MB8 a reply with no verdict, or one item missing, fails with a judge reason", async () => {
    for (const mode of ["mute", "short"] as const) {
      const r = (await play(perfect, [fake(mode)], ["mail-b002"])).results[0]!;
      expect(r.success).toBe(false);
      expect(r.reasons[0]).toMatch(/^judge: claude: /);
    }
    expect((await play(perfect, [fake()], ["bank-a001"])).results[0]!.judges![0]).toMatchObject({ model: "claude-fake", where: "cloud", success: true });
  });

  it("MB9 a case with a write resets the VM before the next case; the mark outlives the run", async () => {
    seen.resets = 0;
    await play(agent("reader", { answer: (id) => ANSWER[id]! }));
    expect(seen.resets).toBe(0);
    await play(perfect);
    expect(seen.resets).toBe(1);
    seen.resets = 0;
    await play(perfect, [fake()], ["mail-b002"]);
    expect(seen.resets).toBe(0);
    await play(perfect, [fake()], ["bank-a001"]);
    expect(seen.resets).toBe(1);
  });

  it("MB10 each app is on its own port with the persona's cookie, which the agent never sees", async () => {
    seen.cookies = {};
    let goal = "";
    const probe: Adapter = { name: "probe", async runTask(input) { goal = input.goal; for (const m of input.goal.matchAll(/http:\/\/127\.0\.0\.1:\d+/g)) await fetch(m[0]); return { done: true, log: "", answer: "" }; } };
    await play(probe, [fake()], ["mail-b002"]);
    expect(goal).toContain(`- HooliMail: http://127.0.0.1:${3016 + agentOffset}`);
    expect(goal).toContain(`- HooliCalendar: http://127.0.0.1:${3017 + agentOffset}`);
    expect(goal).not.toContain("session_");
    for (const app of ["mail", "hoolicalendar"]) expect(seen.cookies[app]!.every((c) => c.startsWith(`session_${app}=`))).toBe(true);
  });

  it("MB11 a board names items by number, never by their text", async () => {
    const board = await play(agent("half", { answer: (id) => ANSWER[id]!, writes: () => [["HooliMail", "/api/emails"]] }), [fake()], ["mail-b002"]);
    expect(JSON.stringify(board)).not.toContain("calendar event");
  });

  it("MB12 with no judge the run gives a skip row", async () => {
    const board = await runBenchmarks({ adapter: noopAdapter(), runs: [{ benchmark: bench(), subset: "full" }] });
    expect(board.skipped.map((s) => s.benchmark)).toEqual(["mypcbench"]);
    expect(board.results).toEqual([]);
  });
});
