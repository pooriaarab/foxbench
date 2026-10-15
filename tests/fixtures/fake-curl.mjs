#!/usr/bin/env node
// A fake curl for tests/webmall-env.test.ts: the source download prints FAKE_SOURCE, a backup
// download writes a gzip to its -o path (garbage with FAKE_CORRUPT), a probe succeeds. Calls go to FAKE_LOG.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cmd: "curl", argv })}\n`);
const url = argv.at(-1);
const out = argv[argv.indexOf("-o") + 1];
if (url.includes("codeload.github.com")) process.stdout.write(readFileSync(process.env.FAKE_SOURCE));
else if (out && out !== "/dev/null") writeFileSync(out, process.env.FAKE_CORRUPT ? "not gzip" : gzipSync("backup"));
