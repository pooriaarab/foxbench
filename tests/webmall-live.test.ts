// WM12: the real WebMall sites on local Docker. Not in CI (3.6 GB): run with FOXBENCH_WEBMALL_LIVE=1.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { noopAdapter } from "../src/adapter.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { webmallSites } from "../src/bench/webmall/env.js";
import { webmallBenchmark } from "../src/bench/webmall/index.js";
import { loadTasks } from "../src/bench/webmall/tasks.js";
import { doTask, scripted } from "./fixtures/webmall-fakes.js";

// The sites on their local ports, with the Host header the recording proxy sends.
const at = (port: number, path = "") => fetch(`http://127.0.0.1:${port + 10000}${path}`, { headers: { host: `127.0.0.1:${port}` }, redirect: "manual" });

describe.skipIf(!process.env.FOXBENCH_WEBMALL_LIVE)("the real WebMall", () => {
  it("WM12 comes up, answers on the proxy's origin, and hold the 4,421 offers", async () => {
    const r = spawnSync(process.execPath, ["dist/cli.js", "env", "up", "webmall", "--provider", "docker"], { encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] });
    expect(r.status).toBe(0);
    let offers = 0;
    for (const site of webmallSites.filter((s) => s.id !== "frontend")) {
      const home = await at(site.port);
      expect([home.status, home.headers.get("location")]).toEqual([200, null]);
      const html = await home.text();
      expect(html).toContain(`http://127.0.0.1:${site.port}/`);
      expect(html).not.toContain("localhost");
      expect(html).toContain(`<title>${site.name}`);
      offers += Number((await at(site.port, "/wp-json/wc/store/v1/products?per_page=1")).headers.get("x-wp-total"));
      // Search goes through Elasticsearch.
      expect(await (await at(site.port, "/?s=samsung&post_type=product")).text()).toContain("Search Results");
    }
    expect(offers).toBe(4421);
    expect(await (await at(8085)).text()).toContain("Submit Final Result");
  }, 600_000);

  it("WS12 scores scripted agents on the real shops: perfect passes, noop and wrong fail", async () => {
    const tasks = await loadTasks(benchContext());
    const ids = (["string", "cart", "checkout"] as const).map((type) => tasks.find((t) => t.type === type)!.id);
    const run = (adapter: ReturnType<typeof scripted>) => runBenchmarks({ adapter, runs: [{ benchmark: webmallBenchmark(), subset: "full" }], ids, timeoutMs: 120_000 });
    expect(await run(scripted(tasks, "perfect", (t) => doTask(t)))).toMatchObject({ tasks: 3, passed: 3, adapterErrors: 0 });
    expect((await run(noopAdapter())).passed).toBe(0);
    expect((await run(scripted(tasks, "wrong", (t) => doTask(t, { wrong: true })))).passed).toBe(0);
  }, 600_000);
});
