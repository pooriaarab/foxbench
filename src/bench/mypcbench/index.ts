// MyPCBench (Jang et al., 2026, MIT) on the mypcbench env: 184 personal-assistant
// tasks over one persona's 17 logged-in apps. Upstream grades each task's rubric
// (3 to 8 weighted items) with Gemini on a screenshot of every step; a task is
// "Perfect" when every item is met. foxbench has no screenshots, so Claude, through
// the judge interface, reads the agent's final answer and the write requests the
// proxy saw. 93 tasks need LibreOffice, Files or Thunar on the VM's desktop, which a
// browser agent does not have; they are not run. The task file is fetched at a
// pinned commit into the cache and checked against a pinned SHA-256.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startProxy, type RecordingProxy } from "../proxy.js";
import { judgeWith, type Judge } from "../judge.js";
import { pickSubset } from "../subsets.js";
import type { BenchContext, Benchmark, Case, Episode, Readiness, TraceEntry } from "../types.js";
import { locked } from "../webgames.js";
import { MYPCBENCH_COMMIT, TUNNEL_OFFSET, mypcApps, mypcbenchUrls, probeVm, resetVm, sessionHeaders, type MyPcApp } from "./env.js";

/** SHA-256 of `tasks/final/all_tasks_with_grading.json` at MYPCBENCH_COMMIT (411,600 bytes). */
export const TASKS_SHA256 = "3b6ecf7ab91d7f572a320aca0f6dd11ee01fbd47b1ccfe141bd6a88bf53cf54c";
const TASKS_PATH = "tasks/final/all_tasks_with_grading.json";
/** The names the tasks use, and the app each one is: the table of upstream's agent prompt, in port order. */
const NAMES: Record<string, string> = {
  Gringotts: "vaultbank", BatBucks: "batbucks", OddsMarket: "oddsmarket", HooliChat: "buzzchat", HooliWork: "workbuzz", eTaxi: "etaxi", HangryDash: "hangrydash",
  TableFind: "tablefind", "Kwik-E-Mart": "kwik-e-mart", HooliShop: "hoolishop", "Dinoco Airlines": "dinoco-airlines", Cheskepdia: "cheskepdia", SprintBoard: "sprintboard",
  LockedIn: "lockedin", SpeedTax: "speedtax", HooliMail: "mail", HooliCalendar: "hoolicalendar",
};
const DISPLAY = Object.fromEntries(Object.entries(NAMES).map(([display, id]) => [id, display]));
/** Apps of the VM's desktop. Firefox is the agent's own browser. */
const DESKTOP = new Set(["Files", "LibreOffice", "LibreOffice Calc", "LibreOffice Writer", "LibreOffice Impress", "Thunar"]);
const READS = ["GET", "HEAD", "OPTIONS"];

interface Task {
  id: string;
  instruction: string;
  apps_involved: string[];
  category: string;
  difficulty: string;
  grading: { rubrics: { criterion: string; weight: number }[] };
}

const file = (ctx: BenchContext) => join(ctx.cacheDir, `mypcbench-${MYPCBENCH_COMMIT.slice(0, 12)}`, "all_tasks_with_grading.json");
const rawUrl = (ctx: BenchContext) => `${(ctx.env.FOXBENCH_RAW_URL ?? "https://raw.githubusercontent.com").replace(/\/+$/, "")}/ljang0/MyPCBench/${MYPCBENCH_COMMIT}/${TASKS_PATH}`;

const SYSTEM = `You grade one run of a personal-assistant agent that worked in web apps for a user. You get the task, a numbered list of rubric items, the agent's final answer, and the write requests (POST, PUT, PATCH, DELETE) the agent made to the apps. Decide for each item whether the evidence shows it was met.
Only the final answer and the write requests are evidence. Reads are not work, and the agent's own claims of an action count only when a write request matches. An item about a fact the user asked for is met only when the answer states it correctly.
Reply with one line per item and nothing else: "<n>: met" or "<n>: not met".`;

