// WebMall's scorer, ported to read end state instead of the agent's page: the answer's URLs, the
// carts and orders (the control plugin), and the pages visited (the proxy's trace). Upstream's
// weights hold: answers share 0.8, visits (and, for a checkout, carts) 0.2. Success is the exact
// match: every answer right and nothing wrong in the answer, the carts or the orders.
import type { TraceEntry } from "../types.js";
import type { WebmallTask } from "./tasks.js";

export interface ShopState {
  carts: string[];
  orders: { billing: Record<string, string>; items: string[] }[];
}

const norm = (url: string) => url.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();

// Upstream's pattern: a URL with an optional scheme, a host (localhost, an IPv4 address or a domain), a port and a path.
const URL_RE = /\b(?:https?:\/\/)?(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{2,5})?(?:\/\S*)?\b/gi;

/** The distinct URLs of an answer. `###` separates offers; it becomes a line break first, as upstream does. */
export const submittedUrls = (answer: string): string[] => [...new Set([...answer.replaceAll("###", "\n").matchAll(URL_RE)].map((m) => norm(m[0])))];

function billingOk(billing: Record<string, string>, user: NonNullable<WebmallTask["user"]>): boolean {
  const text = ["first_name", "last_name", "address_1", "address_2", "city", "state", "postcode"].map((k) => billing[k] ?? "").join(" ").toLowerCase();
  const has = (value: string) => text.includes(value.trim().toLowerCase());
  const country = (billing.country ?? "").toLowerCase();
  return [user.name, user.street, user.house_number, user.zip, user.state].every(has) && [user.country.toLowerCase(), "us", "usa", "united states"].includes(country)
    && (billing.email ?? "").toLowerCase() === user.email.toLowerCase();
}

/** `visited` holds the normalized URLs of the product pages the agent loaded. */
export function scoreTask(task: WebmallTask, answer: string, state: ShopState, visited: Set<string>): { success: boolean; score: number; reasons: string[] } {
  const gold = task.answers.map(norm);
  const wrong: string[] = [];
  let matched: boolean[];
  if (task.type === "string") {
    const got = submittedUrls(answer);
    matched = gold.map((g) => got.includes(g));
    wrong.push(...got.filter((u) => !gold.includes(u)));
  } else if (task.type === "cart") {
    const carts = state.carts.map(norm);
    matched = gold.map((g) => carts.includes(g));
    wrong.push(...carts.filter((u) => !gold.includes(u)));
  } else {
    const orders = state.orders.map((o) => ({ items: o.items.map(norm), ok: billingOk(o.billing, task.user!) }));
    matched = gold.map((g) => orders.some((o) => o.ok && o.items.includes(g)));
    wrong.push(...orders.flatMap((o) => o.items).filter((u) => !gold.includes(u)));
  }
  // The visits, and for a checkout the carts: a product that was ordered was in the cart.
  const extra = gold.map((g) => visited.has(g));
  const carted = task.type === "checkout" ? gold.map((g) => state.carts.map(norm).includes(g) || state.orders.some((o) => o.items.map(norm).includes(g))) : [];
  const secondary = [...extra, ...carted];
  const score = 0.8 * (matched.filter(Boolean).length / gold.length) + 0.2 * (secondary.filter(Boolean).length / secondary.length);
  const reasons = [...gold.filter((_, i) => !matched[i]).map((g) => `missing ${g}`), ...wrong.map((u) => `wrong ${u}`)];
  return { success: matched.every(Boolean) && !wrong.length, score: Math.round(score * 1e6) / 1e6, reasons };
}

/** The product pages a trace loaded, as shop port + path: the key is the URL the gold answers use. */
export const visitedPages = (traces: { origin: string; requests: TraceEntry[] }[]): Set<string> =>
  new Set(traces.flatMap((t) => t.requests.filter((r) => r.method === "GET" && r.status < 400).map((r) => norm(t.origin + r.path))));
