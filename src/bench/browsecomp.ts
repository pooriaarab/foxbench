// BrowseComp (Wei et al., OpenAI, 2025): 1,266 hard-to-find-fact questions with
// short answers. OpenAI ships the test set encrypted (XOR with a key derived
// from each row's canary) and asks that its plain text not appear in public.
// The file is fetched from OpenAI's public blob, checked against a pinned
// SHA-256 and decrypted in memory at run time: the cache holds only the
// encrypted file, and boards hold ids and verdicts only (`redact: true`), with the log
// kept but masked of the gold answer and the question (`maskLog`).
// The official grader is a GPT-4o prompt; foxbench uses Claude through the
// judge interface, with a grader in the same shape.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { mask, passagePatterns, secretPatterns } from "./mask.js";
import { judgeWith, type Judge } from "./judge.js";
import { pickSubset } from "./subsets.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness } from "./types.js";
import { locked } from "./webgames.js";

/** SHA-256 of `browse_comp_test_set.csv` as fetched on 2026-10-15; simple-evals is MIT-licensed code at commit 652c89d. */
export const BROWSECOMP_SHA256 = "7b24471cd5b3eb2a46830a14802b5c029ea62f488ff75a0f88af7923d1454abf";
const DEFAULT_URL = "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv";

/** The XOR decryption of simple-evals' `browsecomp_eval.py`: the key is the password's SHA-256, repeated. */
export function decrypt(ciphertext: string, password: string): string {
  const digest = createHash("sha256").update(password).digest();
  const bytes = Buffer.from(ciphertext, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.map((b, i) => b ^ digest[i % digest.length]!));
  } catch {
    throw new Error("a BrowseComp row does not decrypt to text");
  }
}

