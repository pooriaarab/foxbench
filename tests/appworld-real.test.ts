// The appworld tests on a real install: real dev tasks and AppWorld's real
// evaluator, with scripted agents that run each task's own solution through
// the pages (tests/fixtures/appworld_solve.py). They run only with
// FOXBENCH_APPWORLD_ROOT and FOXBENCH_APPWORLD_PYTHON set, never in CI:
// AppWorld's data must not leave the user's machine.
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { startBridge } from "../src/bench/appworld/bridge.js";
import { appworldBenchmark } from "../src/bench/appworld/index.js";
import { startAppWorldSite } from "../src/bench/appworld/site.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import quick from "../src/bench/subsets/appworld.json" with { type: "json" };

const ROOT = process.env.FOXBENCH_APPWORLD_ROOT;
const PYTHON = process.env.FOXBENCH_APPWORLD_PYTHON ?? "python3";
const SPLIT = process.env.FOXBENCH_APPWORLD_SPLIT ?? "dev";
const COUNT = Number(process.env.FOXBENCH_APPWORLD_TASKS ?? 9);
const SOLVE = fileURLToPath(new URL("./fixtures/appworld_solve.py", import.meta.url));
/** Dev tasks whose own solution fails in AppWorld's own executor too (appworld 0.1.3.post1, data 0.1.0). Train has none. */
const DEV_FAILS = ["0d8a4ee_1", "0d8a4ee_2", "0d8a4ee_3", "37a8675_1", "37a8675_2", "37a8675_3", "3ab5b8b_1", "3ab5b8b_2", "3ab5b8b_3", "57c3486_1", "57c3486_3"];
const UPSTREAM_FAILS = SPLIT === "dev" ? DEV_FAILS : [];
const saved = { root: process.env.APPWORLD_ROOT, python: process.env.APPWORLD_PYTHON };
let ids: string[] = [];
const files = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)).toSorted();

beforeAll(async () => {
  if (!ROOT) return;
  Object.assign(process.env, { APPWORLD_ROOT: ROOT, APPWORLD_PYTHON: PYTHON });
  ids = (await appworldBenchmark().load(benchContext(), `tag:${SPLIT}`)).slice(0, COUNT).map((c) => c.id);
}, 120_000);
afterAll(() => {
  for (const [k, v] of [["APPWORLD_ROOT", saved.root], ["APPWORLD_PYTHON", saved.python]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

/** Runs each case's own solution through the pages; the cases run in `ids` order. Its stderr is dropped: it can quote AppWorld's data. */
function agent(mode: "perfect" | "wrong"): Adapter {
  const queue = [...ids];
  return {
    name: mode,
    async runTask({ url }) {
      const cwd = mkdtempSync(join(tmpdir(), "appworld-solve-"));
      const code = await new Promise<number>((resolve) => execFile(PYTHON, ["-I", "-B", SOLVE, mode, queue.shift()!, new URL(url).origin], { cwd, env: process.env }, (error) => resolve(error ? Number(error.code ?? 1) : 0)));
      rmSync(cwd, { recursive: true, force: true });
      return { done: true, log: `${mode} exit ${code}` };
    },
  };
}
const run = (adapter: Adapter) => runBenchmarks({ adapter, runs: [{ benchmark: appworldBenchmark(), subset: `tag:${SPLIT}` }], ids, timeoutMs: 600_000 });

describe.skipIf(!ROOT)("appworld on a real install", () => {
  it("AW11 each task's solution through the pages passes, noop and wrong fail, and no file is written", async () => {
    const watched = [ROOT!, join(homedir(), ".appworld")];
    const before = watched.map(files);
    const perfect = await run(agent("perfect"));
    expect(perfect.results.filter((r) => !r.success).map((r) => r.id)).toEqual(ids.filter((id) => UPSTREAM_FAILS.includes(id)));
    expect((await run(noopAdapter())).passed).toBe(0);
    const wrong = await run(agent("wrong"));
    expect(wrong.results.filter((r) => r.success).map((r) => r.id)).toEqual([]);
    expect(watched.map(files)).toEqual(before);
  }, 7_200_000);

  it("AW9 the install is ready, and quick names 20 test_normal tasks", async () => {
    expect(await appworldBenchmark().check(benchContext())).toEqual({ ready: true });
    const cases = await appworldBenchmark().load(benchContext(), "quick");
    expect(cases.map((c) => c.id)).toEqual(quick.quick);
    expect(cases.every((c) => c.tags[0] === "test_normal" && c.tier)).toBe(true);
  }, 120_000);

  it("AW17 gmail, splitwise, amazon and todoist have a page per API, with a field per parameter", async () => {
    const bridge = await startBridge(benchContext());
    const want = new Set(["gmail", "splitwise", "amazon", "todoist"]);
    const seen = new Map<string, number>();
    try {
      const tasks = (await bridge.tasks()).filter((t) => t.split === "test_normal");
      for (const { id } of tasks) {
        if (seen.size === want.size) break;
        const task = await bridge.open(id);
        const apps = Object.keys(task.apps).filter((a) => want.has(a) && !seen.has(a));
        if (!apps.length) continue;
        const site = await startAppWorldSite(bridge, task);
        try {
          for (const app of apps) {
            const index = await (await fetch(`${site.origin}/${app}/`)).text();
            for (const doc of task.apps[app]!) {
              const res = await fetch(`${site.origin}/${app}/${doc.name}`);
              const page = await res.text();
              expect([app, doc.name, res.status]).toEqual([app, doc.name, 200]);
              expect(index).toContain(`href="/${app}/${doc.name}"`);
              for (const p of doc.parameters) expect(page).toMatch(new RegExp(`<(input|textarea) name="${p.name}"`));
            }
            seen.set(app, task.apps[app]!.length);
          }
        } finally {
          await site.close();
        }
      }
    } finally {
      await bridge.close();
    }
    expect([...seen.keys()].toSorted()).toEqual([...want].toSorted());
    expect([...seen.values()].every((n) => n > 0)).toBe(true);
  }, 600_000);
});
