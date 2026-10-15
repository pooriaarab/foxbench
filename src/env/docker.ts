// The local-Docker provider: the env's own script runs on this machine, and its
// containers are found by the compose project label, so down never touches another container.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { WEBMALL_PROJECT } from "../bench/webmall/env.js";
import type { CloudEnv } from "./envs.js";

const PROJECT = `label=com.docker.compose.project=${WEBMALL_PROJECT}`;

function docker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.error) throw new Error(`Could not run docker: ${r.error.message}. Install Docker, or use --provider gcp.`);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed:\n${r.stderr.trim()}`);
  return r.stdout;
}

export function dockerUp(env: CloudEnv): void {
  if (!env.local) throw new Error(`${env.name} has no local Docker mode.`);
  docker(["version", "--format", "{{.Server.Version}}"]);
  const cache = process.env.FOXBENCH_CACHE ?? join(homedir(), ".cache", "foxbench");
  const r = spawnSync("sh", ["-c", env.local(cache)], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`The ${env.name} script failed (exit ${r.status}). It is safe to run again.`);
}

/** Removes the project's containers and network. The volumes stay: restoring them is the slow part. */
export function dockerDown(): void {
  const ids = docker(["ps", "-aq", "--filter", PROJECT]).split("\n").filter(Boolean);
  if (ids.length) docker(["rm", "-f", ...ids]);
  for (const net of docker(["network", "ls", "-q", "--filter", PROJECT]).split("\n").filter(Boolean)) docker(["network", "rm", net]);
  console.log(ids.length ? `Removed ${ids.length} containers.` : `No containers in project ${WEBMALL_PROJECT}.`);
}

export function dockerStatus(): void {
  const rows = docker(["ps", "-a", "--filter", PROJECT, "--format", "{{.Names}}  {{.Status}}  {{.Ports}}"]).trim();
  console.log(rows || "none");
}
