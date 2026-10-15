// Tests for AC1-AC4 in docs/failure-modes.md. They run a small app of our own
// through startApp with a fake judge; the scores with AgentDojo's own checks
// are in e2e/bench.mjs, which needs uv.
import { afterEach, describe, expect, it } from "vitest";
import { casesFile, startApp, type Call, type Judgement, type JudgeInput, type SuiteApp } from "../src/bench/agentdojo/common.js";

interface Env { notes: string[] }
const app: SuiteApp<Env> = {
  intro: "",
  startPath: "/notes/",
  page(env, calls, req, form) {
    if (req.method === "POST") {
      calls.push({ function: "add_note", args: { text: form.text ?? "" } });
      env.notes.push(form.text ?? "");
    }
    return "<p>notes</p>";
  },
};
const item = (injection: string | null = null) => ({ id: "t", user_task: "user_task_0", injection_task: injection, goal: "Add a note.", env: { notes: ["first"] } });

const seen: JudgeInput[] = [];
const running: { close(): Promise<void> }[] = [];
async function open(injection: string | null = null, verdict: Judgement = { utility: true, security: null }) {
  const run = await startApp(item(injection), app, async (input) => { seen.push(input); return verdict; });
  running.push(run);
  return { run, post: (text: string) => fetch(new URL("/notes/", run.url), { method: "POST", body: new URLSearchParams({ text }) }) };
}
afterEach(async () => { seen.length = 0; await Promise.all(running.splice(0).map((r) => r.close())); });

describe("AC1 the cache is per suite", () => {
  it("names the cases file for the suite and the pinned versions", () => {
    expect(casesFile("/c", "slack")).toBe("/c/agentdojo-slack-0.1.35-v1.2.2.json");
    expect(casesFile("/c", "banking")).not.toBe(casesFile("/c", "slack"));
  });
});

describe("AC2 the judge gets the calls", () => {
  it("passes the recorded calls in order, with both environments", async () => {
    const { run, post } = await open();
    await post("a");
    await post("b");
    await run.judge({ done: true, log: "" });
    const calls: Call[] = [{ function: "add_note", args: { text: "a" } }, { function: "add_note", args: { text: "b" } }];
    expect(seen[0]).toMatchObject({ user_task: "user_task_0", injection_task: null, traces: calls, pre: { notes: ["first"] }, post: { notes: ["first", "a", "b"] } });
  });
  it("sends no calls for a case where the app made none", async () => {
    const { run } = await open();
    await run.judge({ done: false, log: "" });
    expect(seen[0]!.traces).toEqual([]);
  });
});

describe("AC3 the verdict reads the end state", () => {
  it("keeps the start environment apart from the app's", async () => {
    const { run, post } = await open();
    await post("changed");
    await run.judge({ done: true, log: "" });
    expect(seen[0]!.pre).toEqual({ notes: ["first"] });
  });
  it("sends the answer, else the log, and never done", async () => {
    const { run } = await open();
    await run.judge({ done: true, log: "the log", answer: "the answer" });
    await run.judge({ done: true, log: "the log" });
    await run.judge({ done: true, log: "" });
    expect(seen.map((s) => s.output)).toEqual(["the answer", "the log", ""]);
  });
});

describe("AC4 the attack is reported as AgentDojo's security says", () => {
  it("is null when the case has no injection task", async () => {
    const { run } = await open(null, { utility: true, security: null });
    expect(await run.judge({ done: false, log: "" })).toEqual({ success: true, attack: null, reasons: [], judgedBy: "programmatic" });
  });
  it("is blocked when security is false and followed when it is true", async () => {
    expect(await (await open("injection_task_1", { utility: true, security: false })).run.judge({ done: false, log: "" })).toMatchObject({ success: true, attack: "blocked", reasons: [] });
    expect(await (await open("injection_task_1", { utility: false, security: true })).run.judge({ done: false, log: "" })).toMatchObject({
      success: false, attack: "followed", reasons: [expect.stringContaining("utility false (user_task_0)"), expect.stringContaining("the attack injection_task_1 worked")],
    });
  });
});
