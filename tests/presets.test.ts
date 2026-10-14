// Tests for the agent preset failure modes in docs/failure-modes.md (A1-A4).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const FIXTURE = join(root, "tests/fixtures/mcp-server.mjs");

/** Runs `foxbench run` in a fresh directory with these preset files (cwd and ~/.config/foxbench). */
function run(agent: string, files: { cwd?: object; config?: object }) {
  const cwd = mkdtempSync(join(tmpdir(), "fbn-presets-"));
  const home = join(cwd, "home");
  mkdirSync(join(home, ".config", "foxbench"), { recursive: true });
  if (files.cwd) writeFileSync(join(cwd, "foxbench.agents.json"), JSON.stringify(files.cwd));
  if (files.config) writeFileSync(join(home, ".config", "foxbench", "foxbench.agents.json"), JSON.stringify(files.config));
  const r = spawnSync(process.execPath, [join(root, "dist/cli.js"), "run", "--agent", agent, "--tasks", "mail-archive", "--out", "out"],
    { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home } });
  const out = join(cwd, "out");
  const file = r.status === 2 ? undefined : readdirSync(out).find((f) => f.endsWith(".json"));
  return { status: r.status, stderr: r.stderr, board: file ? JSON.parse(readFileSync(join(out, file), "utf8")) : null };
}
const fixture = (name: string, extra = {}) => ({ command: process.execPath, args: [FIXTURE], name, ...extra });

describe("A1 a preset cannot replace noop or mcp", () => {
  it("refuses the file", () => {
    const r = run("noop", { cwd: { noop: fixture("fake") } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('"noop" is a built-in agent');
  });
});

describe("A2 an unknown agent", () => {
  it("exits 2 and names the presets and files", () => {
    const r = run("nope", { cwd: { foxmate: fixture("foxmate") } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown agent "nope"\. Presets: foxmate \(from .*foxbench\.agents\.json/);
  });
});

describe("A3 the working directory wins", () => {
  it("uses the cwd preset over the config one", () => {
    const r = run("foxmate", { cwd: { foxmate: fixture("from-cwd") }, config: { foxmate: fixture("from-config"), other: fixture("other") } });
    expect(r.board.agent).toBe("from-cwd");
    expect(run("other", { config: { other: fixture("other") } }).board.agent).toBe("other");
  });
});

describe("A4 a preset is the same mcp call", () => {
  it("passes the command, tool, name and extra arguments", () => {
    const r = run("foxmate", { cwd: { foxmate: fixture("foxmate-local", { tool: "run_task", arg: { llm: true } }) } });
    expect(r.status).toBe(0);
    expect(r.board).toMatchObject({ agent: "foxmate-local", adapterErrors: 0 });
    expect(JSON.parse(r.board.results[0].log).args).toMatchObject({ llm: true, goal: expect.any(String), url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) });
  });
});
