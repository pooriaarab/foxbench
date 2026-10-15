// Tests for the GAIA failure modes in docs/failure-modes.md (Q1-Q7). GAIA is
// gated, so the dataset here is synthetic, served by a fake Hugging Face
// endpoint (HF_ENDPOINT) in a temporary cache; the scorer is the real
// upstream one, fetched at its pinned revision. Without uv on the PATH these
// tests are skipped (CI installs uv).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { GAIA_DATASET_REF, GAIA_SCORER_REF, gaiaBenchmark, scorerCommand } from "../src/bench/gaia.js";
import { benchContext } from "../src/bench/registry.js";
import { runBenchmarks } from "../src/bench/run.js";
import { toMarkdown } from "../src/score.js";

const hasUv = spawnSync("uv", ["--version"]).status === 0;
if (!hasUv) console.warn("tests/gaia.test.ts: uv is not on the PATH, so the GAIA tests are skipped");
const TOKEN = "hf_fake_token";
const ROWS = [
  { task_id: "q-num", Question: "How many legs does a spider have?", Level: "1", "Final answer": "8", file_name: "" },
  { task_id: "q-big", Question: "How many metres are in one kilometre?", Level: "1", "Final answer": "1000", file_name: "" },
  { task_id: "q-list", Question: "Name the colours of a traffic light, top to bottom.", Level: "2", "Final answer": "red, amber, green", file_name: "" },
  { task_id: "q-file", Question: "Which city does the attached note name?", Level: "3", "Final answer": "Lisbon", file_name: "q-file.txt" },
];
const gold = (id: string) => ROWS.find((r) => r.task_id === id)!["Final answer"];

const dir = mkdtempSync(join(tmpdir(), "fbn-gaia-"));
const saved = { ...process.env };
const bench = gaiaBenchmark();
const ctx = () => benchContext();
let hf = "";
const server = createServer((req, res) => {
  const want = `/datasets/gaia-benchmark/GAIA/resolve/${GAIA_DATASET_REF}/2023/validation/`;
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(403).end("Access to dataset gaia-benchmark/GAIA is restricted.");
  if (!req.url?.startsWith(want)) return void res.writeHead(404).end();
  const name = req.url.slice(want.length);
  if (name === "metadata.parquet") return void res.writeHead(200).end(readFileSync(join(dir, "metadata.parquet")));
  if (name === "q-file.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("The note says: meet me in Lisbon.");
  res.writeHead(404).end();
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hf = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Object.assign(process.env, { HF_ENDPOINT: hf, HF_TOKEN: TOKEN, FOXBENCH_CACHE: join(dir, "cache") });
  if (!hasUv) return;
  writeFileSync(join(dir, "rows.json"), JSON.stringify(ROWS));
  writeFileSync(join(dir, "make.py"), "import json, sys, pyarrow as pa, pyarrow.parquet as pq\npq.write_table(pa.Table.from_pylist(json.load(open(sys.argv[1]))), sys.argv[2])\n");
  execFileSync("uv", ["run", "--isolated", "--no-project", "--with", "pyarrow", "python", "-I", join(dir, "make.py"), join(dir, "rows.json"), join(dir, "metadata.parquet")]);
}, 300_000);
afterAll(() => {
  process.env = saved;
  return new Promise<void>((r) => server.close(() => r()));
});

/** A scripted agent: it reads the case from the start page, opens an attached file when there is one, and answers with `answer`. */
const scripted = (name: string, answer: (id: string, file: string) => string): Adapter => ({
  name,
  async runTask({ url }) {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    const page = await (await fetch(url)).text();
    const id = /data-case="([^"]+)"/.exec(page)![1]!;
    const link = /href="(\/files\/[^"]+)"/.exec(page)?.[1];
    const file = link ? await (await fetch(new URL(link, url))).text() : "";
    return { done: true, log: `I read the page. ${answer(id, file)}`, answer: answer(id, file) };
  },
});
const play = (adapter: Adapter) => runBenchmarks({ adapter, runs: [{ benchmark: bench, subset: "full" }], timeoutMs: 30_000 });

describe("Q3 check()", () => {
  it("is not ready without HF_TOKEN, or with a token that has no access, or without uv", async () => {
    expect(await bench.check({ ...ctx(), env: { ...process.env, HF_TOKEN: "" } })).toMatchObject({ ready: false, reason: expect.stringContaining("HF_TOKEN"), fix: expect.any(String) });
    expect(await bench.check({ ...ctx(), env: { ...process.env, HF_TOKEN: "hf_other" } })).toMatchObject({ ready: false, reason: expect.stringContaining("no access"), fix: expect.stringContaining("huggingface.co/datasets/gaia-benchmark/GAIA") });
    expect(await bench.check({ ...ctx(), env: { ...process.env, PATH: "/nonexistent" } })).toMatchObject({ ready: false, reason: expect.stringContaining("uv"), fix: expect.any(String) });
  });
});

describe.skipIf(!hasUv)("GAIA", () => {
  it("Q1 Q7 pinned revisions, user access, redacted, and an isolated scorer", async () => {
    expect(GAIA_DATASET_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(GAIA_SCORER_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(bench).toMatchObject({ upstream: { ref: GAIA_DATASET_REF }, licence: { mode: "user-access" }, where: "live-web", redact: true });
    expect(await bench.check(ctx())).toEqual({ ready: true });
    const [cmd, args] = scorerCommand(ctx());
    expect(cmd).toBe("uv");
    expect(args).toEqual(expect.arrayContaining(["run", "--isolated", "-I"]));
    expect(args.find((a) => a.endsWith(".py"))!.startsWith(join(dir, "cache", "foxbench-helpers"))).toBe(true);
  });

  it("Q4 cases are GAIA's task ids with levels as tiers, and no question text", async () => {
    const cases = await bench.load(ctx(), "full");
    expect(cases.map((c) => [c.id, c.tier, c.tags])).toEqual([["q-num", "easy", ["level1"]], ["q-big", "easy", ["level1"]], ["q-list", "medium", ["level2"]], ["q-file", "hard", ["level3"]]]);
    expect(cases.every((c) => c.goal === undefined)).toBe(true);
  }, 300_000);

  it("Q5 Q6 noop and wrong pass 0, perfect passes all, a comma number passes, the attachment is on the start page", async () => {
    expect((await play(noopAdapter())).passed).toBe(0);
    expect((await play(scripted("wrong", () => "Atlantis"))).passed).toBe(0);
    const perfect = await play(scripted("perfect", (id, file) => (id === "q-file" ? /in (\w+)\./.exec(file)![1]! : id === "q-big" ? "1,000" : gold(id))));
    expect(perfect).toMatchObject({ tasks: 4, passed: 4, adapterErrors: 0 });
  }, 120_000);

  it("Q2 a redacted board holds ids and verdicts only", async () => {
    const board = await play(scripted("echo", (id) => `${ROWS.find((r) => r.task_id === id)!.Question} ${gold(id)}x`));
    expect(board.passed).toBe(0);
    const text = JSON.stringify(board) + toMarkdown(board);
    for (const r of ROWS) {
      expect(text).not.toContain(r.Question);
      // Short golds such as "8" appear in any board as digits, so only the distinctive ones are checked.
      if (r["Final answer"].length > 4) expect(text).not.toContain(r["Final answer"]);
    }
    expect(board.results.every((r) => r.log === "")).toBe(true);
  }, 120_000);
});
