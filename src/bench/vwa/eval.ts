// VisualWebArena's evaluators beyond WebArena's (wa/eval.ts), ported from
// evaluation_harness/evaluators.py and helper_functions.py at 89f5af2 (MIT):
// the helpers its tasks call, and page_image_query. Upstream answers a
// page_image_query with BLIP-2 captions and an SSIM image match; here the
// Claude judge looks at the page's images instead, so those cases are
// `judge: llm` and the board names the judge model (a different column from
// upstream's). The local judge takes no images.
import type { JudgeImage } from "../judge.js";
import { callFunc, scoreWa, type Run, type WaFacts, type WaPage, type WaScore, type WaTask } from "../wa/eval.js";
import { shoppingRest } from "../wa/shopping.js";

/** One page_image_query of a task: a page, the images in it (a CSS class, or all of them), and what must hold. */
interface ImageQuery {
  eval_image_url: string;
  eval_image_class: string;
  eval_vqa?: { question: string; answer: string }[];
  eval_fuzzy_image_match?: string;
}
export interface VwaTask extends WaTask {
  eval: WaTask["eval"] & { page_image_query?: ImageQuery[] };
}

/** The most images one judge call gets. */
const MAX_IMAGES = 20;

const q = (s: string) => JSON.stringify(s);
const attempt = async <T>(f: () => Promise<T>, fallback: T) => { try { return await f(); } catch { return fallback; } };
const inPage = (page: WaPage, js: string) => page.evaluate(`(() => { try { ${js} } catch (e) { return null; } })()`);

/** What each product row of an order page holds, as upstream's shopping_get_all_product_order reads it. */
async function orderProducts(page: WaPage): Promise<{ name: string; sku: string; qty: string; options?: Record<string, string> }[]> {
  const rows = await inPage(page, `return [...document.querySelector("#my-orders-table").getElementsByTagName('tbody')].map((x) => [...x.getElementsByTagName('td')].reduce((obj, y) => {
    const key = y.className.split(' ')[1];
    obj[key] = y.outerText;
    if (key === 'name' && y.querySelector('dl')) {
      const o = {}, kids = [...y.querySelector('dl').children];
      for (let i = 0; i < kids.length; i += 2) o[kids[i].outerText] = kids[i + 1].outerText;
      obj.options = o;
    }
    return obj;
  }, {}));`);
  return Array.isArray(rows) ? rows : [];
}

interface Comment { username: string; content: string; time: number; children: Comment[] }
/** The comment tree of a reddit post page, as upstream's reddit_get_post_comment_tree reads it. */
async function commentTree(page: WaPage): Promise<Comment | undefined> {
  const tree = await inPage(page, `return (function build(node, level) {
    const t = { username: node.querySelector(".fg-inherit").outerText, content: node.querySelector(".comment__content").outerText, time: node.querySelector('.comment__main > header > h1 > span > time').dateTime, children: [] };
    node.querySelectorAll(".comment").forEach((c) => { if (parseInt(c.getAttribute('data-level')) === level + 1) t.children.push(build(c, level + 1)); });
    return t;
  })(document.querySelector("#main"), 0);`);
  const read = (n: Comment & { time: unknown }): Comment => ({ ...n, time: Date.parse(String(n.time)), children: n.children.map((c) => read(c as never)) });
  return tree ? read(tree as never) : undefined;
}
/** The newest comment by `who` (the first when times tie), as upstream's dfs picks it; with `parent`, the comment that the newest reply of `who` answers (it does not look under a reply of `who`). */
async function newest(page: WaPage, who: string, parent = false): Promise<Comment | undefined> {
  let found: Comment | undefined;
  let at = -Infinity;
  const walk = (node: Comment) => {
    if (!parent && node.username === who && node.time > at) { found = node; at = node.time; }
    for (const child of node.children) {
      if (parent && child.username === who) { if (child.time > at) { found = node; at = child.time; } } else walk(child);
    }
  };
  const tree = await commentTree(page);
  if (tree) walk(tree);
  return found;
}

const text = (page: WaPage, selector: string) => attempt(async () => String((await inPage(page, `return document.querySelector(${q(selector)}).textContent;`)) ?? ""), "");

/** The `func:` helpers VWA's tasks call, beyond the ported ones; `site` is as shoppingRest's. */
export const vwaHelpers = (site: Parameters<typeof shoppingRest>[0]): NonNullable<WaFacts["helpers"]> => ({
  ...shoppingRest(site),
  get_query_text: (page, selector) => text(page as WaPage, String(selector)),
  reddit_get_latest_comment_content_by_username: async (page, who) => (await newest(page as WaPage, String(who)))?.content ?? "",
  reddit_get_parent_comment_username_of_latest_comment_by_username: async (page, who) => (await newest(page as WaPage, String(who), true))?.username ?? "",
  shopping_get_order_product_name_list: async (page) => (await orderProducts(page as WaPage)).map((p) => p.name).join(" |OR| "),
  shopping_get_order_product_quantity: async (page, sku) => {
    const skus = String(sku).split(" |OR| ");
    const hit = (await orderProducts(page as WaPage)).find((p) => skus.includes(p.sku.trim()));
    return hit ? Number.parseInt(hit.qty.slice(7), 10) || 0 : 0;
  },
  shopping_get_order_product_option: async (page, sku, option) => (await orderProducts(page as WaPage)).find((p) => p.sku.trim() === sku)?.options?.[String(option)] ?? "",
  shopping_get_product_attributes: async (page, attribute) => String((await inPage(page as WaPage, `const terms = ${q(String(attribute))}.toLowerCase().split(' |or| ');
    return [...document.querySelector('#productDetails_detailBullets_sections1 > tbody').children].filter((x) => terms.some((t) => x.children[0].outerText.toLowerCase().includes(t))).map((x) => x.children[1].outerText).join(', ');`).catch(() => "")) ?? ""),
  shopping_get_product_price: async (page) => Number(await inPage(page as WaPage, `return parseFloat(document.querySelector("#maincontent > div.columns > div > div.product-info-main > div.product-info-price > div.price-box.price-final_price > span > span").outerText.substr(1)) || 0;`).catch(() => 0)) || 0,
  shopping_get_num_reviews: async (page) => Number(await inPage(page as WaPage, `return parseInt(document.querySelector("#tab-label-reviews-title").outerText.split(' ')[1]) || 0;`).catch(() => 0)) || 0,
});

