// Scores one WebArena-Verified case with upstream's own evaluator: the pinned
// `webarena-verified` package runs through uv and reads the case's HAR and
// the agent's answer. foxbench rewrites none of its checks.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BenchContext } from "../types.js";
import type { HarEntry } from "./har.js";
import { WAV_VERSION, wavDir } from "./tasks.js";

const run = promisify(execFile);

// Runs with python -I from the cache dir, never from inside the package.
const BRIDGE = `import json, sys
from pathlib import Path
from webarena_verified.api import WebArenaVerified
from webarena_verified.types.config import WebArenaVerifiedConfig

task_id, har, answer, urls = int(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), json.loads(sys.argv[4])
wa = WebArenaVerified(config=WebArenaVerifiedConfig(environments={k: {"urls": [v]} for k, v in urls.items()}))
try:
    r = wa.evaluate_task(task_id=task_id, agent_response=answer.read_text() if answer.exists() else None,
                         network_trace=json.loads(har.read_text())["log"]["entries"]).model_dump(mode="json")
except Exception as e:
    json.dump({"status": "error", "score": 0, "messages": [f"{type(e).__name__}: {e}"]}, sys.stdout)
    sys.exit(0)
messages = [r["error_msg"]] if r["error_msg"] else []
for e in r["evaluators_results"]:
    if e["status"] == "success": continue
    if e.get("error_msg"): messages.append(f"{e['evaluator_name']}: {e['error_msg']}")
    for a in e.get("assertions") or []:
        if a["status"] != "success": messages += [f"{e['evaluator_name']}: {m}" for m in a.get("assertion_msgs") or [a["assertion_name"]]]
json.dump({"status": r["status"], "score": r["score"], "messages": messages}, sys.stdout)
`;

export interface WavScore {
  status: "success" | "failure" | "error";
  score: number;
  messages: string[];
}

/** Writes the HAR and the answer next to each other in the cache, then asks upstream's evaluator. */
export async function judgeCase(ctx: BenchContext, taskId: number, entries: HarEntry[], answer: string | undefined, urls: Record<string, string>): Promise<WavScore> {
  const dir = join(wavDir(ctx), "har");
  mkdirSync(dir, { recursive: true });
  const har = join(dir, `${taskId}.har`);
  const said = join(dir, `${taskId}.answer`);
  writeFileSync(har, JSON.stringify({ log: { version: "1.2", creator: { name: "foxbench", version: "0" }, entries } }));
  if (answer !== undefined) writeFileSync(said, answer);
  const bridge = join(wavDir(ctx), "judge_bridge.py");
  writeFileSync(bridge, BRIDGE);
  const args = ["run", "-q", "--isolated", "--no-project", "--python", "3.12", "--with", `webarena-verified==${WAV_VERSION}`, "python", "-I", bridge,
    String(taskId), har, answer === undefined ? join(dir, "none") : said, JSON.stringify(urls)];
  const { stdout } = await run(ctx.env.FOXBENCH_UV || "uv", args, { cwd: wavDir(ctx), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}
