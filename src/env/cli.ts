// foxbench env up|down|status <env>: a VM per environment, reached through
// an IAP tunnel on 127.0.0.1. State lives in ~/.foxbench/env/<env>.json.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { dockerDown, dockerStatus, dockerUp } from "./docker.js";
import { cloudEnvs, type CloudEnv } from "./envs.js";
import { createVm, deleteVm, listVms, listZones, startTunnel, zoneExhausted, type Gcp } from "./gcp.js";

const USAGE = `Usage:
  foxbench env up <env> [--no-spot] [--max-run-duration 4h] [--local-port-offset N] [--zones a,b] [gcp options]
  foxbench env down <env> [gcp options]
  foxbench env status [<env>] [gcp options]
  foxbench env up|down|status <env> --provider docker   (local Docker, for the envs that have it)
GCP options: --project (FOXBENCH_GCP_PROJECT), --zone (FOXBENCH_GCP_ZONE), --account (FOXBENCH_GCP_ACCOUNT).
A zone with no VMs left makes up try the region's other zones, in name order; --zones tries only the zones given
(a short name such as b takes the region of --zone).
Envs: ${cloudEnvs.map((e) => e.name).join(", ")}.`;

interface State {
  env: string;
  vm: string;
  zone: string;
  tunnels: { remote: number; local: number; pid: number; log: string }[];
}

class UsageError extends Error {}

const stateDir = () => join(homedir(), ".foxbench", "env");
const stateFile = (env: string) => join(stateDir(), `${env}.json`);
const readState = (env: string): State | null => (existsSync(stateFile(env)) ? JSON.parse(readFileSync(stateFile(env), "utf8")) : null);
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True only for a live `gcloud ... start-iap-tunnel`: a pid in an old state file may belong to another program now. */
function isTunnel(pid: number): boolean {
  return pid > 0 && alive(pid) && /start-iap-tunnel/.test(spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout);
}

/** Stops the tunnel process groups in `state`, and nothing else. */
function stopTunnels(state: State | null): void {
  for (const t of state?.tunnels ?? []) if (isTunnel(t.pid)) process.kill(-t.pid);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

/** Restarts the tunnel until gcloud says it listens: its test fails while the VM boots. */
async function openTunnel(gcp: Gcp, vm: string, port: { remote: number; local: number }, log: string, minutes: number, started: (pid: number) => void): Promise<number> {
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    const pid = startTunnel(gcp, vm, port, log);
    started(pid);
    while (alive(pid) && Date.now() < deadline) {
      // gcloud binds the local port only once its tunnel test passes. Its "Listening on port"
      // line can stay in its stdout buffer when stdout is a file, so the log is not read.
      if (!(await portFree(port.local))) return pid;
      await sleep(200);
    }
    if (alive(pid)) process.kill(-pid);
    else await sleep(5000);
  }
  throw new Error(`The tunnel to ${vm}:${port.remote} did not open in ${minutes} minutes. See ${log}. Run foxbench env down to delete the VM.`);
}

/** Creates the VM in the first zone with room; only an exhausted zone moves on to the next. Returns that zone. */
function createInSomeZone(gcp: Gcp, env: CloudEnv, vm: string, opts: { spot: boolean; maxRun: string }, zones?: string[]): string {
  const queue = zones ? [...zones] : [gcp.zone];
  let listed = !!zones;
  for (let i = 0; i < queue.length; i++) {
    try {
      createVm({ ...gcp, zone: queue[i]! }, env, vm, opts);
      return queue[i]!;
    } catch (error) {
      if (!zoneExhausted(error)) throw error;
      console.error(`Zone ${queue[i]} is exhausted for ${env.machineType}.`);
      if (!listed) {
        listed = true;
        queue.push(...listZones(gcp, gcp.zone.replace(/-[a-z]$/, "")).filter((z) => z !== gcp.zone));
      }
    }
  }
  throw new Error(`Every zone is exhausted for ${env.machineType}: ${queue.join(", ")}.${opts.spot ? "" : " Try a Spot VM: drop --no-spot."}`);
}

async function up(base: Gcp, name: string, spot: boolean, maxRun: string, offset: number, zones?: string[]): Promise<void> {
  let gcp = base;
  const found = cloudEnvs.find((e) => e.name === name);
  if (!found) throw new UsageError(`Unknown env "${name}".`);
  const env = { ...found, ports: found.ports.map((p) => ({ ...p, local: p.local + offset })) };
  if (!/^\d+[smhd]$/.test(maxRun)) throw new UsageError(`--max-run-duration must look like 4h or 90m, not ${maxRun}.`);
  const old = readState(name);
  if (old) {
    if (listVms(gcp, name).length) throw new Error(`${name} is up already (${stateFile(name)}). Run foxbench env down ${name} first.`);
    // No VM: it was preempted or deleted, and its tunnels from that run may still hold the ports.
    stopTunnels(old);
    // A stopped tunnel frees its port a moment after the signal; under load that moment is long.
    const until = Date.now() + 10_000;
    for (const t of old.tunnels) while (!(await portFree(t.local)) && Date.now() < until) await sleep(100);
    rmSync(stateFile(name), { force: true });
  }
  for (const p of env.ports) if (!(await portFree(p.local))) throw new Error(`Local port ${p.local} is in use; ${name} tunnels to it. Free it first.`);
  const vm = `foxbench-${name}-${randomBytes(3).toString("hex")}`;
  const zone = createInSomeZone(gcp, env, vm, { spot, maxRun }, zones);
  gcp = { ...gcp, zone };
  // The VM exists from here on, so write the state before the tunnel: down must find it.
  mkdirSync(stateDir(), { recursive: true });
  const state: State = { env: name, vm, zone, tunnels: [] };
  writeFileSync(stateFile(name), JSON.stringify(state, null, 2));
  for (const port of env.ports) {
    const log = join(stateDir(), `${name}.${port.local}.log`);
    // Record each pid when the process starts: if `up` dies while the tunnel opens, `down` still finds it.
    const tunnel = { ...port, pid: 0, log };
    state.tunnels.push(tunnel);
    tunnel.pid = await openTunnel(gcp, vm, port, log, env.bootMinutes, (pid) => {
      tunnel.pid = pid;
      writeFileSync(stateFile(name), JSON.stringify(state, null, 2));
    });
  }
  console.log(`${name} is up on ${vm} in ${zone} (${spot ? "Spot" : "standard"}, deleted after ${maxRun}).`);
  for (const t of state.tunnels) console.log(`  http://127.0.0.1:${t.local} -> ${vm}:${t.remote}`);
}

