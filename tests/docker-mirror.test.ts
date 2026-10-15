// Tests for the Docker Hub mirror in the GCP startup scripts: every env that pulls from Docker Hub sets Google's mirror before its first pull.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerMirror } from "../src/env/mirror.js";
import { cloudEnvs } from "../src/env/envs.js";

/** Runs the snippet with a fake systemctl that records its calls; returns what it did. */
function run(dir: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> ${dir}/calls\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  const r = spawnSync("sh", ["-ec", dockerMirror()], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_DAEMON_JSON: join(dir, "daemon.json") } });
  expect(r.status, r.stderr).toBe(0);
}
const calls = (dir: string) => readFileSync(join(dir, "calls"), "utf8").trim().split("\n");

describe("DM1 the mirror is set before Docker's first pull", () => {
  it("writes Google's mirror to daemon.json and restarts Docker once; a second boot restarts nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fbn-mirror-"));
    run(dir);
    expect(JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"))).toEqual({ "registry-mirrors": ["https://mirror.gcr.io"] });
    expect(calls(dir)).toEqual(["systemctl enable --now docker", "systemctl restart docker"]);
    run(dir);
    expect(calls(dir).slice(2)).toEqual(["systemctl enable --now docker"]);
  });

  it("is in the startup script of every env that pulls from Docker Hub, ahead of its first pull or run", () => {
    const hub = ["wav-core", "wav-full", "suitecrm", "mypcbench"];
    for (const name of hub) {
      const script = cloudEnvs.find((e) => e.name === name)!.startup;
      const at = script.indexOf(dockerMirror());
      expect(at, name).toBeGreaterThan(-1);
      expect(script.search(/docker (pull|run)/), name).toBeGreaterThan(at);
    }
  });
});
