// tau2 retail as a web site: the support desk of an online shop. Each page
// view and each form is one call of a tau2 retail tool, run by tau2 through
// the bridge (desk.ts); the page shows what the tool returned, or tau2's error.
import type { Tau2Bridge } from "./bridge.js";
import { commonPage, esc, field, formOf, startDesk, type Tau2Site } from "./desk.js";

/** The retail tools that change the database (tau2's ToolType.WRITE). */
export const RETAIL_WRITES = new Set(["cancel_pending_order", "exchange_delivered_order_items", "modify_pending_order_address", "modify_pending_order_items",
  "modify_pending_order_payment", "modify_user_address", "return_delivered_order_items"]);

const open = (id: unknown) => `<p><a href="/users/${encodeURIComponent(String(id))}">Open the customer</a></p>`;
const ADDRESS = ["address1", "address2", "city", "state", "country", "zip"];

/** Order, user and product ids become links (T6). */
function link(text: string, key: string): string | null {
  if (/^#W\d+$/.test(text)) return `/orders/${encodeURIComponent(text)}`;
  if (key === "product_id" || (key === "" && /^\d{10}$/.test(text))) return `/products/${text}`;
  if (key === "user_id") return `/users/${encodeURIComponent(text)}`;
  return null;
}

/** The order's item rows, each with a tick box and, for changes, the new item id. */
const itemRows = (items: { item_id: string; name: string }[], withNew: boolean) => `<table>${items.map((it, i) =>
  `<tr><td><input type="checkbox" name="pick" value="${i}" data-item="${esc(it.item_id)}" id="pick${i}"><input type="hidden" name="item_${i}" value="${esc(it.item_id)}"></td><td><label for="pick${i}">${esc(it.name)} ${esc(it.item_id)}</label></td>${withNew ? `<td><label>New item id <input name="new_${i}"></label></td>` : ""}</tr>`).join("")}</table>`;

function orderForms(path: string, order: { status?: string; items?: { item_id: string; name: string }[] }): string {
  const items = order.items ?? [];
  const pay = field("payment_method_id", "Payment method id");
  if (order.status === "pending") {
    return formOf(`${path}/cancel`, "Cancel order", `<p><label>Reason <select name="reason"><option>no longer needed</option><option>ordered by mistake</option></select></label></p>`)
      + formOf(`${path}/address`, "Change shipping address", ADDRESS.map((f) => field(f)).join(""))
      + formOf(`${path}/payment`, "Change payment method", pay)
      + formOf(`${path}/items`, "Change items", itemRows(items, true) + pay);
  }
  if (order.status === "delivered") return formOf(`${path}/return`, "Return items", itemRows(items, false) + pay) + formOf(`${path}/exchange`, "Exchange items", itemRows(items, true) + pay);
  return "";
}

/** The tool call and its arguments for a form post, or null for an unknown form. */
function writeCall(path: string, form: URLSearchParams): { name: string; args: Record<string, unknown> } | null {
  const pick = (fields: string[]) => Object.fromEntries(fields.map((f) => [f, form.get(f) ?? ""]));
  const user = /^\/users\/([^/]+)\/address$/.exec(path);
  if (user) return { name: "modify_user_address", args: { user_id: decodeURIComponent(user[1]!), ...pick(ADDRESS) } };
  if (path === "/transfer") return { name: "transfer_to_human_agents", args: pick(["summary"]) };
  const m = /^\/orders\/([^/]+)\/(\w+)$/.exec(path);
  if (!m) return null;
  const order_id = decodeURIComponent(m[1]!);
  // Ticked rows in row order; each row's new item id goes with it (T2).
  const rows = form.getAll("pick").map(Number).toSorted((a, b) => a - b);
  const items = () => ({ item_ids: rows.map((r) => form.get(`item_${r}`) ?? ""), new_item_ids: rows.map((r) => form.get(`new_${r}`) ?? "") });
  switch (m[2]) {
    case "cancel": return { name: "cancel_pending_order", args: { order_id, ...pick(["reason"]) } };
    case "address": return { name: "modify_pending_order_address", args: { order_id, ...pick(ADDRESS) } };
    case "payment": return { name: "modify_pending_order_payment", args: { order_id, ...pick(["payment_method_id"]) } };
    case "items": return { name: "modify_pending_order_items", args: { order_id, ...items(), ...pick(["payment_method_id"]) } };
    case "exchange": return { name: "exchange_delivered_order_items", args: { order_id, ...items(), ...pick(["payment_method_id"]) } };
    case "return": return { name: "return_delivered_order_items", args: { order_id, item_ids: items().item_ids, ...pick(["payment_method_id"]) } };
    default: return null;
  }
}

export const startRetailSite = (bridge: Tau2Bridge, policy: string): Promise<Tau2Site> => startDesk(bridge, { nav: '<a href="/products">Products</a>', link }, async (desk, req, body, url) => {
  const path = url.pathname;
  const q = (name: string) => url.searchParams.get(name) ?? "";
  if (req.method === "POST") {
    const write = writeCall(path, new URLSearchParams(body));
    return write ? desk.write(write.name, write.args) : { status: 404, html: desk.page("Not found", "") };
  }
  if (path === "/") {
    return { status: 200, html: desk.page("Find a customer", `<form action="/find">${field("email", "Email")}<p><button>Find by email</button></p></form>
<form action="/find">${field("first_name", "First name")}${field("last_name", "Last name")}${field("zip", "Zip code")}<p><button>Find by name and zip</button></p></form>`) };
  }
  if (path === "/find") {
    return q("email") ? desk.read("Customer", "find_user_id_by_email", { email: q("email") }, open)
      : desk.read("Customer", "find_user_id_by_name_zip", { first_name: q("first_name"), last_name: q("last_name"), zip: q("zip") }, open);
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/users\/([^/]+)$/.exec(path))) {
    return desk.read("Customer", "get_user_details", { user_id: decodeURIComponent(m[1]!) }, () => formOf(`${path}/address`, "Change the customer's address", ADDRESS.map((f) => field(f)).join("")));
  }
  if ((m = /^\/orders\/([^/]+)$/.exec(path))) return desk.read("Order", "get_order_details", { order_id: decodeURIComponent(m[1]!) }, (o) => orderForms(path, o as Parameters<typeof orderForms>[1]));
  if (path === "/products") return desk.read("Products", "list_all_product_types", {});
  if ((m = /^\/products\/(\w+)$/.exec(path))) return desk.read("Product", "get_product_details", { product_id: m[1]! });
  if ((m = /^\/items\/(\w+)$/.exec(path))) return desk.read("Item", "get_item_details", { item_id: m[1]! });
  return commonPage(desk, path, q, policy) ?? { status: 404, html: desk.page("Not found", "") };
});
