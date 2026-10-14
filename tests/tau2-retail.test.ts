// Tests for the tau2 retail site failure modes in docs/failure-modes.md
// (T1-T8), on tau2's real code: the first run fetches tau2 at the pinned
// commit into the cache, and uv installs it. A scripted agent does each
// task's gold actions through the pages, as a browser agent would.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchContext } from "../src/bench/registry.js";
import { fetchTau2, startBridge, TAU2_REF, tau2Dir, type Tau2Bridge } from "../src/bench/tau2/bridge.js";
import { RETAIL_WRITES, startRetailSite, type Tau2Site } from "../src/bench/tau2/retail.js";

interface Action { name: string; arguments: Record<string, unknown> }
interface Task { id: string; evaluation_criteria: { actions: Action[] | null } }

const ctx = benchContext();
let bridge: Tau2Bridge;
let site: Tau2Site;
let tasks: Task[] = [];

beforeAll(async () => {
  const dir = await fetchTau2(ctx);
  tasks = JSON.parse(readFileSync(join(dir, "data/tau2/domains/retail/tasks.json"), "utf8"));
  bridge = await startBridge(ctx, "retail");
  site = await startRetailSite(bridge, readFileSync(join(dir, "data/tau2/domains/retail/policy.md"), "utf8"));
}, 600_000);
afterAll(async () => {
  await site?.close();
  await bridge?.close();
});

const get = (path: string) => fetch(site.origin + path);
const post = (path: string, form: Record<string, string>) => fetch(site.origin + path, { method: "POST", body: new URLSearchParams(form) });
const order = (id: unknown) => `/orders/${encodeURIComponent(String(id))}`;

/** Ticks the order rows for `itemIds` (a duplicate id takes the next row) and fills each row's new item. */
async function rows(orderId: unknown, itemIds: string[], newIds?: string[]): Promise<Record<string, string>[]> {
  const html = await (await get(order(orderId))).text();
  const all = [...html.matchAll(/name="pick" value="(\d+)" data-item="(\d+)"/g)].map((m) => ({ row: m[1]!, item: m[2]! }));
  const used = new Set<string>();
  return itemIds.map((id, i) => {
    const row = all.find((r) => r.item === id && !used.has(r.row))!.row;
    used.add(row);
    return { pick: row, ...(newIds ? { [`new_${row}`]: newIds[i]! } : {}) };
  });
}
const form = (parts: Record<string, string>[], extra: Record<string, string>) => {
  const body = new URLSearchParams(extra);
  for (const p of parts) for (const [k, v] of Object.entries(p)) body.append(k, v);
  return body;
};

/** The scripted perfect agent: one gold action, done through the pages. */
async function act(a: Action): Promise<Response> {
  const g = a.arguments as Record<string, string> & { item_ids: string[]; new_item_ids: string[] };
  switch (a.name) {
    case "find_user_id_by_email": return get(`/find?email=${encodeURIComponent(g.email)}`);
    case "find_user_id_by_name_zip": return get(`/find?${new URLSearchParams({ first_name: g.first_name, last_name: g.last_name, zip: g.zip })}`);
    case "get_user_details": return get(`/users/${encodeURIComponent(g.user_id)}`);
    case "get_order_details": return get(order(g.order_id));
    case "get_product_details": return get(`/products/${g.product_id}`);
    case "get_item_details": return get(`/items/${g.item_id}`);
    case "list_all_product_types": return get("/products");
    case "calculate": return get(`/calculator?expression=${encodeURIComponent(g.expression)}`);
    case "cancel_pending_order": return post(`${order(g.order_id)}/cancel`, { reason: g.reason });
    case "modify_pending_order_address":
    case "modify_user_address": {
      const { order_id, user_id, ...address } = g;
      return post(a.name === "modify_user_address" ? `/users/${encodeURIComponent(user_id)}/address` : `${order(order_id)}/address`, address);
    }
    case "modify_pending_order_payment": return post(`${order(g.order_id)}/payment`, { payment_method_id: g.payment_method_id });
    case "transfer_to_human_agents": return post("/transfer", { summary: g.summary });
    case "return_delivered_order_items":
      return fetch(`${site.origin}${order(g.order_id)}/return`, { method: "POST", body: form(await rows(g.order_id, g.item_ids), { payment_method_id: g.payment_method_id }) });
    case "modify_pending_order_items":
    case "exchange_delivered_order_items":
      return fetch(`${site.origin}${order(g.order_id)}/${a.name === "exchange_delivered_order_items" ? "exchange" : "items"}`,
        { method: "POST", body: form(await rows(g.order_id, g.item_ids, g.new_item_ids), { payment_method_id: g.payment_method_id }) });
    default: throw new Error(`no page for ${a.name}`);
  }
}

