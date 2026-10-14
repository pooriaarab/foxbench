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
}

export const cloudEnvs: CloudEnv[] = [
  {
    // Proves the path end to end: a VM, its startup script and the tunnel.
    name: "smoke",
    machineType: "e2-micro",
    diskGb: 10,
    ports: [{ remote: 8080, local: 18080 }],
    startup: `#!/bin/sh
set -e
mkdir -p /srv/foxbench
echo '<!doctype html><title>foxbench smoke</title><h1>foxbench smoke</h1>' > /srv/foxbench/index.html
systemd-run --unit=foxbench-smoke python3 -m http.server 8080 --directory /srv/foxbench
`,
  },
  {
    // WebArena-Verified shopping, shopping_admin, reddit and gitlab. The images are about
    // 33 GB to pull and 56 GB unpacked, so 200 GB leaves room for both and for GitLab's
    // writes. GitLab wants 4 GB and each Magento site runs MySQL and Elasticsearch; the
    // four use about 14 GB at rest, so 32 GB (n2-standard-8) leaves headroom under load.
    name: "wav-core",
    machineType: "n2-standard-8",
    diskGb: 200,
    ports: wavSites.flatMap((s) => [s.port, s.ctrlPort]).map((remote) => ({ remote, local: remote + TUNNEL_OFFSET })),
    startup: wavStartup(),
  },
];
