// Tests for the speed and fingerprint failure modes in docs/failure-modes.md
// (F1-F7).
import { homedir, hostname, userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { noopAdapter } from "../src/adapter.js";
import { fingerprint } from "../src/bench/fingerprint.js";
import type { TaskResult } from "../src/bench/run.js";
import { p90, speedOf } from "../src/bench/speed.js";
import { runSuite } from "../src/runner.js";
import { toMarkdown } from "../src/score.js";
import { tasksIn } from "../src/tasks.js";
import { referenceAdapter } from "./reference.js";

const result = (ms: number, success: boolean, agentMetrics: TaskResult["agentMetrics"] = null, firstActionMs: number | null = null): TaskResult => ({
  id: `c${ms}`, benchmark: "toy", suite: "toy", tier: null, trap: false, success, attack: null, secure: success, reasons: [], ms, done: true,
  adapterError: false, endedEarly: false, log: "", requests: 1, posts: 0, firstActionMs, egress: { requests: 0, bytes: 0 }, asks: 0, user: null, agentMetrics });

describe("F1 the median over passed cases stands apart", () => {
  it("is the median of the passed times only, and null when nothing passed", () => {
    const s = speedOf([result(10_000, true), result(20_000, true), result(90_000, false), result(100_000, false), result(110_000, false)]);
    expect(s).toMatchObject({ cases: 5, passed: 2, medianMs: 90_000, medianPassedMs: 15_000 });
    expect(speedOf([result(5_000, false)]).medianPassedMs).toBeNull();
  });
});

describe("F2 p90 is the nearest rank", () => {
  it("takes the value at rank ceil(0.9 n)", () => {
    expect(p90([10, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(9);
    expect(p90([1, 2, 3])).toBe(3);
    expect(p90([7])).toBe(7);
    expect(p90([])).toBeNull();
  });
});

describe("F3 tokens per pass", () => {
  it("divides all reported tokens by the passes, or is null", () => {
    expect(speedOf([result(1, true, { tokensIn: 900, tokensOut: 100 }), result(2, true, { tokensIn: 150 }), result(3, false, { tokensOut: 50 })]).tokensPerPass).toBe(600);
    expect(speedOf([result(1, true), result(2, true)]).tokensPerPass).toBeNull();
    expect(speedOf([result(1, false, { tokensIn: 10 })]).tokensPerPass).toBeNull();
  });
});

describe("F4 a parallel board is not a speed claim", () => {
  it("records serial and says so when it is not", async () => {
    const board = await runSuite({ adapter: noopAdapter(), tasks: tasksIn("core").slice(0, 2) });
    expect(board.fingerprint).toMatchObject({ serial: true, workers: 1 });
    expect(toMarkdown(board)).not.toContain("does not support speed claims");
    expect(toMarkdown({ ...board, fingerprint: { ...board.fingerprint, serial: false, workers: 4 } })).toContain("does not support speed claims");
  });
});

describe("F5 F6 F7 the fingerprint", () => {
  it("writes null for a Firefox it cannot run, and never throws", () => {
    expect(fingerprint({ firefox: "/nonexistent/firefox", env: {} }).firefox).toBeNull();
  });
  it("holds no hostname, user name or home path", () => {
    const text = JSON.stringify(fingerprint({ env: process.env }));
    for (const secret of [hostname(), userInfo().username, homedir()]) expect(text).not.toContain(secret);
  });
  it("keeps what the operator reports apart from what it measured", () => {
    const f = fingerprint({ env: { FOXBENCH_MODEL: "Saluki-27B.gguf", FOXBENCH_QUANT: "IQ2_M", FOXBENCH_NETWORK: "home" } });
    expect(f.reported).toEqual({ agentVersion: null, model: "Saluki-27B.gguf", quant: "IQ2_M", llamaFlags: null, network: "home" });
    expect(JSON.stringify({ ...f, reported: null })).not.toContain("Saluki");
    expect(f.ramGb).toBeGreaterThan(0);
    expect(f.foxbench).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("speed in the board", () => {
  it("shows per-benchmark speed: noop has no passed time, the reference solver has one", async () => {
    const noop = await runSuite({ adapter: noopAdapter(), tasks: tasksIn("core").slice(0, 2) });
    expect(noop.speed.all).toMatchObject({ cases: 2, passed: 0, medianPassedMs: null });
    const reference = await runSuite({ adapter: referenceAdapter(), tasks: tasksIn("hard") });
    expect(reference.speed.byBenchmark.foxbench).toMatchObject({ cases: 10, passed: 10 });
    expect(reference.speed.all.medianPassedMs).toEqual(expect.any(Number));
    expect(toMarkdown(reference)).toMatch(/\| foxbench \| 10\/10 \| [\d.]+ s \| [\d.]+ s \| [\d.]+ s \|/);
  });
});
