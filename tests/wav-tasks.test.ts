// Tests for the WebArena-Verified task failure modes in docs/failure-modes.md
// (WT1-WT10). They load the real task list through uv, then start real cases
// against fake sites on the tunnel ports, moved by an offset so a local
// Docker run of the real containers does not clash.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { benchContext } from "../src/bench/registry.js";
import type { Case, Env } from "../src/bench/types.js";
import { webarenaVerified } from "../src/bench/wav/index.js";

const OFFSET = 40000;
const bench = webarenaVerified({ offset: OFFSET });
const ctx = benchContext();
let all: Case[] = [];
let env: Env = {};
beforeAll(async () => {
  all = await bench.load(ctx, "full");
  env = await bench.up(ctx);
}, 300_000);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});
const byId = (id: string) => all.find((c) => c.id === id)!;
/** A fake site on a tunnel port that echoes the headers it got. */
async function fakeSite(port: number) {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port + OFFSET, "127.0.0.1", r));
  return seen;
}
/** A fake GitLab sign-in: a form with a token, then a session cookie for byteblaze. */
async function fakeGitlab() {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    if (req.method === "GET" && req.url === "/users/sign_in") {
      res.setHeader("set-cookie", "_gitlab_session=anon; path=/; HttpOnly");
      return res.end('<form><input type="hidden" name="authenticity_token" value="tok+en/=" autocomplete="off"></form>');
    }
    const form = new URLSearchParams(body);
    const ok = req.method === "POST" && req.headers.cookie === "_gitlab_session=anon" && form.get("authenticity_token") === "tok+en/="
      && form.get("user[login]") === "byteblaze" && form.get("user[password]") === "hello1234" && req.headers.host === "127.0.0.1:8023";
    res.writeHead(ok ? 302 : 422, ok ? { location: "http://127.0.0.1:8023/", "set-cookie": "_gitlab_session=signed-in; path=/; HttpOnly" } : {}).end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(8023 + OFFSET, "127.0.0.1", r));
}

describe("WT1 upstream's task list", () => {
  it("has the 812 tasks, with upstream's task ids", () => {
    expect(all).toHaveLength(812);
    expect(new Set(all.map((c) => c.id))).toEqual(new Set(Array.from({ length: 812 }, (_, i) => String(i))));
    expect(byId("0").goal).toBe("Get the top-1 best-selling product name(s) in 2022");
  });
});

describe("WT2 the hard subset", () => {
  it("is the package's list of 258, each tier hard", async () => {
    const hard = await bench.load(ctx, "tag:hard");
    expect(hard).toHaveLength(258);
    expect(hard.every((c) => c.tier === "hard")).toBe(true);
    expect(all.filter((c) => c.tier === "hard")).toHaveLength(258);
  });
});

describe("WT3 site tags", () => {
  it("tag each case with its sites, task type and multi-site", async () => {
    for (const [site, n] of [["shopping", 192], ["shopping_admin", 184], ["reddit", 129], ["gitlab", 204]] as const) expect(await bench.load(ctx, `tag:${site}`)).toHaveLength(n);
    expect(byId("552").tags).toEqual(expect.arrayContaining(["gitlab", "reddit", "multi-site", "mutate"]));
    expect(byId("0").tags).toEqual(expect.arrayContaining(["shopping_admin", "retrieve"]));
    expect(byId("0").tags).not.toContain("multi-site");
  });
});

