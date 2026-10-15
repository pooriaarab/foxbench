// The cloud environments `foxbench env up` can make. Each one is a VM made
// from a startup script, plus the VM ports the tunnel brings to 127.0.0.1.
import { join } from "node:path";
import { SUITECRM_TUNNEL, suitecrmStartup } from "../bench/suitecrm/index.js";
import { RESET_PORT as MYPC_RESET_PORT, TUNNEL_OFFSET as MYPC_OFFSET, mypcApps, mypcbenchStartup } from "../bench/mypcbench/env.js";
import { RESET_PORT, TUNNEL_OFFSET, wavSites, wavStartup } from "../bench/wav/index.js";
import { TUNNEL_OFFSET as WEBMALL_OFFSET, webmallScript, webmallSites, webmallKey, webmallStartup, WEBMALL_REF } from "../bench/webmall/env.js";

export interface CloudEnv {
  name: string;
  machineType: string;
  diskGb: number;
  /** VM port -> local port. `up` tunnels each one through IAP. */
  ports: { remote: number; local: number }[];
  /** Runs as root on boot. The VM has no external IP; it reaches the internet only through Cloud NAT. */
  startup: string;
  /** Makes the VM with nested virtualization, for an env that runs QEMU with KVM. */
  nestedVirt?: boolean;
  /** How long `up` waits for the first port to answer: the startup script's time to serve. */
  bootMinutes: number;
  /** The same environment on local Docker: a script that takes the cache dir. Absent when the env has no local mode. */
  local?: (cacheDir: string) => string;
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
    ports: [...wavSites.flatMap((s) => [s.port, s.ctrlPort]), RESET_PORT].map((remote) => ({ remote, local: remote + TUNNEL_OFFSET })),
    // The first boot installs Docker and pulls the four site images (about 60 min on n2-standard-8; GitLab is last).
    bootMinutes: 90,
    startup: wavStartup(),
  },
  {
    // ST-WebAgentBench's SuiteCRM tasks. SuiteCRM 8, PHP and MariaDB need about 2 GB of RAM at rest; the
    // two images take about 1 GB, so 30 GB is room for the dump and the logs.
    name: "suitecrm",
    machineType: "e2-standard-4",
    diskGb: 30,
    ports: SUITECRM_TUNNEL,
    // SuiteCRM installs itself on first boot (about 1 min), then the seed loads.
    bootMinutes: 10,
    startup: suitecrmStartup(),
  },
  {
    // WebMall: 4 WooCommerce shops, Elasticsearch and the start page. The first boot fetches 3.6 GB of
    // backups from the authors' server, one download at a time (it answers 429 to a second), then restores them.
    // Measured from GCP: about 260 KB/s, so about 4 hours.
    name: "webmall",
    machineType: "e2-standard-4",
    diskGb: 40,
    ports: webmallSites.map((s) => ({ remote: s.port + WEBMALL_OFFSET, local: s.port + WEBMALL_OFFSET })),
    startup: webmallStartup(),
    bootMinutes: 300,
    local: (cacheDir) => webmallScript({ bind: "127.0.0.1", dir: join(cacheDir, `webmall-${WEBMALL_REF.slice(0, 12)}`) }),
    // A getter: the key file is made when a VM is made, not when the CLI starts.
    get startup() { return webmallStartup(webmallKey()); },
    bootMinutes: 180,
    local: (cacheDir) => webmallScript({ bind: "127.0.0.1", dir: join(cacheDir, `webmall-${WEBMALL_REF.slice(0, 12)}`), key: webmallKey() }),
  },
  {
    // MyPCBench: the QEMU/KVM desktop image (5 GB compressed, 12 GB unpacked) with 17 apps. Upstream
    // gives each VM about 8 GB of RAM and 4 vCPUs; n2 is Intel, which GCP nested virtualization needs.
    name: "mypcbench",
    machineType: "n2-standard-8",
    diskGb: 60,
    nestedVirt: true,
    ports: [...mypcApps.map((a) => a.port), MYPC_RESET_PORT].map((remote) => ({ remote, local: remote + MYPC_OFFSET })),
    // Docker install, the image pull and upstream's first boot (up to 10 minutes to a healthy control API).
    bootMinutes: 30,
    startup: mypcbenchStartup(),
  },
];
