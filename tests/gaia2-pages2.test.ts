// Tests for the Gaia2 chat, shop and file pages (GQ1-GQ7 in
// docs/failure-modes.md), through the run loop on ARE's real code and four
// real scenarios. A scripted agent does ARE's oracle actions through the pages.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { loadOracle, pageAgent, runGaia2 as run, type Oracle } from "./fixtures/gaia2-pages.js";

/** Between them: send in both chat apps, a new group and a message to it (twice), checkout, mkdir, move, delete. */
const IDS = ["0088_ijzntzipdrjox9ywyw23k4qqpu6emykf", "0334_w4362b7r0l35e4yc9is7qyhn96g471yb", "0499_sxolu66surkx2ejm0ix0mpbjlqgyp9zs", "0112_vkqflpo2xi3soprbqkko12hnqrn5an7z"];
const BROWSE = ["/chats", "/messages", "/shop", "/shop?q=a", "/shop/cart", "/shop/orders", "/shop/discounts", "/files", "/files?path=/Documents"];
let oracle: Oracle;
beforeAll(async () => { oracle = await loadOracle(IDS); }, 1_800_000);
afterAll(async () => { await oracle?.close(); });

describe("gaia2 pages 2", () => {
  it("GQ1 GQ2 the oracle actions through the pages pass, after browsing every list", async () => {
    const board = await run(pageAgent(oracle, "perfect", oracle.order, BROWSE), oracle.order);
    expect(board.results.map((r) => [r.id, r.success, r.reasons])).toEqual(oracle.order.map((id) => [id, true, []]));
  }, 900_000);

  it("GQ3 noop and a run without the last action fail", async () => {
    const two = oracle.order.slice(0, 2);
    expect((await run(noopAdapter(), two)).results.map((r) => r.success)).toEqual([false, false]);
    expect((await run(pageAgent(oracle, "wrong", two), two)).results.map((r) => r.success)).toEqual([false, false]);
  }, 900_000);

  it("GQ4 GQ5 GQ6 GQ7 lists page through everything, forms change ARE's state, text is escaped, errors are 400", async () => {
    const seen: Record<string, string | number> = {};
    const looker: Adapter = { name: "looker", async runTask({ url }) {
      const get = async (path: string) => (await fetch(new URL(path, url))).text();
      const post = async (path: string, fields: Record<string, string>) => { const r = await fetch(new URL(path, url), { method: "POST", body: new URLSearchParams(fields) }); return [r.status, await r.text()] as const;
      };
      // Every product on every page, against ARE's own count.
      const found = new Set<string>();
      for (let next: string | null = "/shop"; next;) {
        const html = await get(next);
        for (const m of html.matchAll(/href="\/shop\/products\/(\w+)"/g)) found.add(m[1]!);
        next = /href="([^"]*offset=\d+[^"]*)"/.exec(html)?.[1]?.replaceAll("&#38;", "&") ?? null;
      }
      seen.products = found.size;
      seen.total = Number(/total&#34;:\s*(\d+)/.exec(await get("/apps/Shopping/list_all_products?go=1"))?.[1]);
      // The cart: add one item through a product page, see it, check out, see the order, cancel it.
      const item = /name="item_id" value="(\w+)"/.exec(await get(`/shop/products/${[...found][0]}`))![1]!;
      await post("/shop/cart/add", { item_id: item, quantity: "2" });
      seen.cart = (await get("/shop/cart")).includes(item) ? "in" : "missing";
      await post("/shop/cart/remove", { item_id: item, quantity: "2" });
      seen.removed = (await get("/shop/cart")).includes(`${item}:`) ? "still" : "gone";
      await post("/shop/cart/add", { item_id: item, quantity: "1" });
      const order = /<pre>(\w+)<\/pre>/.exec((await post("/shop/cart/checkout", {}))[1])![1]!;
      seen.order = (await get("/shop/orders")).includes(order) ? "listed" : "missing";
      await post(`/shop/orders/${order}/cancel`, {});
      seen.cancelled = /cancelled/i.test(await get(`/shop/orders/${order}`)) ? "yes" : "no";
      // A group, retitled, with a member removed and added again.
      const chats = await get("/chats");
      const people = [...new Set(chats.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g))].slice(0, 3);
      const made = await post("/chats/new", { user_ids: people.join(","), title: "Plans" });
      const group = /<pre>(\w+)<\/pre>/.exec(made[1])![1]!;
      await post(`/chats/${group}/title`, { title: "New plans" });
      await post(`/chats/${group}/remove`, { user_id: people[2]! });
      await post(`/chats/${group}/add`, { user_id: people[2]! });
      seen.group = (await get(`/chats/${group}`)).includes("New plans") ? "retitled" : "same";
      // Files: a folder named with markup is listed escaped; a missing path is an error.
      await post("/files/mkdir", { path: "/<i>x&y" });
      seen.files = (await get("/files")).includes("/&#60;i&#62;x&#38;y") ? "escaped" : "raw";
      seen.errors = [(await fetch(new URL("/shop/products/nothere", url))).status, (await post("/files/rm", { path: "/nothere" }))[0]].join(",");
      return { done: true, log: "" };
    } };
    const board = await run(looker, [oracle.order[0]!]);
    expect(board.results[0]!.log).toBe("");
    expect(seen.products).toBe(seen.total);
    expect([seen.cart, seen.removed, seen.order, seen.cancelled, seen.group, seen.files, seen.errors]).toEqual(["in", "gone", "listed", "yes", "retitled", "escaped", "400,400"]);
  }, 900_000);
});
