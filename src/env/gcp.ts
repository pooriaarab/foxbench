// The GCP provider: every call shells out to gcloud (FOXBENCH_GCLOUD). The
// project, zone and account come from the caller; nothing here names one.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudEnv } from "./envs.js";

export interface Gcp {
  project: string;
  zone: string;
  account?: string;
}
export interface Vm {
  name: string;
  status: string;
  zone: string;
  env: string;
}

export const LABEL = "foxbench-env";
const gcloud = () => process.env.FOXBENCH_GCLOUD || "gcloud";

function scope(gcp: Gcp): string[] {
  return [`--project=${gcp.project}`, ...(gcp.account ? [`--account=${gcp.account}`] : [])];
}

function call(gcp: Gcp, args: string[]): string {
  const r = spawnSync(gcloud(), [...args, ...scope(gcp)], { encoding: "utf8" });
  if (r.error) throw new Error(`Could not run ${gcloud()}: ${r.error.message}. Install gcloud or set FOXBENCH_GCLOUD.`);
  if (r.status !== 0) throw new Error(`gcloud ${args.slice(0, 3).join(" ")} failed:\n${r.stderr.trim()}`);
  return r.stdout;
}

export function createVm(gcp: Gcp, env: CloudEnv, name: string, opts: { spot: boolean; maxRun: string }): void {
  const dir = mkdtempSync(join(tmpdir(), "fbn-startup-"));
  const script = join(dir, `${env.name}.startup.sh`);
  writeFileSync(script, env.startup);
  try {
    call(gcp, ["compute", "instances", "create", name, `--zone=${gcp.zone}`, `--machine-type=${env.machineType}`,
      "--image-family=debian-12", "--image-project=debian-cloud", `--boot-disk-size=${env.diskGb}GB`,
      ...(env.diskType ? [`--boot-disk-type=${env.diskType}`] : []),
      `--labels=${LABEL}=${env.name}`, "--tags=foxbench", "--no-address",
      ...(env.nestedVirt ? ["--enable-nested-virtualization"] : []),
      `--provisioning-model=${opts.spot ? "SPOT" : "STANDARD"}`,
      `--max-run-duration=${opts.maxRun}`, "--instance-termination-action=DELETE",
      `--metadata-from-file=startup-script=${script}`, "--format=json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True for the create errors that mean one zone has no VMs of that type left. */
export const zoneExhausted = (error: unknown): boolean =>
  /ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources available/.test(error instanceof Error ? error.message : String(error));

/** The zones of `region`, by name. */
export function listZones(gcp: Gcp, region: string): string[] {
  return call(gcp, ["compute", "zones", "list", `--filter=region:${region}`, "--format=value(name)"]).split("\n").map((z) => z.trim()).filter(Boolean).toSorted();
}

/** VMs with the foxbench label, in every zone; only `env`'s when given. */
export function listVms(gcp: Gcp, env?: string): Vm[] {
  const filter = env ? `labels.${LABEL}=${env}` : `labels.${LABEL}:*`;
  const rows = JSON.parse(call(gcp, ["compute", "instances", "list", `--filter=${filter}`, "--format=json"]) || "[]") as
    { name: string; status: string; zone: string; labels?: Record<string, string> }[];
  // Check the label here too: a VM without it is not ours to touch.
  return rows.filter((r) => r.labels?.[LABEL] && (!env || r.labels[LABEL] === env))
    .map((r) => ({ name: r.name, status: r.status, zone: r.zone.split("/").pop()!, env: r.labels![LABEL]! }));
}

export function deleteVm(gcp: Gcp, vm: Vm): void {
  call(gcp, ["compute", "instances", "delete", vm.name, `--zone=${vm.zone}`, "--quiet"]);
}

/** Starts `gcloud compute start-iap-tunnel` in its own process group, logging to `log`. */
export function startTunnel(gcp: Gcp, vm: string, port: { remote: number; local: number }, log: string): number {
  const fd = openSync(log, "w");
  const child = spawn(gcloud(), ["compute", "start-iap-tunnel", vm, String(port.remote), `--local-host-port=127.0.0.1:${port.local}`,
    `--zone=${gcp.zone}`, ...scope(gcp)], { detached: true, stdio: ["ignore", fd, fd] });
  child.on("error", () => {});
  child.unref();
  if (!child.pid) throw new Error(`Could not run ${gcloud()}. Install gcloud or set FOXBENCH_GCLOUD.`);
  return child.pid;
}
