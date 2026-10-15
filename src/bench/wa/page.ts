// The judge browser: the runner's own headless Firefox, never the agent's. It
// opens the pages program_html reads. create-foxkit drives Firefox and needs an
// extension, so a stub one is written into the cache. It always launches
// locally, whatever FOXKIT_BROWSER says: a remote session would need a
// Manifest V3 extension and could not reach the judge's 127.0.0.1 proxy (WJB1). A canonical site URL
// (`http://127.0.0.1:<site port>/...`) is opened on the origin the caller maps
// it to, such as a proxy that adds the site's login.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchContext } from "../types.js";
import type { WaPage } from "./eval.js";

export interface JudgeBrowser {
  page(): Promise<WaPage>;
  /** Closes the pages opened so far; the browser stays for the next case. */
  closePages(): Promise<void>;
  /** Closes the browser. */
  close(): Promise<void>;
}

/** `origins` maps each canonical origin to the one the browser opens it on; the browser starts on the first `page()`. */
export function judgeBrowser(ctx: BenchContext, origins: Record<string, string> = {}): JudgeBrowser {
  let fox: Awaited<ReturnType<(typeof import("create-foxkit/e2e"))["launch"]>> | undefined;
  const pages: { close(): Promise<unknown> }[] = [];
  const mapped = (url: string) => { const o = new URL(url).origin; return origins[o] ? origins[o] + url.slice(o.length) : url; };
  return {
    async page() {
      const extension = join(ctx.cacheDir, "wa-judge-extension");
      mkdirSync(extension, { recursive: true });
      writeFileSync(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 2, name: "foxbench judge", version: "1", browser_specific_settings: { gecko: { id: "judge@foxbench.invalid" } } }));
      const { launch } = await import("create-foxkit/e2e");
      fox ??= await launch({ extension, headless: true, remote: "local", ...(ctx.firefox ? { firefox: ctx.firefox } : {}) });
      const page = await fox.open("about:blank");
      pages.push(page);
      return {
        // The 3 s settle after it (eval.ts) stands in for the rest of the load: a GitLab merge request page holds the load event for over 30 s.
        goto: async (url) => { await page.goto(mapped(url), { waitUntil: "domcontentloaded", timeout: 60_000 }); },
        evaluate: (js) => page.evaluate(js),
        content: () => page.content(),
      };
    },
    closePages: async () => void (await Promise.all(pages.splice(0).map((p) => p.close().catch(() => {})))),
    async close() {
      await this.closePages();
      await fox?.close();
      fox = undefined;
    },
  };
}