/** Item lists as sorted (old, new) pairs: the form lists rows in order, and tau2's checks match by pair. */
const norm = (args: Record<string, unknown>) => {
  const { item_ids, new_item_ids, ...rest } = args as { item_ids?: string[]; new_item_ids?: string[] };
  if (!item_ids) return args;
  return { ...rest, pairs: item_ids.map((id, i) => `${id}>${new_item_ids?.[i] ?? ""}`).sort() };
};

describe("tau2 retail site", () => {
  it("T1 the cache is the pinned commit, with only the needed paths", () => {
    expect(TAU2_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("git", ["-C", tau2Dir(ctx), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(TAU2_REF);
    expect(execFileSync("git", ["-C", tau2Dir(ctx), "ls-files", "data/tau2/domains/telecom"], { encoding: "utf8" })).toBe("");
  });

  it("T2 the gold actions through the pages make the gold write calls, for all 114 tasks", async () => {
    expect(tasks).toHaveLength(114);
    const mismatched: string[] = [];
    for (const task of tasks) {
      await site.reset();
      const gold = task.evaluation_criteria.actions ?? [];
      for (const a of gold) await act(a);
      const writes = site.calls.filter((c) => RETAIL_WRITES.has(c.name));
      const want = gold.filter((a) => RETAIL_WRITES.has(a.name)).map((a) => ({ name: a.name, arguments: norm(a.arguments), error: false }));
      const got = writes.map((c) => ({ name: c.name, arguments: norm(c.arguments), error: c.error }));
      try {
        expect(got).toEqual(want);
      } catch {
        mismatched.push(`${task.id}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
    }
    expect(mismatched).toEqual([]);
  }, 600_000);

  it("T3 each page view is one read call", async () => {
    await site.reset();
    for (const path of ["/", "/products", "/products/1656367028", "/users/yusuf_rossi_9620", order("#W2378156"), "/find?email=nobody%40example.com", "/policy", "/transfer"]) {
      const before = site.calls.length;
      expect((await get(path)).status).toBeLessThan(500);
      expect(site.calls.slice(before).every((c) => !RETAIL_WRITES.has(c.name))).toBe(true);
      expect(site.calls.length - before).toBeLessThanOrEqual(1);
    }
    expect(site.calls.map((c) => c.name)).toEqual(["list_all_product_types", "get_product_details", "get_user_details", "get_order_details", "find_user_id_by_email"]);
  });

  it("T4 a wrong form shows tau2's error and changes nothing", async () => {
    await site.reset();
    const res = await post(`${order("#W2378156")}/cancel`, { reason: "no longer needed" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Non-pending order cannot be cancelled");
    expect(site.calls.at(-1)).toMatchObject({ name: "cancel_pending_order", error: true });
    expect(await (await get(order("#W2378156"))).text()).toMatch(/delivered/);
  });

  it("T5 a reset gives the start database back and clears the calls", async () => {
    await site.reset();
    const pending = "#W5918442";
    expect((await post(`${order(pending)}/cancel`, { reason: "ordered by mistake" })).status).toBe(200);
    expect(await (await get(order(pending))).text()).toMatch(/cancelled/);
    await site.reset();
    expect(site.calls).toEqual([]);
    expect(await (await get(order(pending))).text()).not.toMatch(/cancelled/);
  });

  it("T6 the customer page links to each order with the # encoded", async () => {
    await site.reset();
    const html = await (await get("/users/yusuf_rossi_9620")).text();
    expect(html).toContain('href="/orders/%23W2378156"');
    expect((await get("/orders/%23W2378156")).status).toBe(200);
  });

  it("T8 database text is escaped", async () => {
    await site.reset();
    const res = await get(`/find?email=${encodeURIComponent("<script>x</script>@example.com")}`);
    expect(await res.text()).not.toContain("<script>x</script>");
  });

  it("T7 a dead bridge fails each call at once, and the page answers 502", async () => {
    const dead = await startBridge(ctx, "retail");
    const dying = await startRetailSite(dead, "policy");
    try {
      await dead.close();
      const started = Date.now();
      expect((await fetch(`${dying.origin}/products`)).status).toBe(502);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await dying.close();
    }
  }, 120_000);
});
