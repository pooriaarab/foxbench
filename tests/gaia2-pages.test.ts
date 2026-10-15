// Tests for the Gaia2 mail, calendar and contacts pages (GP1-GP6 in
// docs/failure-modes.md), through the run loop on ARE's real code and five
// real scenarios. A scripted agent does ARE's oracle actions through the pages.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { loadOracle, pageAgent, runGaia2 as run, type Oracle } from "./fixtures/gaia2-pages.js";

/** Between them: send, reply, forward, move, delete (mail), add, delete (calendar), add, edit, delete (contacts). */
const IDS = ["0099_dys7qiasymc6tsiomethj9v7ofhlksfb", "0127_ce0xbgfn1xfcqjk0bqrbzvywl89jvlam", "0094_7qgy90723vldb7dpyfbonnda946vhj5f", "0323_hcjynlo7n1etyqggk9bmx0ni1jr1dzf4", "0493_su3bfdjdmzi5t7g6p6qlanptvrbdj2d5"];
const BROWSE = ["/mail", "/mail?folder=SENT", "/calendar", "/contacts", "/contacts/me", "/mail?q=a", "/calendar?q=a", "/contacts?q=a"];
let oracle: Oracle;
beforeAll(async () => { oracle = await loadOracle(IDS); }, 1_800_000);
afterAll(async () => { await oracle?.close(); });

describe("gaia2 pages", () => {
  it("GP1 GP2 the oracle actions through the pages pass, after browsing every list", async () => {
    const board = await run(pageAgent(oracle, "perfect", oracle.order, BROWSE), oracle.order);
    expect(board.results.map((r) => [r.id, r.success, r.reasons])).toEqual(oracle.order.map((id) => [id, true, []]));
  }, 900_000);

  it("GP3 noop and a run without the last action fail", async () => {
    const two = oracle.order.slice(0, 2);
    expect(JSON.stringify((await run(noopAdapter(), two)).results.map((r) => r.success))).toBe("[false,false]");
    expect((await run(pageAgent(oracle, "wrong", two), two)).results.map((r) => r.success)).toEqual([false, false]);
  }, 900_000);

  it("GP4 GP5 GP6 lists page through everything, text is escaped, and a tool error is a 400", async () => {
    const seen: Record<string, unknown> = {};
    const looker: Adapter = { name: "looker", async runTask({ url }) {
      const get = (path: string) => fetch(new URL(path, url));
      // The ids on every page of a list, following its Next links.
      const ids = async (start: string, base: string) => {
        const found = new Set<string>();
        for (let next: string | null = start; next;) {
          const html = await (await get(next)).text();
          for (const m of html.matchAll(new RegExp(`href="${base}/([0-9a-f]{32})"`, "g"))) found.add(m[1]!);
          next = /href="([^"]*offset=\d+[^"]*)"/.exec(html)?.[1]?.replaceAll("&#38;", "&") ?? null;
        }
        return found.size;
      };
      // ARE's own count, from the generic form.
      const total = async (app: string, tool: string, count: (v: any) => number) => count(JSON.parse(/<pre>([\s\S]*)<\/pre>/.exec(await (await get(`/apps/${app}/${tool}?go=1`)).text())![1]!.replaceAll("&#34;", '"').replaceAll("&#39;", "'")));
      seen.mail = [await ids("/mail", "/mail/INBOX"), await total("Emails", "list_emails", (v) => v.total_emails)];
      seen.contacts = [await ids("/contacts", "/contacts"), await total("Contacts", "get_contacts", (v) => v.metadata.total)];
      await fetch(new URL("/contacts/new", url), { method: "POST", body: new URLSearchParams({ first_name: "<script>alert(1)</script>", last_name: "O'Neil & Co" }) });
      seen.page = await (await get("/contacts?q=Neil")).text();
      seen.error = (await get("/mail/INBOX/nothere")).status;
      seen.bad = (await fetch(new URL("/calendar/events/nothere/delete", url), { method: "POST", body: new URLSearchParams() })).status;
      return { done: true, log: "" };
    } };
    await run(looker, [oracle.order[0]!]);
    expect((seen.mail as number[])[0]).toBe((seen.mail as number[])[1]);
    expect((seen.contacts as number[])[0]).toBe((seen.contacts as number[])[1]);
    expect(String(seen.page)).toContain("&#60;script&#62;alert(1)&#60;/script&#62; O&#39;Neil &#38; Co");
    expect([seen.error, seen.bad]).toEqual([400, 400]);
  }, 600_000);
});
