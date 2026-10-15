#!/usr/bin/env node
// A fake gcloud for tests/env.test.ts. It appends its argv (and the startup
// script it was given) to FAKE_GCLOUD_LOG as one JSON line, then acts:
// FAKE_GCLOUD_FAIL=<word> fails any call that has that word, `list` prints
// FAKE_GCLOUD_LIST (a JSON file) and a tunnel binds its local port, as gcloud
// does once its test passes, and stays up until it is killed. With
// FAKE_GCLOUD_NOBIND=1 a tunnel stays up without binding, as gcloud does while its test fails.
// FAKE_GCLOUD_SLOWSTOP=<ms> a tunnel holds its port that long after SIGTERM, as a loaded machine does.
// FAKE_GCLOUD_EXHAUSTED=<zone,zone> makes `instances create` in those zones fail with FAKE_GCLOUD_EXHAUSTED_MSG
// (default ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS). `zones list` prints FAKE_GCLOUD_ZONES, comma separated, one per line.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";

const argv = process.argv.slice(2);
const script = argv.find((a) => a.startsWith("--metadata-from-file=startup-script="));
appendFileSync(process.env.FAKE_GCLOUD_LOG, `${JSON.stringify({ argv, script: script && readFileSync(script.split("=")[2], "utf8") })}\n`);
const fail = process.env.FAKE_GCLOUD_FAIL;
if (fail && argv.includes(fail)) {
  process.stderr.write("ERROR: (gcloud.compute.instances.create) Quota 'SPOT_CPUS' exceeded.\n");
  process.exit(1);
}
const zone = argv.find((a) => a.startsWith("--zone="))?.slice(7);
if (argv.includes("create") && zone && (process.env.FAKE_GCLOUD_EXHAUSTED ?? "").split(",").includes(zone)) {
  process.stderr.write(`ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - ${process.env.FAKE_GCLOUD_EXHAUSTED_MSG ?? "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS"}: A n2-standard-8 VM instance is currently unavailable in the ${zone} zone.\n`);
  process.exit(1);
}
if (argv.includes("zones")) console.log((process.env.FAKE_GCLOUD_ZONES ?? "").split(",").filter(Boolean).join("\n"));
else if (argv.includes("list")) console.log(process.env.FAKE_GCLOUD_LIST ? readFileSync(process.env.FAKE_GCLOUD_LIST, "utf8") : "[]");
else if (argv.includes("start-iap-tunnel")) {
  const port = argv.find((a) => a.startsWith("--local-host-port="))?.split(":")[1];
  process.stderr.write("Testing if tunnel connection works.\n");
  if (process.env.FAKE_GCLOUD_NOBIND) setInterval(() => {}, 1000);
  else createServer().listen(Number(port), "127.0.0.1");
  const slow = Number(process.env.FAKE_GCLOUD_SLOWSTOP);
  if (slow) process.on("SIGTERM", () => setTimeout(() => process.exit(0), slow));
} else console.log("[]");