describe("WT4 the start URL and the base URL", () => {
  it("opens the tunnel URL with the start path, on the site port, with the site's Host", async () => {
    const admin = await bench.start(env, byId("0"));
    // shopping_admin's site URL is upstream's http://<host>:7780/admin.
    expect(admin).toMatchObject({ url: `http://127.0.0.1:${7780 + OFFSET}/admin/`, startPath: "/admin/", port: 7780, headers: { host: "127.0.0.1:7780" } });
    const shop = await bench.start(env, byId("21"));
    expect(shop.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${7770 + OFFSET}/6s-wireless-headphones-.*\\.html$`));
    expect(shop.startPath).toBe(new URL(shop.url).pathname);
    expect(shop.port).toBe(7770);
    expect(shop.url).not.toContain("__");
    await Promise.all([admin.close?.(), shop.close?.()]);
  });
});

describe("WT5 logged in, with no password in sight", () => {
  it("sends upstream's auto-login headers", async () => {
    const [admin, shop, reddit] = await Promise.all(["0", "21", "27"].map((id) => bench.start(env, byId(id))));
    expect(admin!.headers).toMatchObject({ "X-M2-Admin-Auto-Login": "admin:admin1234" });
    expect(shop!.headers).toMatchObject({ "X-M2-Customer-Auto-Login": "emma.lopez@gmail.com:Password.123" });
    expect(reddit!.headers).toMatchObject({ "X-Postmill-Auto-Login": "MarvelsGrantMan136:test1234" });
    // The goal is upstream's prompt; the header itself never shows in it.
    for (const e of [admin!, shop!, reddit!]) expect(e.goal).not.toMatch(/Auto-Login/i);
  });
  it("signs in to GitLab and sends the session cookie", async () => {
    await fakeGitlab();
    const gitlab = await bench.start(env, byId("44"));
    expect(gitlab.headers).toMatchObject({ host: "127.0.0.1:8023", cookie: "_gitlab_session=signed-in" });
    expect(gitlab.goal).not.toContain("_gitlab_session");
  });
});

describe("WT6 a task on two sites", () => {
  it("serves the other site through its own proxy on its port, and close stops it", async () => {
    await fakeGitlab();
    const seen = await fakeSite(9999);
    const episode = await bench.start(env, byId("552"));
    expect(episode.port).toBe(8023);
    expect(episode.goal).toContain("http://127.0.0.1:9999/");
    expect((await fetch("http://127.0.0.1:9999/forums")).status).toBe(200);
    expect(seen[0]).toMatchObject({ host: "127.0.0.1:9999", "x-postmill-auto-login": "MarvelsGrantMan136:test1234" });
    await episode.close?.();
    await expect(fetch("http://127.0.0.1:9999/forums")).rejects.toThrow();
  });
});

describe("WT10 upstream's prompt", () => {
  it("is the prompt for the task's sites, with the intent and the start URLs on the proxy ports", async () => {
    const admin = await bench.start(env, byId("0"));
    expect(admin.goal).toContain("You are an autonomous web agent");
    expect(admin.goal).toContain("- **Task Objective:** `Get the top-1 best-selling product name(s) in 2022`");
    expect(admin.goal).toContain("  - http://127.0.0.1:7780/admin/\n");
    expect(admin.goal).toContain('"task_type": "RETRIEVE|MUTATE|NAVIGATE"');
    expect(admin.goal).not.toMatch(/\{\{|\{%/);
    await fakeGitlab();
    await fakeSite(9999);
    const both = await bench.start(env, byId("552"));
    expect(both.goal).toContain("### GitLab");
    expect(both.goal).toContain("### Discussion Forum");
    expect(both.goal).toMatch(/ {2}- http:\/\/127\.0\.0\.1:8023\/\S*\n {2}- http:\/\/127\.0\.0\.1:9999\//);
    await both.close?.();
  });
});

describe("WT7 a map or Wikipedia task", () => {
  it("fails at start with a reason that names wav-full", async () => {
    const map = all.find((c) => c.tags.includes("map"))!;
    await expect(bench.start(env, map)).rejects.toThrow(/map.*wav-full/);
  });
});

describe("WT8 the quick subset", () => {
  it("is the committed 20 single-site ids, 5 per wav-core site", async () => {
    const list = JSON.parse(readFileSync(join(import.meta.dirname, "../src/bench/subsets/webarena-verified.json"), "utf8")).quick as string[];
    const quick = await bench.load(ctx, "quick");
    expect(quick.map((c) => c.id)).toEqual(list);
    expect(list).toHaveLength(20);
    for (const site of ["shopping", "shopping_admin", "reddit", "gitlab"]) expect(quick.filter((c) => c.tags.includes(site))).toHaveLength(5);
    expect(quick.some((c) => c.tags.includes("multi-site"))).toBe(false);
  });
});

describe("WT9 no uv", () => {
  it("is not ready, with the fix", async () => {
    const r = await bench.check(benchContext({ env: { FOXBENCH_UV: "/nonexistent/uv" } }));
    expect(r).toMatchObject({ ready: false, reason: expect.stringContaining("uv"), fix: expect.stringContaining("astral.sh/uv") });
  });
});
