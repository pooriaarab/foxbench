import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // Tests start Firefox, site servers and the CLI; 5 s is too short on a 4-vCPU CI runner.
    testTimeout: 30_000,
  },
});