const MATCH = (n: number) => `The first ${n} image${n === 1 ? " is a reference" : "s are references"}; the rest are images from a web page. Does any page image show the same picture as any reference? Allow for resizing, compression and a different crop of the border, but not for a different photo of a similar thing. Answer "match" or "no match", and nothing else.`;

/** Upstream's PageImageEvaluator, with a Claude judge in place of BLIP-2 and SSIM. */
export async function pageImageQuery(run: Run): Promise<void> {
  const { facts } = run;
  const queries = (run.task as VwaTask).eval.page_image_query ?? [];
  let page: WaPage | undefined;
  for (const [i, query] of queries.entries()) {
    const what = `page_image_query ${i + 1}`;
    try {
      if (query.eval_image_url === "last" && !facts.finalUrl) return run.fail(`${what}: the agent opened no page`);
      const target = query.eval_image_url.startsWith("func:") ? String(await callFunc(query.eval_image_url.slice(5).replaceAll("__last_url__", facts.finalUrl!), facts.helpers, undefined)) : query.eval_image_url;
      page ??= await facts.page?.();
      if (!page || !facts.fetchImage) return run.fail(`harness: ${what} needs the judge browser and an image loader`);
      await page.goto(target === "last" ? facts.finalUrl! : target);
      await new Promise((r) => setTimeout(r, facts.settleMs ?? 3000));
      const within = query.eval_image_class.trim();
      if (within && !within.startsWith(".")) return run.fail(`harness: ${what} has an unsupported image class ${within.slice(0, 40)}`);
      const srcs = (await page.evaluate(`(() => [...document.querySelectorAll(${q(within || "img")})].flatMap((e) => e.tagName === "IMG" ? [e.src] : [...e.querySelectorAll("img")].map((i) => i.src)))()`)) as string[];
      const shown: JudgeImage[] = [];
      for (const src of srcs.slice(0, MAX_IMAGES)) shown.push(...(await attempt(async () => [await facts.fetchImage!(src)], [])));
      if (!shown.length) return run.fail(`${what}: no image to look at (${srcs.length} found)`);
      for (const { question, answer } of query.eval_vqa ?? []) {
        // Upstream asks BLIP-2 about each image, and passes when any answer holds the expected one.
        const ask = { system: "You answer questions about images.", prompt: `Answer the question for each of the ${shown.length} image${shown.length === 1 ? "" : "s"}, in order, in a few words. Write one line per image, as "<number>: <answer>", and nothing else.\nQuestion: ${question}`, images: shown };
        await run.ask(ask, (reply) => {
          const lines = reply.split("\n").map((l) => l.replace(/^\s*\d+\s*[:.)]\s*/, "").toLowerCase());
          return lines.some((l) => l.includes(answer.toLowerCase())) ? { success: true, reasons: [] } : { success: false, reasons: [`${what}: no image answers "${answer}" to "${question}"`] };
        });
      }
      if (query.eval_fuzzy_image_match) {
        const refs: JudgeImage[] = [];
        for (const ref of query.eval_fuzzy_image_match.split(" |OR| ")) refs.push(...(await attempt(async () => [await facts.fetchImage!(ref)], [])));
        if (!refs.length) run.fail(`harness: ${what}: the reference image did not load`);
        else await run.ask({ system: "You compare images.", prompt: MATCH(refs.length), images: [...refs, ...shown] }, (reply) => (/\bno match\b/i.test(reply) || !/\bmatch\b/i.test(reply) ? { success: false, reasons: [`${what}: no page image matches the reference`] } : { success: true, reasons: [] }));
      }
    } catch (error) {
      run.fail(`harness: ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** WebArena's scoring plus page_image_query. */
export const scoreVwa = (task: VwaTask, facts: WaFacts): Promise<WaScore> => scoreWa(task, { ...facts, evaluators: { ...facts.evaluators, page_image_query: pageImageQuery } });

/** An image the judge can look at, from its URL; refuses what the Claude API would (over 5 MB, or not PNG, JPEG, GIF or WebP). */
export async function fetchImage(url: string, headers: Record<string, string> = {}): Promise<JudgeImage> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 5_000_000) throw new Error(`${url}: ${bytes.length} bytes is over the 5 MB image limit`);
  const sniff = bytes.subarray(0, 12).toString("latin1");
  const mediaType = sniff.startsWith("\x89PNG") ? "image/png" : sniff.startsWith("\xff\xd8") ? "image/jpeg" : sniff.startsWith("GIF8") ? "image/gif" : sniff.startsWith("RIFF") && sniff.endsWith("WEBP") ? "image/webp" : undefined;
  if (!mediaType) throw new Error(`${url}: not a PNG, JPEG, GIF or WebP image`);
  return { mediaType, data: bytes.toString("base64") };
}
