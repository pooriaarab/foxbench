// Tests for the VisualWebArena evaluator failure modes in docs/failure-modes.md
// (VE1-VE6). Tasks have the shape of VWA's configs; the judge is a fake that
// records what it was shown, and the judge browser is a scripted page, so no
// test calls an API or starts Firefox.
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localJudge, type Judge, type JudgeAsk, type JudgeImage } from "../src/bench/judge.js";
import type { WaFacts, WaPage } from "../src/bench/wa/eval.js";
import { fetchImage, scoreVwa, vwaHelpers, type VwaTask } from "../src/bench/vwa/eval.js";

const task = (e: Partial<VwaTask["eval"]>, intent = "the question"): VwaTask => ({ intent, eval: { eval_types: ["string_match"], ...e } });
const PNG: JudgeImage = { mediaType: "image/png", data: "cG5n" };
/** A fake judge that records what it was asked and shown, and answers with `says`. */
function judge(says: (ask: JudgeAsk) => string) {
  const asked: JudgeAsk[] = [];
  const j: Judge = { name: "claude", model: "fake-model", where: "cloud", ask: async (a) => { asked.push(a); return says(a); } };
  return { j, asked };
}
/** A scripted page: `at` is where it was sent, and each key that the evaluated JS contains gives its value. */
function scripted(pages: Record<string, Record<string, unknown>>) {
  let at = "";
  const page: WaPage = {
    goto: async (url) => { if (!pages[url]) throw new Error(`no page ${url}`); at = url; },
    evaluate: async (js) => { const hit = Object.entries(pages[at] ?? {}).find(([k]) => js.includes(k)); if (!hit) throw new Error("no such element"); return hit[1]; },
    content: async () => "",
  };
  return page;
}
const facts = (over: Partial<WaFacts> = {}): WaFacts => ({ answer: "", finalUrl: undefined, judges: [], settleMs: 0, ...over });
const ok = async (t: VwaTask, f: Partial<WaFacts>) => (await scoreVwa(t, facts(f))).success;
const html = (targets: object[]) => task({ eval_types: ["program_html"], program_html: targets as never });

const countTask = (rule: string, locator = "func:shopping_get_num_reviews(__page__)") => html([{ url: "last", locator, required_contents: { required_values: [rule] } }]);
const titled = (v: unknown) => ({ finalUrl: "http://x/p", page: async () => scripted({ "http://x/p": { "document.title": v } }) });
const withHelpers = (js: Record<string, unknown>) => ({ finalUrl: "http://x/p", helpers: vwaHelpers(() => ({ origin: "", canonical: "" })), page: async () => scripted({ "http://x/p": js }) });
const one = (locator: string, must: string[]) => html([{ url: "last", locator, required_contents: { must_include: must } }]);
const tree = (kids: object[]) => ({ username: "op", content: "post", time: "2024-01-01T00:00:00Z", children: kids });
const c = (username: string, content: string, time: string, children: object[] = []) => ({ username, content, time, children });
const withImages = (srcs: string[]) => ({ finalUrl: "http://x/p", page: async () => scripted({ "http://x/p": { 'tagName === "IMG"': srcs } }), fetchImage: async () => PNG });
const says = (reply: string) => judge(() => reply);

describe("VE1 required_values and one_of", () => {
  it("scores a number against its inequalities as upstream does, commas and alternatives included", async () => {
    const t = task({ reference_answers: { required_values: [">= 12", "< 20 |OR| == 25"] } });
    expect(await ok(t, { answer: "15" })).toBe(true);
    expect(await ok(t, { answer: "25" })).toBe(true);
    expect(await ok(t, { answer: "22" })).toBe(false);
    expect(await ok(t, { answer: "11" })).toBe(false);
    expect(await ok(t, { answer: "1,500" })).toBe(false);
    expect(await ok(task({ reference_answers: { required_values: ["> 1000"] } }), { answer: "1,500" })).toBe(true);
    expect(await ok(t, { answer: "about 15" })).toBe(false);
    expect(await ok(t, { answer: "" })).toBe(false);
  });
  it("reads a program_html count the same way, and a helper's price as a number", async () => {
    const f = { finalUrl: "http://127.0.0.1:7770/p", page: async () => scripted({ "http://127.0.0.1:7770/p": { "#tab-label-reviews-title": 14, "price-box": 12.5 } }), helpers: vwaHelpers(() => ({ origin: "", canonical: "" })) };
    expect(await ok(countTask(">= 12"), f)).toBe(true);
    expect(await ok(countTask(">= 15"), f)).toBe(false);
    expect(await ok(countTask(">= 12.5", "func:shopping_get_product_price(__page__)"), f)).toBe(true);
    expect(await ok(countTask("> 13", "func:shopping_get_product_price(__page__)"), f)).toBe(false);
  });
  it("passes one_of when any entry is in the answer", async () => {
    const t = task({ reference_answers: { one_of: ["yellow", "Gold"], must_include: ["1.04"] } });
    expect(await ok(t, { answer: "A golden bowl, $1.04" })).toBe(true);
    expect(await ok(t, { answer: "A red bowl, $1.04" })).toBe(false);
    expect(await ok(t, { answer: "yellow" })).toBe(false);
  });
});

