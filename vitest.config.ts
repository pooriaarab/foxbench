import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Tests start Firefox, site servers and the CLI; 5 s is too short on a 4-vCPU CI runner.
    testTimeout: 30_000,
    // The startup scripts write Docker's daemon.json; a test must not write the real /etc/docker.
    env: { DOCKER_DAEMON_JSON: join(tmpdir(), "fbn-test-daemon.json") },
  },
});
