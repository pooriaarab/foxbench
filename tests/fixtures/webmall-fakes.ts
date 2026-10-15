// A fake WebMall for tests/webmall.test.ts: four shops that keep a cart and orders, answer the
// control plugin's routes, and redirect to another origin on a wrong Host (as WordPress does),
// plus a scripted agent that does a task through the proxy URLs, as real HTTP.
import { createServer, type Server } from "node:http";
import { webmallSites } from "../../src/bench/webmall/env.js";
import type { Adapter } from "../../src/adapter.js";
import type { WebmallTask } from "../../src/bench/webmall/tasks.js";

const origin = (url: string) => new URL(url).origin;
const slugOf = (url: string) => new URL(url).pathname.split("/").filter(Boolean).pop()!;
export type Order = { billing: Record<string, string>; items: string[] };

/** The four shops on port + offset. Each keeps its own cart and orders; `resets` counts the control resets. */
export async function fakeShops(offset: number, key: string) {
  const shops = new Map(webmallSites.map((s) => [s.port, { carts: [] as string[], orders: [] as Order[] }]));
  const servers: Server[] = [];
  const fake = { resets: 0, shop: (port: number) => shops.get(port)!, close: () => Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))) };
  for (const site of webmallSites.slice(0, 4)) {
    const state = shops.get(site.port)!;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const body: Buffer[] = [];
      req.on("data", (c: Buffer) => body.push(c)).on("end", () => {
        if (req.headers.host !== `127.0.0.1:${site.port}`) return void res.writeHead(301, { location: `http://localhost:${site.port}${url.pathname}` }).end();
        const add = url.searchParams.get("add-to-cart");
        if (url.pathname.startsWith("/wp-json/foxbench/")) {
          if (req.headers["x-foxbench-key"] !== key) return void res.writeHead(401).end("{}");
          if (url.pathname.endsWith("/reset")) { state.carts = []; state.orders = []; fake.resets++; }
          return void res.end(JSON.stringify(url.pathname.endsWith("/reset") ? { ok: true } : state));
        }
        if (url.pathname === "/wp-json/wc/store/v1/products") return void res.end(JSON.stringify([{ id: url.searchParams.get("slug") ?? "an-unlisted-product" }]));
        if (url.pathname === "/checkout/") return void res.end('<input name="woocommerce-process-checkout-nonce" value="nonce1">');
        if (url.searchParams.has("wc-ajax")) {
          const billing = Object.fromEntries([...new URLSearchParams(Buffer.concat(body).toString())].filter(([k]) => k.startsWith("billing_")).map(([k, v]) => [k.slice(8), v]));
          state.orders.push({ billing, items: state.carts });
          state.carts = [];
          return void res.end('{"result":"success"}');
        }
        if (add) state.carts.push(`http://127.0.0.1:${site.port}/product/${add}/`);
        res.writeHead(url.pathname.startsWith("/product/") || url.pathname === "/" ? 200 : 404).end("<title>shop</title>");
      });
    });
    servers.push(server);
    await new Promise<void>((r, reject) => server.once("error", reject).listen(site.port + offset, "127.0.0.1", r));
  }
  return fake;
}

export const at = (url: string, init?: RequestInit) => fetch(url, { redirect: "manual", ...init });
const plain = at;

/** Does a task the way a person would, through the URLs the agent was given. `wrong` adds an off-list product and bad billing. */
export async function doTask(task: WebmallTask, opts: { wrong?: boolean; cartOnly?: boolean } = {}): Promise<string> {
  // A browser's cookies: WooCommerce keeps the cart in a session cookie.
  const jar = new Map<string, string>();
  const go = async (url: string, init: RequestInit = {}) => {
    const res = await plain(url, { ...init, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of res.headers.getSetCookie()) jar.set(c.split("=")[0]!, c.split(";")[0]!.slice(c.indexOf("=") + 1));
    return res;
  };
  if (task.type === "string") return [...task.answers, ...(opts.wrong ? ["http://127.0.0.1:8081/product/not-a-product/"] : [])].map((a, i) => `Offer${i + 1}: ${a}`).join("###");
  for (const gold of task.answers) {
    await go(gold);
    const id = ((await (await go(`${origin(gold)}/wp-json/wc/store/v1/products?slug=${slugOf(gold)}`)).json()) as { id: string }[])[0]!.id;
    await go(`${origin(gold)}/?add-to-cart=${id}`);
  }
  if (opts.wrong) {
    const shop = origin(task.answers[0]!);
    await go(`${shop}/?add-to-cart=${((await (await go(`${shop}/wp-json/wc/store/v1/products?per_page=1`)).json()) as { id: string }[])[0]!.id}`);
  }
  for (const shop of task.type === "checkout" && !opts.cartOnly ? [...new Set(task.answers.map(origin))] : []) {
    const nonce = /name="woocommerce-process-checkout-nonce" value="(\w+)"/.exec(await (await go(`${shop}/checkout/`)).text())![1]!;
    const user = task.user!;
    const [first, ...last] = user.name.split(" ");
    await go(`${shop}/?wc-ajax=checkout`, { method: "POST", body: new URLSearchParams({
      billing_first_name: first!, billing_last_name: last.join(" "), billing_country: "US", billing_address_1: `${user.house_number} ${user.street}`, billing_city: user.city,
      billing_state: opts.wrong ? "TX" : user.state, billing_postcode: user.zip, billing_email: user.email, payment_method: "mock_card", mcc_name: user.name, mcc_number: "4242424242424242", mcc_expiry: "12/28", mcc_cvc: "123", terms: "on", "woocommerce-process-checkout-nonce": nonce }) });
  }
  return "Done";
}

/** An agent that does what `act` makes of the task whose goal it was given, and answers with the result. */
export const scripted = (tasks: WebmallTask[], name: string, act: (t: WebmallTask) => Promise<string>): Adapter => ({
  name, runTask: async ({ goal }) => ({ done: true, log: "", answer: await act(tasks.find((t) => t.goal === goal)!) }),
});