describe("VE2 lambda locators", () => {
  it("runs the expression, and fails on a falsy result", async () => {
    const t = html([{ url: "last", locator: "lambda:(() => document.title)()", required_contents: { must_include: ["Men", "Tennis Shoe"] } }]);
    expect(await ok(t, titled("Men's Tennis Shoe"))).toBe(true);
    expect(await ok(t, titled(""))).toBe(false);
    expect(await ok(t, titled("Women's Boot"))).toBe(false);
  });
});

describe("VE3 helpers", () => {
  it("get_query_text reads the element's text, and an empty string when there is none", async () => {
    const t = one("func:get_query_text(__page__, '.price')", ["270.00"]);
    expect(await ok(t, withHelpers({ '".price"': "$270.00" }))).toBe(true);
    expect(await ok(t, withHelpers({ '".price"': "$250.00" }))).toBe(false);
    expect(await ok(t, withHelpers({}))).toBe(false);
  });
  it("reddit: the newest comment of a user, and the author of the comment it answers", async () => {
    const page = withHelpers({ "comment__content": tree([c("zed", "old", "2024-01-02T00:00:00Z"), c("ann", "first", "2024-01-03T00:00:00Z", [c("me", "newest", "2024-01-05T00:00:00Z")]), c("me", "older", "2024-01-04T00:00:00Z")]) });
    expect(await ok(one("func:reddit_get_latest_comment_content_by_username(__page__, 'me')", ["newest"]), page)).toBe(true);
    expect(await ok(one("func:reddit_get_latest_comment_content_by_username(__page__, 'me')", ["older"]), page)).toBe(false);
    expect(await ok(one("func:reddit_get_parent_comment_username_of_latest_comment_by_username(__page__, 'me')", ["ann"]), page)).toBe(true);
    expect(await ok(one("func:reddit_get_latest_comment_content_by_username(__page__, 'nobody')", ["newest"]), page)).toBe(false);
  });
  it("shopping orders: the quantity of a sku, an option, and the product names", async () => {
    const rows = [{ name: "Bar\nSize\n12", sku: "B00MXUFL0E ", qty: "Ordered2", options: { Size: "12" } }, { name: "Cookie", sku: "B07ZD2PB9F", qty: "Ordered3" }];
    const page = withHelpers({ "my-orders-table": rows });
    expect(await ok(one("func:shopping_get_order_product_quantity(__page__, 'B00MXUFL0E')", ["2"]), page)).toBe(true);
    expect(await ok(one("func:shopping_get_order_product_quantity(__page__, 'X |OR| B07ZD2PB9F')", ["3"]), page)).toBe(true);
    expect(await ok(one("func:shopping_get_order_product_quantity(__page__, 'B07ZD2PB9F')", ["2"]), page)).toBe(false);
    expect(await ok(one("func:shopping_get_order_product_option(__page__, 'B00MXUFL0E', 'Size')", ["12"]), page)).toBe(true);
    expect(await ok(one("func:shopping_get_order_product_name_list(__page__)", ["Cookie"]), page)).toBe(true);
    expect(await ok(one("func:shopping_get_order_product_quantity(__page__, 'B07ZD2PB9F')", ["3"]), withHelpers({}))).toBe(false);
  });
  it("an unknown helper still fails the case with its name", async () => {
    const r = await scoreVwa(one("func:made_up(__page__)", ["x"]), facts(withHelpers({})));
    expect(r.success).toBe(false);
    expect(r.reasons.join()).toContain("unknown helper made_up");
  });
});

