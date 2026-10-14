// Tests for E11 in docs/failure-modes.md: a public benchmark whose tool is
// missing is not ready, with the tool and the fix named. The scripted runs
// (noop, perfect, wrong, gullible) are in e2e/bench.mjs: they need Firefox,
// git and uv.
import { describe, expect, it } from "vitest";
import { benchContext, benchmarkById } from "../src/bench/registry.js";

describe("E11 a missing tool is a skip row", () => {
  it("names the tool and the fix", async () => {
    const ctx = benchContext({ env: { PATH: "/nonexistent" } });
    for (const [id, tool] of [["miniwob", "git"], ["agentdojo", "uv"]] as const) {
      const ready = await benchmarkById(id)!.check(ctx);
      expect(ready).toMatchObject({ ready: false, reason: expect.stringContaining(tool), fix: expect.any(String) });
    }
  });
});
