// Tests for the WebArena evaluator failure modes in docs/failure-modes.md
// (WE1-WE10). Tasks have the shape of WebArena-Lite's; the judge is a fake and
// the judge browser is a scripted page, so no test calls an API or starts
// Firefox (e2e/wa-judge.mjs runs the real browser).
import { describe, expect, it } from "vitest";
import type { Judge } from "../src/bench/judge.js";
import { scoreWa, tokenize, type WaFacts, type WaPage, type WaTask } from "../src/bench/wa/eval.js";

const task = (e: Partial<WaTask["eval"]>, intent = "the question"): WaTask => ({ intent, eval: { eval_types: ["string_match"], ...e } });
/** A fake judge that records what it was asked and answers with `says(prompt)`. */
function judge(says: (prompt: string) => string = () => "correct") {
  const asked: string[] = [];
  const j: Judge = { name: "claude", model: "fake-model", where: "cloud", ask: async ({ prompt }) => { asked.push(prompt); return says(prompt); } };
  return { j, asked };
}
/** A scripted browser page: what it loads and what each locator gives. */
function scripted(pages: Record<string, { html?: string; js?: Record<string, unknown> }>) {
  const opened: string[] = [];
  let at = "";
  const page: WaPage = {
    goto: async (url) => { if (!pages[url]) throw new Error(`no page ${url}`); at = url; opened.push(url); },
    evaluate: async (js) => { const hit = Object.entries(pages[at]?.js ?? {}).find(([k]) => js.includes(k)); if (!hit) throw new Error("no such element"); return hit[1]; },
    content: async () => pages[at]?.html ?? "",
  };
  return { page, opened };
}
const facts = (over: Partial<WaFacts> = {}): WaFacts => ({ answer: "", finalUrl: undefined, judges: [], settleMs: 0, ...over });
const ok = async (t: WaTask, f: Partial<WaFacts>) => (await scoreWa(t, facts(f))).success;

const has = (ref: string, answer: string) => ok(task({ reference_answers: { must_include: [ref] } }), { answer });
const urlTask = (ref: string, note?: string) => task({ eval_types: ["url_match"], reference_url: ref, ...(note ? { url_note: note } : {}) });

describe("WE1 must_include", () => {
  it("matches a one-word reference only as a whole token", async () => {
    expect(await has("0", "10 items")).toBe(false);
    expect(await has("0", "There are 0 items.")).toBe(true);
    expect(await has("3", "3, 4 and 5")).toBe(true);
    expect(await has("pittsburgh", "Pittsburgh.")).toBe(true);
    expect(await has("b", "a/b")).toBe(true);
    expect(tokenize("it's $5.00, ok.")).toEqual(["it", "'s", "$", "5.00", ",", "ok", "."]);
  });
  it("matches a longer reference as a substring, ignoring case and one pair of outer quotes", async () => {
    expect(await has("Impulse Duffle", '"the impulse duffle and more"')).toBe(true);
    expect(await has("Impulse Duffle", "an impulse of duffle")).toBe(false);
  });
});

describe("WE2 alternatives and exact_match", () => {
  it("needs every must_include entry, each satisfied by any of its alternatives", async () => {
    const t = task({ reference_answers: { must_include: ["red |OR| blue", "large"] } });
    expect(await ok(t, { answer: "a blue large shirt" })).toBe(true);
    expect(await ok(t, { answer: "a blue shirt" })).toBe(false);
    expect(await ok(t, { answer: "a green large shirt" })).toBe(false);
  });
  it("compares exact_match on the cleaned strings", async () => {
    const t = task({ reference_answers: { exact_match: "Paris" } });
    expect(await ok(t, { answer: "'paris'" })).toBe(true);
    expect(await ok(t, { answer: "Paris, France" })).toBe(false);
  });
});

