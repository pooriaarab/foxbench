// Tests for the Python environment failure modes in docs/failure-modes.md (PY1-PY7).
// PY3-PY5 build a real environment, with uv when it is on PATH and `python3 -m venv` when not.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonDir, pythonEnv, REQUIREMENTS } from "../src/bench/python.js";

const scratch = () => mkdtempSync(join(tmpdir(), "foxbench-py-"));
const script = (dir: string, name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
const builtIn = (cacheDir: string) => readdirSync(join(cacheDir, "python"));
const canImport = (python: string) => execFileSync(python, ["-I", "-c", "import requests; print(requests.__version__)"], { encoding: "utf8" }).trim();
const real = () => ({ cacheDir: scratch(), env: process.env });

describe("the Python environment", () => {
  it("PY1 says so when python3 is not installed, and leaves nothing", async () => {
    const cacheDir = scratch();
    await expect(pythonEnv({ cacheDir, env: { PATH: scratch() } })).rejects.toThrow(/python3 is not installed/);
    expect(existsSync(join(cacheDir, "python"))).toBe(false);
  });

  it("PY2 reports a venv that fails to build and keeps nothing", async () => {
    const cacheDir = scratch();
    const bin = scratch();
    script(bin, "python3", 'case "$1" in --version) echo Python 3.12.0;; *) echo "ensurepip is not available" >&2; exit 1;; esac');
    await expect(pythonEnv({ cacheDir, env: { PATH: bin } })).rejects.toThrow(/ensurepip is not available/);
    expect(builtIn(cacheDir)).toEqual([]);
  });

  it("PY3 does not reuse a half-built venv, and clears stale build directories", async () => {
    const ctx = real();
    const dir = pythonDir(ctx.cacheDir);
    mkdirSync(join(dir, "bin"), { recursive: true });
    script(join(dir, "bin"), "python", "exit 1");
    const stale = join(ctx.cacheDir, "python", ".build-dead");
    mkdirSync(stale);
    utimesSync(stale, new Date(0), new Date(0));
    const python = await pythonEnv(ctx);
    expect(python.startsWith(dir)).toBe(true);
    expect(canImport(python)).toMatch(/^\d/);
    expect(builtIn(ctx.cacheDir)).toEqual([dir.split("/").pop()]);
  }, 180_000);

  it("PY4 gives two builds at once the same interpreter and leaves one directory", async () => {
    const ctx = real();
    const [a, b] = await Promise.all([pythonEnv(ctx), pythonEnv(ctx)]);
    expect(a).toBe(b);
    expect(canImport(a)).toMatch(/^\d/);
    expect(builtIn(ctx.cacheDir)).toHaveLength(1);
  }, 180_000);

  it("PY5 returns a ready environment without python3 or the network", async () => {
    const ctx = real();
    const python = await pythonEnv(ctx);
    expect(await pythonEnv({ cacheDir: ctx.cacheDir, env: { PATH: scratch() } })).toBe(python);
    expect(python.startsWith(ctx.cacheDir)).toBe(true);
  }, 180_000);

  it("PY6 names the directory after the requirement list", () => {
    expect(pythonDir("/c", ["requests==2.32.5"])).not.toBe(pythonDir("/c", ["requests==2.32.4"]));
    expect(pythonDir("/c", REQUIREMENTS)).toBe(pythonDir("/c"));
    expect(REQUIREMENTS.every((r) => /^[\w.-]+==[\w.]+$/.test(r))).toBe(true);
  });

  it("PY7 uses uv for both the venv and the install when uv is on PATH", async () => {
    const cacheDir = scratch();
    const bin = scratch();
    const log = join(scratch(), "uv.log");
    symlinkSync(execFileSync("which", ["python3"], { encoding: "utf8" }).trim(), join(bin, "python3"));
    script(bin, "uv", `echo "$@" >> ${log}\nif [ "$1" = venv ]; then mkdir -p "$2/bin"; : > "$2/bin/python"; chmod +x "$2/bin/python"; fi`);
    const python = await pythonEnv({ cacheDir, env: { PATH: `${bin}:/usr/bin:/bin` } });
    const [venv, install] = readFileSync(log, "utf8").trim().split("\n");
    expect(venv).toMatch(/^venv .*\.build-/);
    expect(install).toMatch(new RegExp(`^pip install --python .*\\.build-.*/bin/python ${REQUIREMENTS.join(" ")}$`));
    expect(python).toBe(join(pythonDir(cacheDir), "bin", "python"));
  });
});
