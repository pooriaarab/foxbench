// Builds dist/ once before any test file runs. The CLI tests spawn
// dist/cli.js, and vitest runs files in parallel: a build per file let one
// file run the CLI while another rewrote it, and the CLI exited 1 at random.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export default function setup() {
  const root = join(import.meta.dirname, "..");
  const built = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8" });
  if (built.status !== 0) throw new Error(built.stdout + built.stderr);
}
