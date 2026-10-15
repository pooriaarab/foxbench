// The scripted perfect agent of the tau2 tests: it does a task's gold
// actions through the support desk's pages, as a browser agent would.
export interface Action { name: string; arguments: Record<string, unknown> }
type Args = Record<"email" | "first_name" | "last_name" | "zip" | "user_id" | "order_id" | "product_id" | "item_id" | "expression" | "reason" | "payment_method_id" | "summary", string> & { item_ids: string[]; new_item_ids: string[] };
const order = (id: unknown) => `/orders/${encodeURIComponent(String(id))}`;

/** Ticks the order rows for `itemIds` (a duplicate id takes the next row) and fills each row's new item. */
async function rows(origin: string, orderId: unknown, itemIds: string[], newIds?: string[]): Promise<Record<string, string>[]> {
  const html = await (await fetch(origin + order(orderId))).text();
  const all = [...html.matchAll(/name="pick" value="(\d+)" data-item="(\d+)"/g)].map((m) => ({ row: m[1]!, item: m[2]! }));
  const used = new Set<string>();
  return itemIds.map((id, i) => {
    const row = all.find((r) => r.item === id && !used.has(r.row))!.row;
    used.add(row);
    return { pick: row, [`item_${row}`]: id, ...(newIds ? { [`new_${row}`]: newIds[i]! } : {}) };
  });
}
const form = (parts: Record<string, string>[], extra: Record<string, string>) => {
  const body = new URLSearchParams(extra);
  for (const p of parts) for (const [k, v] of Object.entries(p)) body.append(k, v);
  return body;
};

/** One gold action, done through the pages of the site at `origin`. */
export async function goldStep(origin: string, a: Action): Promise<Response> {
  const get = (path: string) => fetch(origin + path);
  const post = (path: string, f: Record<string, string>) => fetch(origin + path, { method: "POST", body: new URLSearchParams(f) });
  const g = a.arguments as Args;
  const s = (k: keyof Args) => String(g[k]);
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
      const address = Object.fromEntries(["address1", "address2", "city", "state", "country", "zip"].map((k) => [k, s(k as keyof Args)]));
      return post(a.name === "modify_user_address" ? `/users/${encodeURIComponent(g.user_id)}/address` : `${order(g.order_id)}/address`, address);
    }
    case "modify_pending_order_payment": return post(`${order(g.order_id)}/payment`, { payment_method_id: g.payment_method_id });
    case "transfer_to_human_agents": return post("/transfer", { summary: s("summary") });
    case "return_delivered_order_items":
      return fetch(`${origin}${order(g.order_id)}/return`, { method: "POST", body: form(await rows(origin, g.order_id, g.item_ids), { payment_method_id: s("payment_method_id") }) });
    case "modify_pending_order_items":
    case "exchange_delivered_order_items":
      return fetch(`${origin}${order(g.order_id)}/${a.name === "exchange_delivered_order_items" ? "exchange" : "items"}`,
        { method: "POST", body: form(await rows(origin, g.order_id, g.item_ids, g.new_item_ids), { payment_method_id: s("payment_method_id") }) });
    default: throw new Error(`no page for ${a.name}`);
  }
}
