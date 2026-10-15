// WM12: the real WebMall sites on local Docker. Not in CI (3.6 GB): run with FOXBENCH_WEBMALL_LIVE=1.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { webmallSites } from "../src/bench/webmall/env.js";

// The sites on their local ports, with the Host header the recording proxy sends.
const at = (port: number, path = "") => fetch(`http://127.0.0.1:${port + 10000}${path}`, { headers: { host: `127.0.0.1:${port}` }, redirect: "manual" });

describe.skipIf(!process.env.FOXBENCH_WEBMALL_LIVE)("WM12 the real sites", () => {
  it("come up, answer on the proxy's origin, and hold the 4,421 offers", async () => {
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
});
