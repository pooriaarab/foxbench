// Mind2Web 2 (Gou et al., 2025), the 10 public dev tasks: open research tasks
// answered with citations. Upstream publishes each task as a Python script with
// its task text and a rubric tree; the scripts are fetched at a pinned commit
// into the cache and only the task text is read. Its evaluators need an OpenAI
// key and a cache of the cited pages, so foxbench judges in two steps through
// the judge interface instead: the task's criteria, then each criterion
// against the answer and the hosts the agent reached. The 120 test tasks are
// private. `success` needs every criterion; `score` is the share met.
import { evidence, GRADE, parseGrades, rawFile, rawReady, startPage } from "./odysseys.js";
import { judgeWith, type Judge } from "./judge.js";
import { pickSubset } from "./subsets.js";
import { OPEN_WEB_NOTE } from "./open-web.js";
import type { BenchContext, Benchmark, Case, Episode } from "./types.js";

/** The `OSU-NLP-Group/Mind2Web-2` commit of 2026-02-18 (MIT). */
export const M2W2_REF = "1fcbfda98bf5c669daa2ed0a27f1d2f2499475ee";
export const DEV_TASKS = ["ad_patent", "animation_movies", "buy_monitor", "find_parks", "llava_commit", "lol_sylas", "nyc_sport_event", "overleaf_template", "spotify_artists", "yu_lineage"];
const source = (name: string) => ({ repo: "OSU-NLP-Group/Mind2Web-2", ref: M2W2_REF, path: `eval_scripts/dev_set/${name}.py` });

const CRITERIA = `You read a research task and list what a complete, correct answer must contain. Each criterion is one checkable requirement the task states: an item to find, a count (at least N), a property each item must have, a link to a source. Do not add requirements the task does not state.
Reply with "**Criteria**:" and a numbered list, one criterion per line, no explanations.`;

interface Task { id: string; text: string }
const started = new WeakMap<Episode, Task>();

export const mind2web2Benchmark = (): Benchmark => {
  let tasks: Task[] = [];
  const read = async (ctx: BenchContext) => {
    tasks = await Promise.all(DEV_TASKS.map(async (name) => {
      const script = await rawFile(ctx, source(name));
      const id = /TASK_ID = "([^"]+)"/.exec(script)?.[1];
      const text = /TASK_DESCRIPTION = """([\s\S]*?)"""/.exec(script)?.[1]?.trim();
      if (!id || !text) throw new Error(`mind2web2: ${name}.py has no TASK_ID or TASK_DESCRIPTION`);
      return { id, text };
    }));
  };
  return {
    id: "mind2web2",
    title: "Mind2Web 2 (dev)",
    upstream: { repo: "https://github.com/OSU-NLP-Group/Mind2Web-2", ref: M2W2_REF, paper: "https://arxiv.org/abs/2506.21506" },
    licence: { code: "MIT", data: "MIT (scripts); CC-BY-4.0 (HF dataset, not used)", mode: "fetch-at-run" },
    where: "live-web",
    measures: ["task", "info-seeking"],
    scoring: "llm",
    check: (ctx) => rawReady(ctx, source(DEV_TASKS[0]!)),
    async load(ctx, subset) {
      await read(ctx);
      const all: Case[] = tasks.map((t) => ({ id: t.id, tags: ["dev"], judge: "llm", goal: t.text }));
      return pickSubset("mind2web2", all, subset);
    },
    async up(ctx) {
      await read(ctx);
      return { judges: ctx.judges ?? [] };
    },
    async start(_env, item) {
      const task = tasks.find((t) => t.id === item.id);
      if (!task) throw new Error(`mind2web2 has no case ${item.id}`);
      const page = await startPage(task.id, task.text);
      const episode: Episode = { url: page.url, goal: `${task.text}\n\n${OPEN_WEB_NOTE} Give the source link for every claim in your answer.`, startPath: "/", close: page.close };
      started.set(episode, task);
      return episode;
    },
    async judge(env, episode, output, trace) {
      const task = started.get(episode);
      if (!task) throw new Error("mind2web2 did not start this episode");
      // Each judge derives the criteria with its own model, then grades them (MW22).
      const staged = (env.judges as Judge[]).map((j): Judge => ({
        ...j,
        async ask() {
          const criteria = (await j.ask({ system: CRITERIA, prompt: `Task: ${task.text}` })).split(/Criteria\**:/i).at(-1)!.trim();
          const n = criteria.split("\n").filter((l) => /^\s*\d+[.)]/.test(l)).length;
          if (!n) throw new Error("the first step listed no criteria");
          const reply = await j.ask({ system: GRADE, prompt: `Task: ${task.text}\n\nItems:\n${criteria}\n\n${evidence(output, trace)}` });
          parseGrades(reply, n);
          return reply;
        },
      }));
      return judgeWith(staged, { system: GRADE, prompt: "" }, (reply) => parseGrades(reply));
    },
    down: async () => {},
    // The published rows are on the private test set, so none is on the dev tasks.
    baselines: [],
  };
};
