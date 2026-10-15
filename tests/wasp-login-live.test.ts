// WS10: WASP's attacker account logs in on the real injector path. Not in CI (it
// fetches WASP's code and installs Chromium): run with FOXBENCH_WASP_LIVE=1. A fake
// GitLab shows the onboarding survey after the first login, as WebArena's GitLab does,
// with a submit input where upstream's login looks for a button.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchContext } from "../src/bench/registry.js";
import { EDITOR, fetchWasp } from "../src/bench/wasp/inject.js";
import { freeBase } from "./free-base.js";

const page = (body: string) => `<html><body>${body}</body></html>`;
const SIGN_IN = page('<form method="post" action="/users/sign_in"><input id="user_login" name="login"><input id="user_password" name="password" type="password"><button type="submit">Sign in</button></form>');
const SURVEY = page('<p>To personalize your GitLab experience</p><form method="post" action="/users/sign_up/welcome"><select id="user_role" name="role"><option value="">Select</option><option value="software_developer">Software Developer</option></select><input type="submit" value="Get started!"></form>');

let server: Server;
let origin = "";
let onboarded = false;
beforeAll(async () => {
  const port = await freeBase(23000, 500, []);
  server = createServer((req, res) => {
    const to = (location: string) => res.writeHead(302, { location }).end();
    if (req.url === "/users/sign_in") return req.method === "POST" ? to("/") : res.end(SIGN_IN);
    if (req.url === "/users/sign_up/welcome") {
      if (req.method !== "POST") return res.end(SURVEY);
      onboarded = true;
      return to("/");
    }
    if (req.url === "/" && !onboarded) return to("/users/sign_up/welcome");
    res.end(page("dashboard"));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  origin = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe.skipIf(!process.env.FOXBENCH_WASP_LIVE)("WS10 the attacker account's login", () => {
  it("finishes the onboarding survey and ends on the dashboard", async () => {
    const ctx = benchContext({ env: { ...process.env } });
    const wasp = await fetchWasp(ctx);
    const helper = join(ctx.cacheDir, "wasp-helper-test");
    mkdirSync(helper, { recursive: true });
    writeFileSync(join(helper, "foxbench_editor.py"), EDITOR);
    writeFileSync(join(helper, "login.py"), `import os, sys
sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), sys.argv[1]]
from foxbench_editor import Editor
with Editor(sys.argv[2]) as e:
    e.login("arsenelupin", "notaverycommonlyusedpassword")
    print("LOGIN", e.page.url)
`);
    const { stdout: out } = await promisify(execFile)(ctx.env.FOXBENCH_UV || "uv", ["run", "-q", "--isolated", "--no-project", "--python", "3.12", "--with", "playwright==1.55.0", "python", "-I", join(helper, "login.py"), wasp, origin],
      { encoding: "utf8", env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(ctx.cacheDir, "wasp-browsers") }, timeout: 120_000 });
    expect(out).toContain(`LOGIN ${origin}/`);
    expect(onboarded).toBe(true);
  }, 180_000);
});
