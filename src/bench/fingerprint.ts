// The run fingerprint: what a reader needs to judge a speed number. Measured
// facts come from this machine; what only the operator knows about the agent
// comes from FOXBENCH_* variables and stays under `reported`. Nothing here
// names a person: no hostname, user name or path.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem, type } from "node:os";
import type { Judge } from "./judge.js";

export interface Fingerprint {
  /** The hardware model, for example "Mac15,9", or null. */
  machine: string | null;
  chip: string | null;
  ramGb: number;
  os: string;
  firefox: string | null;
  foxbench: string;
  /** Speed claims come only from serial runs (plan section 7.1). */
  serial: boolean;
  workers: number;
  /** The LLM judges of the run: an LLM-judged score depends on the judge model (J6). */
  judges: { name: string; model: string; where: Judge["where"] }[];
  reported: { agentVersion: string | null; model: string | null; quant: string | null; llamaFlags: string | null; network: string | null };
}

const read = (run: () => string): string | null => {
  try {
    return run().trim() || null;
  } catch {
    return null;
  }
};
const versions = new Map<string, string | null>();

export function fingerprint(options: { firefox?: string; env: NodeJS.ProcessEnv; workers?: number; judges?: Judge[] }): Fingerprint {
  const firefox = options.firefox ?? "firefox";
  if (!versions.has(firefox)) versions.set(firefox, read(() => execFileSync(firefox, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] })));
  const workers = options.workers ?? 1;
  const env = (name: string) => options.env[name]?.trim() || null;
  return {
    machine: platform() === "darwin" ? read(() => execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" })) : read(() => readFileSync("/sys/devices/virtual/dmi/id/product_name", "utf8")),
    chip: cpus()[0]?.model.trim() ?? null,
    ramGb: Math.round(totalmem() / 2 ** 30),
    os: `${type()} ${release()} ${arch()}`,
    firefox: versions.get(firefox) ?? null,
    foxbench: (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version,
    serial: workers === 1,
    workers,
    judges: (options.judges ?? []).map((j) => ({ name: j.name, model: j.model, where: j.where })),
    reported: { agentVersion: env("FOXBENCH_AGENT_VERSION"), model: env("FOXBENCH_MODEL"), quant: env("FOXBENCH_QUANT"), llamaFlags: env("FOXBENCH_LLAMA_FLAGS"), network: env("FOXBENCH_NETWORK") },
  };
}