function down(gcp: Gcp, name: string): void {
  const state = readState(name);
  stopTunnels(state);
  const vms = listVms(gcp, name);
  for (const vm of vms) {
    deleteVm(gcp, vm);
    console.log(`Deleted ${vm.name} (${vm.zone}).`);
  }
  if (!vms.length) console.log(`No VMs with label foxbench-env=${name}.`);
  rmSync(stateFile(name), { force: true });
}

function status(gcp: Gcp, name?: string): void {
  const vms = listVms(gcp, name);
  for (const vm of vms) console.log(`${vm.name}  ${vm.env}  ${vm.status}  ${vm.zone}`);
  const names = name ? [name] : existsSync(stateDir()) ? readdirSync(stateDir()).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  const tunnels = names.flatMap((n) => readState(n)?.tunnels.map((t) => ({ ...t, env: n, vm: readState(n)!.vm })) ?? []);
  for (const t of tunnels) console.log(`tunnel ${t.env} 127.0.0.1:${t.local} -> ${t.vm}:${t.remote} ${alive(t.pid) ? "up" : "down"}`);
  if (!vms.length && !tunnels.length) console.log("none");
}

export async function envCli(argv: string[]): Promise<void> {
  try {
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, allowNegative: true, options: {
      project: { type: "string" }, zone: { type: "string" }, zones: { type: "string" }, account: { type: "string" },
      provider: { type: "string", default: "gcp" }, spot: { type: "boolean", default: true }, "max-run-duration": { type: "string", default: "4h" }, "local-port-offset": { type: "string", default: "0" }, help: { type: "boolean", short: "h" },
    } });
    if (values.help) return console.log(USAGE);
    const [command, name] = positionals;
    const offset = Number(values["local-port-offset"]);
    if (!Number.isInteger(offset)) throw new UsageError(`--local-port-offset must be a whole number, not ${values["local-port-offset"]}.`);
    const project = values.project || process.env.FOXBENCH_GCP_PROJECT;
    const zone = values.zone || process.env.FOXBENCH_GCP_ZONE;
    const account = values.account || process.env.FOXBENCH_GCP_ACCOUNT || undefined;
    if (!["up", "down", "status"].includes(command ?? "")) throw new UsageError(command ? `Unknown env command "${command}".` : "Give up, down or status.");
    if (command !== "status" && !name) throw new UsageError(`Give an env: foxbench env ${command} <env>.`);
    if (!["gcp", "docker"].includes(values.provider)) throw new UsageError(`--provider is gcp or docker, not ${values.provider}.`);
    if (values.provider === "docker") {
      const env = cloudEnvs.find((e) => e.name === name);
      if (!env?.local) throw new UsageError(name ? `${name} has no local Docker mode.` : "Give an env with a local Docker mode.");
      if (command === "up") dockerUp(env);
      else if (command === "down") dockerDown();
      else dockerStatus();
      return;
    }
    if (!project) throw new UsageError("Give a GCP project with --project or FOXBENCH_GCP_PROJECT.");
    if (command === "up" && !zone && !values.zones) throw new UsageError("Give a GCP zone with --zone or FOXBENCH_GCP_ZONE, or zones with --zones.");
    const zones = values.zones?.split(",").map((z) => z.trim()).filter(Boolean).map((z) => {
      if (z.includes("-")) return z;
      if (!zone) throw new UsageError(`--zones ${z} needs a full zone name, or --zone for its region.`);
      return `${zone.replace(/-[a-z]$/, "")}-${z}`;
    });
    if (values.zones !== undefined && !zones?.length) throw new UsageError("--zones needs zone names, like a,b or us-central1-a,us-central1-b.");
    const gcp: Gcp = { project, zone: zones?.[0] ?? zone ?? "", account };
    if (command === "up") await up(gcp, name!, values.spot, values["max-run-duration"], offset, zones);
    else if (command === "down") down(gcp, name!);
    else status(gcp, name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(error instanceof UsageError || error instanceof TypeError ? `${message}\n${USAGE}` : message);
    process.exitCode = error instanceof UsageError || error instanceof TypeError ? 2 : 1;
  }
}
