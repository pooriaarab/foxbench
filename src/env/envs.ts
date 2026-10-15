// The cloud environments `foxbench env up` can make. Each one is a VM made
// from a startup script, plus the VM ports the tunnel brings to 127.0.0.1.
import { TUNNEL_OFFSET, wavSites, wavStartup } from "../bench/wav/index.js";

export interface CloudEnv {
  name: string;
  machineType: string;
  diskGb: number;
  /** VM port -> local port. `up` tunnels each one through IAP. */
  ports: { remote: number; local: number }[];
  /** Runs as root on boot. The VM has no external IP; it reaches the internet only through Cloud NAT. */
  startup: string;
  /** How long `up` waits for the first port to answer: the startup script's time to serve. */
  bootMinutes: number;
}

export const cloudEnvs: CloudEnv[] = [
  {
    // Proves the path end to end: a VM, its startup script and the tunnel.
    name: "smoke",
    machineType: "e2-micro",
    diskGb: 10,
    ports: [{ remote: 8080, local: 18080 }],
    bootMinutes: 5,
    startup: `#!/bin/sh
set -e
mkdir -p /srv/foxbench
echo '<!doctype html><title>foxbench smoke</title><h1>foxbench smoke</h1>' > /srv/foxbench/index.html
systemd-run --unit=foxbench-smoke python3 -m http.server 8080 --directory /srv/foxbench
`,
  },
  {
    // WebArena-Verified shopping, shopping_admin, reddit and gitlab. Measured on one host:
    // the images pull 33 GB and take 91 GB on disk (layers plus unpacked), so 200 GB leaves
    // room for the containers' writes. At rest the four use about 6 GB (GitLab 3.8 GB);
    // 32 GB covers MySQL, Elasticsearch and GitLab under load, and 8 vCPUs shorten GitLab's
    // boot, which every gitlab reset repeats.
    name: "wav-core",
    machineType: "n2-standard-8",
    diskGb: 200,
    ports: wavSites.flatMap((s) => [s.port, s.ctrlPort]).map((remote) => ({ remote, local: remote + TUNNEL_OFFSET })),
    // The first boot installs Docker and pulls the four site images (about 60 min on n2-standard-8; GitLab is last).
    bootMinutes: 90,
    startup: wavStartup(),
  },
];
