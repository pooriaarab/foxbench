#!/usr/bin/env node
// The E2E check for the WebArena judge browser: a real headless Firefox opens a
// page that a local server hands out only to a request with a login header, runs
// program_html locators in it, and closes. Usage: node e2e/wa-judge.mjs (FIREFOX).
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeBrowser } from "../dist/bench/wa/page.js";
import { scoreWa } from "../dist/bench/wa/eval.js";

const site = createServer((req, res) => {
  const page = req.headers["x-auto-login"] ? '<input id="name" value="Alice"><p>Order saved</p>' : "<p>Please sign in</p>";
  res.writeHead(200, { "content-type": "text/html" }).end(page);
});
// The site's own origin is canonical; the judge browser reaches it on a proxy that adds the login.
const proxy = createServer((req, res) => {
  fetch(`http://127.0.0.1:${site.address().port}${req.url}`, { headers: { "x-auto-login": "admin" } }).then(async (r) => res.writeHead(r.status, { "content-type": "text/html" }).end(await r.text()));
});
await Promise.all([site, proxy].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
const canonical = "http://127.0.0.1:7780";
const task = (locator, contents) => ({ intent: "q", eval: { eval_types: ["program_html"], program_html: [{ url: `${canonical}/p`, locator, required_contents: contents }] } });
const browser = judgeBrowser({ cacheDir: mkdtempSync(join(tmpdir(), "fbn-wa-")), env: process.env, ...(process.env.FIREFOX ? { firefox: process.env.FIREFOX } : {}) },
  { [canonical]: `http://127.0.0.1:${proxy.address().port}` });
const checks = [];
try {
  const facts = { answer: "", finalUrl: undefined, judges: [], settleMs: 0, page: () => browser.page() };
  const run = async (t) => (await scoreWa(t, facts)).success;
  checks.push(["a JS locator reads the logged-in page", await run(task("document.querySelector('#name').value", { exact_match: "alice" }))]);
  checks.push(["an empty locator reads the page HTML", await run(task("", { must_include: ["order saved"] }))]);
  checks.push(["a locator for a missing element fails", !(await run(task("document.querySelector('#nope').value", { must_include: ["alice"] })))]);
} finally {
  await browser.close();
  proxy.close();
  site.close();
}
for (const [name, ok] of checks) console.log(`${ok ? "pass" : "FAIL"} ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