describe("VE4 page_image_query: a question about the page's images", () => {
  const t = task({ eval_types: ["page_image_query"], page_image_query: [{ eval_image_url: "last", eval_image_class: ".submission__image", eval_vqa: [{ question: "What animal is this?", answer: "Cat" }] }] });
  it("shows the judge the images and passes when any image's answer holds the expected one", async () => {
    const { j, asked } = says("1: a dog\n2: A Cat sitting");
    const r = await scoreVwa(t, facts({ ...withImages(["a.png", "b.png"]), judges: [j] }));
    expect(r).toMatchObject({ success: true, llm: true, judges: [{ judge: "claude", model: "fake-model", success: true }] });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.images).toEqual([PNG, PNG]);
    expect(asked[0]!.prompt).toContain("What animal is this?");
  });
  it("fails when no image answers it, with no judge, with no image, and when the local judge refuses images", async () => {
    expect(await ok(t, { ...withImages(["a.png"]), judges: [says("1: a dog").j] })).toBe(false);
    const none = await scoreVwa(t, facts(withImages(["a.png"])));
    expect(none.reasons[0]).toBe("judge: no judge");
    expect(await ok(t, { ...withImages([]), judges: [says("1: a cat").j] })).toBe(false);
    const local = await scoreVwa(t, facts({ ...withImages(["a.png"]), judges: [localJudge({ url: "http://127.0.0.1:9" })] }));
    expect(local).toMatchObject({ success: false, reasons: [expect.stringContaining("the local judge takes no images")] });
  });
  it("fails when the agent opened no page, the image cannot load, or the class is not one it knows", async () => {
    expect(await ok(t, { judges: [says("1: a cat").j] })).toBe(false);
    expect(await ok(t, { ...withImages(["a.png"]), judges: [says("1: a cat").j], fetchImage: async () => { throw new Error("404"); } })).toBe(false);
    const odd = task({ eval_types: ["page_image_query"], page_image_query: [{ eval_image_url: "last", eval_image_class: "#x", eval_vqa: [{ question: "q", answer: "a" }] }] });
    expect((await scoreVwa(odd, facts({ ...withImages(["a.png"]), judges: [says("1: a").j] }))).reasons[0]).toContain("unsupported image class");
  });
});

describe("VE5 page_image_query: an image match", () => {
  const ref = { ...PNG, data: "cmVm" };
  const t = task({ eval_types: ["page_image_query"], page_image_query: [{ eval_image_url: "last", eval_image_class: ".item-photos", eval_fuzzy_image_match: "https://img.example/a.jpg |OR| coco/b.jpg" }] });
  const f = (judges: Judge[]) => ({ finalUrl: "http://x/p", judges, page: async () => scripted({ "http://x/p": { 'tagName === "IMG"': ["a.png"] } }), fetchImage: async (url: string) => (url === "a.png" ? PNG : ref) });
  it("asks the judge with the references first and the page images after, and passes only on a match", async () => {
    const yes = judge(() => "match");
    expect(await ok(t, f([yes.j]))).toBe(true);
    expect(yes.asked[0]!.images).toEqual([ref, ref, PNG]);
    expect(await ok(t, f([judge(() => "no match").j]))).toBe(false);
    expect(await ok(t, f([judge(() => "unsure").j]))).toBe(false);
    expect((await scoreVwa(t, facts(f([])))).reasons[0]).toBe("judge: no judge");
  });
  it("fails when no reference image loads", async () => {
    const r = await scoreVwa(t, facts({ ...f([judge(() => "match").j]), fetchImage: async (u: string) => { if (u === "a.png") return PNG; throw new Error("404"); } }));
    expect(r).toMatchObject({ success: false, reasons: [expect.stringContaining("the reference image did not load")] });
  });
});

describe("VE6 image loading", () => {
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(16)]);
  const server = createServer((req, res) => {
    if (req.url === "/ok.png") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(png);
    if (req.url === "/big.png") return res.writeHead(200).end(Buffer.concat([png, Buffer.alloc(5_000_001)]));
    if (req.url === "/page.html") return res.writeHead(200).end("<html></html>");
    res.writeHead(404).end();
  });
  let base = "";
  beforeAll(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  it("reads the type from the bytes, and refuses a missing, oversized or non-image file", async () => {
    expect(await fetchImage(`${base}/ok.png`)).toEqual({ mediaType: "image/png", data: png.toString("base64") });
    await expect(fetchImage(`${base}/big.png`)).rejects.toThrow(/5 MB/);
    await expect(fetchImage(`${base}/page.html`)).rejects.toThrow(/not a PNG/);
    await expect(fetchImage(`${base}/none.png`)).rejects.toThrow(/404/);
  });
});
