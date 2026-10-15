// The shop pages, over ARE's Shopping app: products with search and paging, a
// product with its variants, the cart, checkout with a discount code, orders
// with cancel, and the discount codes.
import { done, esc, form, input, next, type Handler } from "./pages.js";

const LIMIT = 10;
interface Item { item_id: string; price: number; available: boolean; options: Record<string, unknown>; quantity?: number }
const options = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(", ");
const nav = `<p><a href="/shop">Products</a> · <a href="/shop/cart">Cart</a> · <a href="/shop/orders">Orders</a> · <a href="/shop/discounts">Discount codes</a></p>`;
const page = (title: string, body: string) => ({ title, body: nav + body });
/** A cart or order line, with its remove form when `remove` names the form's path. */
const line = (i: Item, remove = "") => `<li>${esc(i.item_id)}: ${i.quantity ?? 1} x ${i.price}${i.available ? "" : " (not available)"} ${options(i.options)}${remove ? form(remove, "Remove", `<input type="hidden" name="item_id" value="${esc(i.item_id)}">${input("quantity", "quantity", 1)}`) : ""}</li>`;

export const shopping: Handler = async (api, { path, query, form: posted }) => {
  if (path === "/shop") {
    const [q, offset] = [query.get("q"), Number(query.get("offset") ?? 0)];
    const found = q ? await api.call("Shopping", "search_product", { product_name: q, offset, limit: LIMIT }) : await api.call("Shopping", "list_all_products", { offset, limit: LIMIT });
    const products: [string, string][] = Array.isArray(found) ? found.map((p: { name: string; product_id: string }) => [p.name, p.product_id]) : Object.entries(found.products ?? found);
    return page("Products", `<form>${input("q", "Search", q)}<button>Search</button></form><ul>${products.map(([name, id]) => `<li><a href="/shop/products/${esc(id)}">${esc(name)}</a></li>`).join("")}</ul>${found.metadata ? next(path, query, offset, products.length, found.metadata.total) : products.length === LIMIT ? next(path, query, offset, LIMIT, offset + LIMIT + 1) : ""}`);
  }
  const m = /^\/shop\/(products|orders)\/(\w+)(\/cancel)?$/.exec(path);
  if (m?.[1] === "products") {
    const p = await api.call("Shopping", "get_product_details", { product_id: m[2] });
    const variants: Item[] = Object.values(p.variants);
    return page(p.name, `<ul>${variants.map((v) => line(v) + form("/shop/cart/add", "Add to cart", `<input type="hidden" name="item_id" value="${esc(v.item_id)}">${input("quantity", "quantity", 1)}`)).join("")}</ul>`);
  }
  if (m?.[1] === "orders") {
    if (posted && m[3]) return done(await api.call("Shopping", "cancel_order", { order_id: m[2] }));
    const o = await api.call("Shopping", "get_order_details", { order_id: m[2] });
    return page(`Order ${o.order_id}`, `<p>${esc(o.order_status)}, total ${o.order_total}</p><ul>${(Object.values(o.order_items) as Item[]).map((i) => line(i)).join("")}</ul>${form(`${path}/cancel`, "Cancel order", "")}`);
  }
  if (path === "/shop/cart/add" && posted) return done(await api.call("Shopping", "add_to_cart", { item_id: posted.get("item_id"), quantity: posted.get("quantity") }));
  if (path === "/shop/cart/remove" && posted) return done(await api.call("Shopping", "remove_from_cart", { item_id: posted.get("item_id"), quantity: posted.get("quantity") }));
  if (path === "/shop/cart/checkout" && posted) return done(await api.call("Shopping", "checkout", { discount_code: posted.get("discount_code") }));
  if (path === "/shop/cart") {
    const cart: Record<string, Item> = await api.call("Shopping", "list_cart");
    return page("Cart", `<ul>${Object.values(cart).map((i) => line(i, "/shop/cart/remove")).join("")}</ul>${form("/shop/cart/checkout", "Checkout", input("discount_code", "Discount code"))}`);
  }
  if (path === "/shop/orders") {
    const orders: Record<string, { order_id: string; order_status: string; order_total: number }> = await api.call("Shopping", "list_orders");
    return page("Orders", `<ul>${Object.values(orders).map((o) => `<li><a href="/shop/orders/${esc(o.order_id)}">${esc(o.order_id)}</a> ${esc(o.order_status)}, total ${o.order_total}</li>`).join("")}</ul>`);
  }
  if (path === "/shop/discounts") return page("Discount codes", `<pre>${esc(JSON.stringify(await api.call("Shopping", "get_all_discount_codes"), null, 1))}</pre>`);
  return null;
};