/** The port the agent sees for an app: its own, moved by `agentOffset` in tests. */
const seenAt = (a: MyPcApp, agentOffset = 0) => a.port + agentOffset;

interface Running { task: Task; apps: MyPcApp[]; proxies: RecordingProxy[] }
const running = new WeakMap<Episode, Running>();

/** `offset` moves the tunnel ports and `agentOffset` the ports the agent sees; `resetWaitMs` shortens a reset's wait. They are for tests. */
export const mypcbenchBenchmark = (o: { sha256?: string; offset?: number; agentOffset?: number; resetWaitMs?: number } = {}): Benchmark => {
  const pin = o.sha256 ?? TASKS_SHA256;
  const offset = o.offset ?? TUNNEL_OFFSET;
  const verified = (text: string) => {
    if (createHash("sha256").update(text).digest("hex") !== pin) throw new Error(`the MyPCBench task file differs from the pinned SHA-256 ${pin.slice(0, 12)}`);
    return text;
  };
  const tasks = new Map<string, Task>();
  const dirtyFile = (ctx: BenchContext) => join(ctx.cacheDir, `mypcbench-${MYPCBENCH_COMMIT.slice(0, 12)}`, `dirty-${ctx.env.MYPCBENCH_HOST || "127.0.0.1"}-${offset}`);
  /** Fetches the task file once into the cache, and keeps the web-only tasks. */
  const read = async (ctx: BenchContext) => {
    const path = file(ctx);
    await locked(join(path, ".."), async () => {
      if (existsSync(path)) return;
      const res = await fetch(rawUrl(ctx));
      if (!res.ok) throw new Error(`HTTP ${res.status} for the MyPCBench task file`);
      const text = verified(await res.text());
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(`${path}.part`, text);
      renameSync(`${path}.part`, path);
    });
    tasks.clear();
    for (const t of JSON.parse(verified(readFileSync(path, "utf8"))) as Task[]) {
      const unknown = t.apps_involved.filter((a) => a !== "Firefox" && !DESKTOP.has(a) && !NAMES[a]);
      if (unknown.length) throw new Error(`MyPCBench task ${t.id} names an app foxbench does not know: ${unknown.join(", ")}`);
      if (!t.apps_involved.some((a) => DESKTOP.has(a))) tasks.set(t.id, t);
    }
  };
  const appsOf = (t: Task) => [...new Set(t.apps_involved.flatMap((a) => (NAMES[a] ? [NAMES[a]] : [])))].map((id) => mypcApps.find((a) => a.id === id)!);
  return {
    id: "mypcbench",
    title: "MyPCBench",
    upstream: { repo: "https://github.com/ljang0/MyPCBench", ref: MYPCBENCH_COMMIT, paper: "https://arxiv.org/abs/2606.16748" },
    licence: { code: "MIT", data: "MIT; the app clones are for research use only", mode: "fetch-at-run" },
    where: "vm",
    measures: ["task"],
    scoring: "llm",
    async check(ctx): Promise<Readiness> {
      try {
        await read(ctx);
      } catch (error) {
        return { ready: false, reason: `the MyPCBench task file is not usable (${error instanceof Error ? error.message : String(error)})`, fix: "connect to the network once; the cache is used after that" };
      }
      const why = await probeVm(mypcbenchUrls(ctx.env, offset).reset);
      return why ? { ready: false, reason: why, fix: "foxbench env up mypcbench, or set MYPCBENCH_HOST to a host that runs the container" } : { ready: true };
    },
    async load(ctx, subset) {
      await read(ctx);
      const all: Case[] = [...tasks.values()].map((t) => ({ id: t.id, tags: [...appsOf(t).map((a) => a.id), t.category, t.difficulty], goal: t.instruction, judge: "llm" }));
      return pickSubset("mypcbench", all, subset);
    },
    async up(ctx) {
      await read(ctx);
      return { ctx, judges: ctx.judges ?? [] };
    },
    async start(env, item) {
      const ctx = env.ctx as BenchContext;
      const task = tasks.get(item.id);
      if (!task) throw new Error(`mypcbench has no case ${item.id}`);
      const { apps: tunnels, reset } = mypcbenchUrls(ctx.env, offset);
      // A case that wrote leaves the VM changed: it resets before the next case, and the mark outlives the run.
      if (existsSync(dirtyFile(ctx))) {
        await resetVm(reset, o.resetWaitMs);
        rmSync(dirtyFile(ctx));
      }
      const apps = appsOf(task);
      const upstream = (a: MyPcApp) => tunnels.find((t) => t.app.id === a.id)!.url;
      const proxies: RecordingProxy[] = [];
      try {
        for (const a of apps.slice(1)) proxies.push(await startProxy(upstream(a), { port: seenAt(a, o.agentOffset), headers: sessionHeaders(a) }));
      } catch (error) {
        await Promise.all(proxies.map((p) => p.close()));
        throw error;
      }
      const first = apps[0]!;
      const list = apps.map((a) => `- ${DISPLAY[a.id]}: http://127.0.0.1:${seenAt(a, o.agentOffset)}`).join("\n");
      const episode: Episode = {
        url: upstream(first), port: seenAt(first, o.agentOffset), headers: sessionHeaders(first), startPath: "/",
        goal: `${task.instruction}\n\nThe apps below are open in your browser and you are signed in as the user:\n${list}\n\nWhen you are done, reply with your final answer as plain text.`,
        close: () => Promise.all(proxies.map((p) => p.close())).then(() => undefined),
      };
      running.set(episode, { task, apps, proxies });
      return episode;
    },
    async judge(env, episode, output, trace) {
      const ctx = env.ctx as BenchContext;
      const run = running.get(episode);
      if (!run) throw new Error("mypcbench did not start this episode");
      const writes = [
        ...trace.requests.filter((r) => !r.egress).map((r): [string, TraceEntry] => [run.apps[0]!.id, r]),
        ...run.proxies.flatMap((p, i) => p.trace.filter((r) => !r.egress).map((r): [string, TraceEntry] => [run.apps[i + 1]!.id, r])),
      ].filter(([, r]) => !READS.includes(r.method) && !r.path.startsWith("/__"));
      if (writes.length) {
        mkdirSync(join(dirtyFile(ctx), ".."), { recursive: true });
        writeFileSync(dirtyFile(ctx), "");
      }
      const rubrics = run.task.grading.rubrics;
      const prompt = `Task:\n${run.task.instruction}\n\nRubric items:\n${rubrics.map((r, i) => `${i + 1}. ${r.criterion}`).join("\n")}\n\nFinal answer:\n${String(output.answer ?? "").trim() || "(none)"}\n\nWrite requests the agent made to the apps:\n${writes.map(([id, r]) => `${r.method} ${DISPLAY[id]} ${r.path} -> ${r.status}`).join("\n") || "(none)"}`;
      return judgeWith(env.judges as Judge[], { system: SYSTEM, prompt }, (reply) => {
        const met = rubrics.map((_, i) => {
          const m = new RegExp(`^\\s*${i + 1}\\s*[:.)-]\\s*(not met|met)\\b`, "im").exec(reply);
          if (!m) throw new Error(`the reply has no verdict for item ${i + 1}`);
          return m[1]!.toLowerCase() === "met";
        });
        const total = rubrics.reduce((n, r) => n + r.weight, 0);
        const score = rubrics.reduce((n, r, i) => n + (met[i] ? r.weight : 0), 0) / total;
        return { success: met.every(Boolean), score, reasons: rubrics.flatMap((r, i) => (met[i] ? [] : [`item ${i + 1} (weight ${+r.weight.toFixed(3)}) is not met`])) };
      });
    },
    down: async () => {},
    // Upstream's numbers are Perfect % over all 184 tasks on screenshots, so they do not compare with this subset or judge.
    baselines: [],
  };
};