/** Comma-separated rows; a field may be quoted, with a doubled quote inside. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ""));
}

const GRADER = `You grade a response to a question against a correct answer. Extract the final answer from the response, then decide whether it matches the correct answer. It matches when it is equivalent in meaning and precision: no meaningful difference, and for a number no margin beyond rounding. If the response gives several different final answers, or none, it does not match. Do not argue for or against the correct answer; compare only.
Reply in three lines:
extracted_final_answer: <the final answer, or None>
reasoning: <one or two sentences comparing it with the correct answer>
correct: "yes" or "no"`;

const url = (ctx: BenchContext) => ctx.env.FOXBENCH_BROWSECOMP_URL ?? DEFAULT_URL;
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A local start page with the question and a search form. */
async function startPage(id: string, question: string) {
  const html = `<!doctype html><meta charset="utf-8"><title>BrowseComp</title><main data-case="${escape(id)}"><p>${escape(question)}</p>
<form action="https://www.google.com/search" method="get"><input name="q" aria-label="Search the web"><button>Search</button></form></main>`;
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

interface Row { id: string; topic: string; problem: string; answer: string }
const started = new WeakMap<Episode, Row>();

export const browsecompBenchmark = (o: { sha256?: string } = {}): Benchmark => {
  const pin = o.sha256 ?? BROWSECOMP_SHA256;
  const file = (ctx: BenchContext) => join(ctx.cacheDir, `browsecomp-${pin.slice(0, 12)}`, "browse_comp_test_set.csv");
  const verified = (text: string) => {
    if (createHash("sha256").update(text).digest("hex") !== pin) throw new Error(`the BrowseComp file differs from the pinned SHA-256 ${pin.slice(0, 12)}`);
    return text;
  };
  let rows: Row[] = [];
  /** Fetches the encrypted file once into the cache, and checks it against the pin. */
  const ensure = async (ctx: BenchContext) => {
    const path = file(ctx);
    await locked(join(path, ".."), async () => {
      if (existsSync(path)) return;
      const res = await fetch(url(ctx));
      if (!res.ok) throw new Error(`HTTP ${res.status} for the BrowseComp file`);
      const text = verified(await res.text());
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(`${path}.part`, text);
      renameSync(`${path}.part`, path);
    });
    return verified(readFileSync(path, "utf8"));
  };
  /** Decrypts the cached file in memory. */
  const read = async (ctx: BenchContext) => {
    const [, ...body] = parseCsv(await ensure(ctx));
    rows = body.map(([problem, answer, topic, canary], i) => ({ id: `browsecomp-${String(i).padStart(4, "0")}`, topic: topic!.toLowerCase(), problem: decrypt(problem!, canary!), answer: decrypt(answer!, canary!) }));
  };
  return {
    id: "browsecomp",
    title: "BrowseComp",
    upstream: { repo: "https://github.com/openai/simple-evals", ref: pin, paper: "https://arxiv.org/abs/2504.12516" },
    licence: { code: "MIT", data: "encrypted by OpenAI; the plain text must not be published", mode: "user-access" },
    where: "live-web",
    measures: ["task", "info-seeking"],
    scoring: "llm",
    redact: true,
    async check(ctx): Promise<Readiness> {
      try {
        await ensure(ctx);
        return { ready: true };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ready: false, reason: /SHA-256/.test(reason) ? reason : `the BrowseComp file is not reachable (${reason})`, fix: /SHA-256/.test(reason) ? "delete the cached file, and update the pin only after reading the new file's licence" : "connect to the network once; the cache is used after that" };
      }
    },
    async load(ctx, subset) {
      await read(ctx);
      // No goal: the questions stay out of `foxbench list` and the boards (BC3).
      const all: Case[] = rows.map((r) => ({ id: r.id, tags: [r.topic], judge: "llm" }));
      return pickSubset("browsecomp", all, subset);
    },
    async up(ctx) {
      await read(ctx);
      return { judges: ctx.judges ?? [] };
    },
    async start(_env, item) {
      const row = rows.find((r) => r.id === item.id);
      if (!row) throw new Error(`browsecomp has no case ${item.id}`);
      const page = await startPage(row.id, row.problem);
      const episode: Episode = { url: page.url, goal: `${row.problem}\n\nWhen you are done, reply in this format:\nExplanation: <your reasoning>\nExact Answer: <your succinct final answer>\nConfidence: <0% to 100%>`, startPath: "/", close: page.close };
      started.set(episode, row);
      return episode;
    },
    // The log keeps steps, errors, the last page and the final message; the gold answer and the question are masked (BC8, BC9).
    maskLog(episode, log) {
      const row = started.get(episode);
      return row ? mask(log, [...secretPatterns(row.answer), ...passagePatterns(row.problem)]) : "";
    },
    async judge(env, episode, output) {
      const row = started.get(episode);
      if (!row) throw new Error("browsecomp did not start this episode");
      return judgeWith(env.judges as Judge[], { system: GRADER, prompt: `Question: ${row.problem}\n\nResponse:\n${String(output.answer ?? "") || "(none)"}\n\nCorrect answer: ${row.answer}` }, (reply) => {
        const m = /correct:\s*"?(yes|no)"?/i.exec(reply);
        if (!m) throw new Error("the reply has no correct line");
        const success = m[1]!.toLowerCase() === "yes";
        // The reason never quotes the gold answer or the judge's reasoning (BC4).
        return { success, reasons: success ? [] : ["the answer does not match"] };
      });
    },
    down: async () => {},
    baselines: [
      { agent: "OpenAI Deep Research", subset: "full", score: 0.515, source: "https://arxiv.org/abs/2504.12516" },
      { agent: "Tongyi DeepResearch 30B-A3B (open)", subset: "full", score: 43.4 / 100, source: "https://tongyi-agent.github.io/blog/introducing-tongyi-deep-research/", vendorReported: true },
      { agent: "Claude Opus 4.6, multi-agent harness", subset: "full", score: 0.868, source: "https://www.anthropic.com/news/claude-opus-4-6", vendorReported: true },
    ],
  };
};