describe("WE3 fuzzy_match", () => {
  const t = task({ reference_answers: { fuzzy_match: ["13min", "1h 45min"] } }, "How long?");
  it("asks the judges with upstream's prompt, lets the first decide, and marks the case llm", async () => {
    const { j, asked } = judge();
    const r = await scoreWa(t, facts({ answer: "driving 13 minutes, walking 1h45", judges: [j] }));
    expect(r).toMatchObject({ success: true, llm: true, judges: [{ judge: "claude", model: "fake-model", success: true }] });
    expect(asked[0]).toContain("question: How long?\nreference answer: 13min, 1h 45min\n");
    expect(asked[0]).toContain("student answer: driving 13 minutes, walking 1h45\n");
  });
  it("fails on incorrect and partially correct, and with no judge", async () => {
    for (const says of ["incorrect", "Partially correct"]) expect(await ok(t, { answer: "x", judges: [judge(() => says).j] })).toBe(false);
    const none = await scoreWa(t, facts({ answer: "x" }));
    expect(none.success).toBe(false);
    expect(none.reasons[0]).toBe("judge: no judge");
  });
  it("never asks about an empty answer", async () => {
    const { j, asked } = judge();
    expect(await ok(t, { answer: "", judges: [j] })).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("WE4 unachievable tasks", () => {
  const t = task({ reference_answers: { fuzzy_match: "N/A" }, string_note: "We cannot add order history." }, "Add the order");
  it("passes N/A with no judge, and asks about any other answer", async () => {
    const { j, asked } = judge(() => "same");
    expect(await ok(t, { answer: "N/A", judges: [j] })).toBe(true);
    expect(asked).toEqual([]);
    expect(await ok(t, { answer: "The site has no order history feature.", judges: [j] })).toBe(true);
    expect(asked[0]).toContain("actual unachievable reason: We cannot add order history.");
    expect(await ok(t, { answer: "The site is slow.", judges: [judge(() => "different").j] })).toBe(false);
  });
});

describe("WE5 url_match", () => {
  it("ignores a trailing slash and localhost, and takes any |OR| url", async () => {
    expect(await ok(urlTask("http://127.0.0.1:7770/a |OR| http://127.0.0.1:7770/b"), { finalUrl: "http://localhost:7770/b/" })).toBe(true);
    expect(await ok(urlTask("http://127.0.0.1:7770/a"), { finalUrl: "http://127.0.0.1:7770/a?x=1" })).toBe(false);
  });
  it("reads GOLD in PRED as a substring, and fails an unknown rule or no page", async () => {
    expect(await ok(urlTask("/a/b", "GOLD in PRED"), { finalUrl: "http://127.0.0.1:7770/a/b/c" })).toBe(true);
    expect((await scoreWa(urlTask("/a", "LOOSE"), facts({ finalUrl: "http://x/a" }))).reasons[0]).toContain("unsupported url_note LOOSE");
    expect((await scoreWa(urlTask("/a"), facts())).reasons[0]).toContain("opened no page");
  });
});

const html = (targets: object[]) => task({ eval_types: ["program_html"], program_html: targets as never });
const target = (over: object) => ({ url: "http://127.0.0.1:7780/x", locator: "", required_contents: { must_include: ["saved"] }, ...over });

describe("WE6 program_html", () => {
  it("opens the target, runs the locator in the page, and checks the contents", async () => {
    const { page, opened } = scripted({ "http://127.0.0.1:7780/x": { html: "<p>Saved!</p>", js: { "#name": "Alice" } } });
    const f = { page: async () => page };
    expect(await ok(html([target({})]), f)).toBe(true);
    expect(await ok(html([target({ locator: "document.querySelector('#name').value", required_contents: { exact_match: "alice" } })]), f)).toBe(true);
    expect(opened).toEqual(["http://127.0.0.1:7780/x", "http://127.0.0.1:7780/x"]);
  });
  it("reads `last` as the final URL, and treats a locator that throws as an empty page", async () => {
    const { page, opened } = scripted({ "http://127.0.0.1:7780/end": { js: {} } });
    const t = html([target({ url: "last", locator: "document.querySelector('#gone').value" })]);
    const r = await scoreWa(t, facts({ page: async () => page, finalUrl: "http://127.0.0.1:7780/end" }));
    expect(opened).toEqual(["http://127.0.0.1:7780/end"]);
    expect(r).toMatchObject({ success: false, reasons: ["program_html 1: the answer is empty"] });
  });
});

describe("WE7 func helpers", () => {
  it("ports reddit_get_post_url and uses __last_url__", async () => {
    const { page, opened } = scripted({ "http://127.0.0.1:9999/f/books/42/": { html: "great read" } });
    const t = html([target({ url: "func:reddit_get_post_url('__last_url__')", required_contents: { must_include: ["great read"] } })]);
    expect(await ok(t, { page: async () => page, finalUrl: "http://127.0.0.1:9999/f/books/42/a-title/comment/7" })).toBe(true);
    expect(opened).toEqual(["http://127.0.0.1:9999/f/books/42/"]);
    expect(await ok(t, { page: async () => page })).toBe(false);
  });
  it("ports gitlab_get_project_memeber_role, runs a passed helper, and fails an unknown one by name", async () => {
    const { page } = scripted({ "http://127.0.0.1:8023/m": { js: { "@vinta": 2, "td.col-max-role": "Developer" } } });
    const role = html([target({ url: "http://127.0.0.1:8023/m", locator: "func:gitlab_get_project_memeber_role(__page__, 'vinta')", required_contents: { exact_match: "developer" } })]);
    expect(await ok(role, { page: async () => page })).toBe(true);
    const latest = html([target({ url: "func:shopping_get_latest_order_url()" })]);
    expect((await scoreWa(latest, facts({ page: async () => page }))).reasons[0]).toContain("unknown helper shopping_get_latest_order_url");
    const seen = scripted({ "http://127.0.0.1:7770/order/9": { html: "saved" } });
    expect(await ok(latest, { page: async () => seen.page, helpers: { shopping_get_latest_order_url: () => "http://127.0.0.1:7770/order/9" } })).toBe(true);
  });
});

describe("WE8 the product", () => {
  it("fails when any evaluator fails", async () => {
    const t = task({ eval_types: ["string_match", "url_match", "program_html"], reference_answers: { exact_match: "done" }, reference_url: "http://127.0.0.1:7770/a", program_html: [target({})] });
    const { page } = scripted({ "http://127.0.0.1:7780/x": { html: "saved" } });
    const good = { answer: "done", finalUrl: "http://127.0.0.1:7770/a", page: async () => page };
    expect(await ok(t, good)).toBe(true);
    for (const bad of [{ answer: "no" }, { finalUrl: "http://127.0.0.1:7770/b" }, { page: async () => scripted({ "http://127.0.0.1:7780/x": { html: "oops" } }).page }]) expect(await ok(t, { ...good, ...bad })).toBe(false);
  });
});

describe("WE9 approaches the port does not know", () => {
  it("fails with the name, and never passes", async () => {
    const r = await scoreWa(task({ reference_answers: { fuzzy_ish: ["x"] } as never }), facts({ answer: "5" }));
    expect(r).toMatchObject({ success: false, reasons: ["harness: unsupported string_match approach fuzzy_ish"] });
    expect((await scoreWa(task({ eval_types: ["image_match"] }), facts())).success).toBe(false);
  });
});

const gone = (text: string) => ok(html([target({ url: "http://127.0.0.1:8023/p", required_contents: { must_exclude: ["dotfiles"] } })]), { page: async () => scripted({ "http://127.0.0.1:8023/p": { html: text } }).page });
describe("WE11 must_exclude", () => {
  it("fails while an entry is on the page, as a whole token for one word, and on an empty page", async () => {
    expect(await gone("<li>dotfiles</li>")).toBe(false);
    expect(await gone("<li>dotfiles-2</li><li>other</li>")).toBe(true);
    expect(await gone("")).toBe(false);
  });
});

describe("WE10 noop", () => {
  it("scores 0 on every kind and opens no browser", async () => {
    let started = 0;
    const page = async () => { started++; return scripted({}).page; };
    const tasks = [task({ reference_answers: { must_include: ["x"] } }), task({ reference_answers: { fuzzy_match: ["x"] } }), task({ reference_answers: { fuzzy_match: "N/A" } }),
      task({ eval_types: ["url_match"], reference_url: "http://127.0.0.1:7770/a" }), html([target({ url: "last" })])];
    for (const t of tasks) expect(await ok(t, { page, judges: [judge().j] })).toBe(false);
    expect(started).toBe(0);
  });
});
