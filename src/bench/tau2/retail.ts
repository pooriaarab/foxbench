// tau2 retail as a web site: the support desk of an online shop. Each page
// view and each form is one call of a tau2 retail tool, run by tau2 through
// the bridge; the page shows what the tool returned, or tau2's error. The
// site records every call, in order, for tau2's evaluator.
import type { IncomingMessage } from "node:http";
import { serveCase } from "../serve.js";
import type { Tau2Bridge } from "./bridge.js";

/** The retail tools that change the database (tau2's ToolType.WRITE). */
export const RETAIL_WRITES = new Set(["cancel_pending_order", "exchange_delivered_order_items", "modify_pending_order_address", "modify_pending_order_items",
  "modify_pending_order_payment", "modify_user_address", "return_delivered_order_items"]);

export interface Tau2Call { name: string; arguments: Record<string, unknown>; content: string; error: boolean }

export interface Tau2Site {
  origin: string;
  /** Every tool call the pages made since the last reset, in order. */
  calls: Tau2Call[];
  /** A fresh tau2 environment and no calls (T5). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ADDRESS = ["address1", "address2", "city", "state", "country", "zip"];

/** Any tool result as nested lists. Order, user and product ids become links (T6). */
function show(value: unknown, key = ""): string {
  if (Array.isArray(value)) return `<ul>${value.map((v) => `<li>${show(v, key)}</li>`).join("")}</ul>`;
  if (value && typeof value === "object") return `<dl>${Object.entries(value).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${show(v, k)}</dd>`).join("")}</dl>`;
  const text = String(value);
  if (/^#W\d+$/.test(text)) return `<a href="/orders/${encodeURIComponent(text)}">${esc(text)}</a>`;
  if (key === "product_id" || (key === "" && /^\d{10}$/.test(text))) return `<a href="/products/${esc(text)}">${esc(text)}</a>`;
  if (key === "user_id") return `<a href="/users/${encodeURIComponent(text)}">${esc(text)}</a>`;
  return esc(text);
}
const parse = (content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
};

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Support desk</title></head>
<body><header><a href="/">Support desk</a> · <a href="/products">Products</a> · <a href="/policy">Policy</a> · <a href="/calculator">Calculator</a> · <a href="/transfer">Transfer to a human</a></header>
<main><h1>${esc(title)}</h1>${body}</main></body></html>`;
const field = (name: string, label = name) => `<p><label>${esc(label)} <input name="${name}"></label></p>`;
const formOf = (action: string, title: string, inner: string) => `<form method="post" action="${esc(action)}"><h2>${esc(title)}</h2>${inner}<p><button type="submit">${esc(title)}</button></p></form>`;

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

export async function startRetailSite(bridge: Tau2Bridge, policy: string): Promise<Tau2Site> {
  const calls: Tau2Call[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await bridge.call(name, args);
    calls.push({ name, arguments: args, ...reply });
    return reply;
  };
  /** The page for one read: the tool's result, or its error with 400. */
  const read = async (title: string, name: string, args: Record<string, unknown>, more: (value: unknown) => string = () => "") => {
    const reply = await call(name, args);
    if (reply.error) return { status: 400, html: page(title, `<p role="alert">${esc(reply.content)}</p>`) };
    const value = parse(reply.content);
    return { status: 200, html: page(title, show(value) + more(value)) };
  };

  async function handle(req: IncomingMessage, body: string, url: URL): Promise<{ status: number; html: string }> {
    const path = url.pathname;
    const q = (name: string) => url.searchParams.get(name) ?? "";
    if (req.method === "POST") {
      const write = writeCall(path, new URLSearchParams(body));
      if (!write) return { status: 404, html: page("Not found", "") };
      const reply = await call(write.name, write.args);
      return reply.error
        ? { status: 400, html: page("Not done", `<p role="alert">${esc(reply.content)}</p>`) }
        : { status: 200, html: page("Done", show(parse(reply.content))) };
    }
    if (path === "/") {
      return { status: 200, html: page("Find a customer", `<form action="/find">${field("email", "Email")}<p><button>Find by email</button></p></form>
<form action="/find">${field("first_name", "First name")}${field("last_name", "Last name")}${field("zip", "Zip code")}<p><button>Find by name and zip</button></p></form>`) };
    }
    if (path === "/find") {
      return q("email")
        ? read("Customer", "find_user_id_by_email", { email: q("email") }, (id) => `<p><a href="/users/${encodeURIComponent(String(id))}">Open the customer</a></p>`)
        : read("Customer", "find_user_id_by_name_zip", { first_name: q("first_name"), last_name: q("last_name"), zip: q("zip") }, (id) => `<p><a href="/users/${encodeURIComponent(String(id))}">Open the customer</a></p>`);
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/users\/([^/]+)$/.exec(path))) {
      return read("Customer", "get_user_details", { user_id: decodeURIComponent(m[1]!) }, () => formOf(`${path}/address`, "Change the customer's address", ADDRESS.map((f) => field(f)).join("")));
    }
    if ((m = /^\/orders\/([^/]+)$/.exec(path))) return read("Order", "get_order_details", { order_id: decodeURIComponent(m[1]!) }, (o) => orderForms(path, o as Parameters<typeof orderForms>[1]));
    if (path === "/products") return read("Products", "list_all_product_types", {});
    if ((m = /^\/products\/(\w+)$/.exec(path))) return read("Product", "get_product_details", { product_id: m[1]! });
    if ((m = /^\/items\/(\w+)$/.exec(path))) return read("Item", "get_item_details", { item_id: m[1]! });
    if (path === "/calculator") {
      return q("expression") ? read("Calculator", "calculate", { expression: q("expression") }) : { status: 200, html: page("Calculator", `<form>${field("expression", "Expression")}<p><button>Calculate</button></p></form>`) };
    }
    if (path === "/policy") return { status: 200, html: page("Policy", `<pre>${esc(policy)}</pre>`) };
    if (path === "/transfer") return { status: 200, html: page("Transfer to a human", formOf("/transfer", "Transfer", `<p><label>Summary <textarea name="summary"></textarea></label></p>`)) };
    return { status: 404, html: page("Not found", "") };
  }

  const site = await serveCase(async (req, body, url) => {
    try {
      const { status, html } = await handle(req, body, url);
      return { status, body: html };
    } catch (error) {
      // A dead bridge is a harness fault, never a tool error (T7).
      return { status: 502, type: "text/plain", body: error instanceof Error ? error.message : String(error) };
    }
  });
  return {
    origin: site.url,
    calls,
    reset: async () => { calls.length = 0; await bridge.reset(); },
    close: site.close,
  };
}
