#!/usr/bin/env node
// A fake docker for tests/webmall-env.test.ts: logs argv to FAKE_LOG, fails a call with the
// word FAKE_DOCKER_FAIL, prints FAKE_DOCKER_PS for `ps`. Nothing runs.
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cmd: "docker", argv })}\n`);
if (process.env.FAKE_DOCKER_FAIL && argv.includes(process.env.FAKE_DOCKER_FAIL)) process.exit(1);
if (argv[0] === "ps") console.log(process.env.FAKE_DOCKER_PS ?? "");
