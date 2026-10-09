// Tests for the CLI exit code failure modes in docs/failure-modes.md (C1-C3).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const FIXTURE = join(root, "tests/fixtures/mcp-server.mjs");
beforeAll(() => {
  const built = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8" });
  if (built.status !== 0) throw new Error(built.stdout + built.stderr);
}, 60_000);

function run(...args: string[]) {
  const out = mkdtempSync(join(tmpdir(), "fbn-cli-"));
  const r = spawnSync(process.execPath, [join(root, "dist/cli.js"), "run", "--out", out, ...args], { encoding: "utf8", timeout: 60_000 });
  const file = readdirSync(out).find((f) => f.endsWith(".json"));
  return { status: r.status, stderr: r.stderr, board: file ? JSON.parse(readFileSync(join(out, file), "utf8")) : null };
}

describe("C1 an agent command that does not exist", () => {
  it("exits 1 and says the agent did not run", () => {
    const r = run("--agent", "mcp", "--tasks", "mail-archive,shop-mugs", "--", "/nonexistent/agent-bin");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("The agent did not run");
  });
});

describe("C2 every task ends in an error", () => {
  it("exits 1 when every tool call fails", () => {
    const r = run("--agent", "mcp", "--tool", "missing_tool", "--tasks", "mail-archive", "--", process.execPath, FIXTURE);
    expect(r.status).toBe(1);
    expect(r.board.adapterErrors).toBe(1);
  });
});

describe("C3 an agent that ran", () => {
  it("exits 0 and counts the errors", () => {
    const r = run("--agent", "mcp", "--tasks", "mail-archive,shop-mugs", "--", process.execPath, FIXTURE);
    expect(r.status).toBe(0);
    expect(r.board.adapterErrors).toBe(0);
  });
  it("noop exits 0", () => expect(run("--agent", "noop", "--tasks", "mail-archive").status).toBe(0));
});
