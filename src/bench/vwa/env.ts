// The vwa env: VisualWebArena's start state. Shopping and reddit are the
// WebArena-Verified images that wav-core runs (same products and posts, and
// the reddit posts serve their images); Classifieds comes from the compose zip
// that VWA publishes on archive.org. One table drives the VM's startup script,
// the tunnel ports and the reset service. Each site is told the URL the agent
// sees, http://127.0.0.1:<port>, which the recording proxy serves.
import { WAV_TAG, wavSites } from "../wav/index.js";

/** Local tunnel port = VM port + this, clear of wav-core's 10000 so both envs can be up. */
export const VWA_TUNNEL_OFFSET = 20000;
/** The VM port of the reset service. */
export const VWA_RESET_PORT = 8872;
export const CLASSIFIEDS_PORT = 9980;
/** VWA's commit (MIT) whose tasks and evaluators foxbench uses. */
export const VWA_COMMIT = "89f5af29305c3d1e9f97ce4421462060a70c9a03";
export const CLASSIFIEDS_ZIP = "https://archive.org/download/classifieds_docker_compose/classifieds_docker_compose.zip";
export const CLASSIFIEDS_ZIP_SHA1 = "b351be6468feeeb0b9b261dfc0ad9e8c2966d718";
// Digests read on 2026-10-15 from the registry for jykoh/classifieds:latest and mysql:8.1, the tags of upstream's compose file.
export const CLASSIFIEDS_IMAGE = "docker.io/jykoh/classifieds@sha256:a2a794da92f62a8d7ffd02314e4fab40ba6c7fc08f568371608f88f0ef605e43";
/**
 * One `docker pull` may run this long (2 hours). The Classifieds image is one 73 GB layer (71.6 GiB compressed) that unpacks to 155 GB:
 * at 20 MB/s, which a Cloud NAT VM can see, the download alone is an hour. A pull that moves is allowed this long; one that stops is not (PULL_STALL_SECONDS).
 */
export const PULL_TIMEOUT_SECONDS = 7200;
/** A pull that gets no new bytes on disk for this long (10 minutes) is stopped. */
export const PULL_STALL_SECONDS = 600;
/** A stopped pull is tried again; Docker keeps the layers it finished. */
export const PULL_ATTEMPTS = 2;
/** Google's Docker Hub mirror: it serves the small images and the MySQL image from Google's network, and Docker falls back to Hub for a layer it lacks. */
export const DOCKER_MIRROR = "https://mirror.gcr.io";
export const MYSQL_IMAGE = "docker.io/library/mysql@sha256:f61944ff3f2961363a4d22913b2ac581523273679d7e14dd26e8db8c9f571a7e";

/** The WebArena-Verified sites VWA uses, as wav-core runs them. */
const wavSite = (id: string) => wavSites.find((s) => s.id === id)!;
export const vwaSites = ["shopping", "reddit"].map(wavSite).map((s) => ({
  id: s.id, port: s.port, ctrlPort: s.ctrlPort,
  /** The `docker run` arguments of the site's container, which the reset service replays. */
  args: ["-p", `${s.port}:${s.containerPort}`, "-p", `${s.ctrlPort}:8877`, "-e", `WA_ENV_CTRL_EXTERNAL_SITE_URL=http://127.0.0.1:${s.port}`, `am1n3e/webarena-verified-${s.id}:${WAV_TAG}`],
}));

/** Every VM port the tunnel brings to the Mac. */
export const vwaTunnel = [...vwaSites.flatMap((s) => [s.port, s.ctrlPort]), CLASSIFIEDS_PORT, VWA_RESET_PORT].map((remote) => ({ remote, local: remote + VWA_TUNNEL_OFFSET }));

/** The VM's startup script: Docker, the two WebArena-Verified sites, Classifieds with its data, and the reset service. */
export function vwaStartup(): string {
  const sites = vwaSites.map((s) => `run vwa-${s.id} ${s.args.slice(-1)[0]} ${s.args.slice(0, -1).join(" ")}`);
  return `#!/bin/sh
# vwa: runs as root on every boot; a container that exists is only started, and Classifieds loads its data once.
set -e
D=\${FOXBENCH_DIR:-/opt/foxbench}
mkdir -p "$D"
command -v docker >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io; }
# Google's mirror first, so the pulls skip Docker Hub's anonymous limit (shared by every VM behind a Cloud NAT IP) where the mirror has the image.
J=\${DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}
mkdir -p "$(dirname "$J")"
printf '{\\n  "registry-mirrors": ["${DOCKER_MIRROR}"]\\n}\\n' > "$D/daemon.json.new"
changed=1
cmp -s "$D/daemon.json.new" "$J" 2>/dev/null && changed=0
if [ $changed -eq 1 ]; then mv "$D/daemon.json.new" "$J"; else rm "$D/daemon.json.new"; fi
systemctl enable --now docker
[ $changed -eq 0 ] || systemctl restart docker
# Bytes the pull has written: a pull that gets no new bytes for PULL_STALL seconds is stopped, one that keeps moving is let run to PULL_TIMEOUT.
probe() { if [ -n "$PULL_PROBE" ]; then sh -c "$PULL_PROBE"; else df --output=used -B1 /var/lib/docker | tail -1; fi; }
watch_pull() {
  docker pull -q "$1" >/dev/null &
  p=$!
  start=$(date +%s) mark=$(date +%s) last=$(probe) said=$(date +%s) tick=0
  while kill -0 $p 2>/dev/null; do
    sleep 1
    tick=$((tick + 1))
    now=$(date +%s)
    if [ $((now - start)) -ge \${PULL_TIMEOUT:-${PULL_TIMEOUT_SECONDS}} ]; then kill $p; wait $p 2>/dev/null || true; return 124; fi
    [ $((tick % \${PULL_POLL:-30})) -eq 0 ] || continue
    cur=$(probe)
    [ "$cur" = "$last" ] || { last=$cur; mark=$now; }
    if [ $((now - mark)) -ge \${PULL_STALL:-${PULL_STALL_SECONDS}} ]; then kill $p; wait $p 2>/dev/null || true; return 125; fi
    [ $((now - said)) -lt 300 ] || { said=$now; echo "vwa: pulling $1: $((now - start))s, $((cur / 1000000000)) GB used on disk" >&2; }
  done
  wait $p
}
# A pull that stops moving, or outlasts its time, fails with the reason instead of hanging the boot.
pull() {
  n=1
  while :; do
    rc=0
    watch_pull "$1" || rc=$?
    [ $rc -eq 0 ] && return
    if [ $rc -eq 124 ]; then echo "vwa: docker pull $1 timed out after \${PULL_TIMEOUT:-${PULL_TIMEOUT_SECONDS}}s (attempt $n of ${PULL_ATTEMPTS})" >&2
    elif [ $rc -eq 125 ]; then echo "vwa: docker pull $1 stalled: no new bytes for \${PULL_STALL:-${PULL_STALL_SECONDS}}s (attempt $n of ${PULL_ATTEMPTS})" >&2
    else echo "vwa: docker pull $1 failed with status $rc (attempt $n of ${PULL_ATTEMPTS})" >&2; fi
    [ $n -ge ${PULL_ATTEMPTS} ] && { echo "vwa: giving up on $1; the site it serves will not start" >&2; exit 1; }
    n=$((n + 1))
  done
}
run() {
  name=$1 image=$2
  shift 2
  if docker inspect "$name" >/dev/null 2>&1; then docker start "$name"; return; fi
  pull "$image"
  docker run -d --name "$name" --restart unless-stopped "$@" "$image"
}
${sites.join("\n")}
docker network inspect vwa >/dev/null 2>&1 || docker network create vwa
# The reset token is this VM's own; upstream's is public in its zip.
[ -f "$D/classifieds.token" ] || ( umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \\n' > "$D/classifieds.token" )
if ! docker inspect vwa-classifieds-db >/dev/null 2>&1; then
  # MySQL loads the files of its init folder when its container is first made, so the folder holds the data file alone: the zip's
  # classifieds_restore.sql (deletes rows of tables that do not exist yet) and init_db.sh (loads the data a second time) abort the init.
  curl -fsSL -o "$D/classifieds.zip" ${CLASSIFIEDS_ZIP}
  echo "${CLASSIFIEDS_ZIP_SHA1}  $D/classifieds.zip" | sha1sum -c -
  python3 - "$D/classifieds.zip" "$D/classifieds-init" <<'PY'
import os, sys, zipfile
zf = zipfile.ZipFile(sys.argv[1])
os.makedirs(sys.argv[2], exist_ok=True)
for item in zf.infolist():
    parts = item.filename.split("/")
    if len(parts) == 3 and parts[1] == "mysql" and parts[2] == "osclass_craigslist.sql":
        open(os.path.join(sys.argv[2], parts[2]), "wb").write(zf.read(item))
PY
  # The mysql user (uid 999), not root, reads this folder: root-only modes made its entrypoint loop on "Permission denied".
  chmod 755 "$D/classifieds-init"
  chmod 644 "$D"/classifieds-init/*
fi
run vwa-classifieds-db ${MYSQL_IMAGE} --network vwa --network-alias db -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=osclass -v "$D/classifieds-init:/docker-entrypoint-initdb.d"
run vwa-classifieds ${CLASSIFIEDS_IMAGE} --network vwa -p ${CLASSIFIEDS_PORT}:${CLASSIFIEDS_PORT} -e CLASSIFIEDS=http://127.0.0.1:${CLASSIFIEDS_PORT}/ -e RESET_TOKEN="$(cat "$D/classifieds.token")"
cat > "$D/vwa-reset.py" <<'PY'
${vwaResetService(`http://127.0.0.1:${CLASSIFIEDS_PORT}`, VWA_RESET_PORT)}PY
systemctl is-active --quiet vwa-reset || systemd-run --unit=vwa-reset python3 "$D/vwa-reset.py"
`;
}

/**
 * The reset service. POST /reset/shopping and /reset/reddit recreate the
 * container from its image (the sites keep their data in the image);
 * /reset/classifieds posts the VM's token (the file next to the script) to the site's own reset, and
 * counts only a reply that says the SQL file executed (a wrong token is a 200 with an error).
 */
export function vwaResetService(classifieds: string, port: number): string {
  const recreate = Object.fromEntries(vwaSites.map((s) => [s.id, s.args]));
  return `import http.server, json, os, subprocess, urllib.parse, urllib.request

RECREATE = json.loads(${JSON.stringify(JSON.stringify(recreate))})
# The token file sits next to this script.
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "classifieds.token")
CLASSIFIEDS = ${JSON.stringify(classifieds)}

def recreate(site):
    name = "vwa-" + site
    subprocess.run(["docker", "rm", "-f", name], check=True, capture_output=True)
    subprocess.run(["docker", "run", "-d", "--name", name, "--restart", "unless-stopped"] + RECREATE[site], check=True, capture_output=True)

def reset_classifieds():
    token = open(TOKEN_FILE).read().strip()
    body = urllib.parse.urlencode({"token": token}).encode()
    reply = urllib.request.urlopen(urllib.request.Request(CLASSIFIEDS + "/index.php?page=reset", data=body, method="POST"), timeout=300).read().decode(errors="replace")
    # A wrong token is a 200 that says "Error: Invalid token".
    if "executed successfully" not in reply:
        raise RuntimeError(reply)

class Reset(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        site = self.path.removeprefix("/reset/")
        if site not in RECREATE and site != "classifieds":
            return self.send_error(404)
        try:
            reset_classifieds() if site == "classifieds" else recreate(site)
            self.send_response(200)
        except Exception as e:
            reason = e.stderr.decode(errors="replace") if isinstance(e, subprocess.CalledProcessError) else str(e)
            self.send_response(500, " ".join(reason.split())[:200])
        self.end_headers()

    def do_GET(self):
        self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_GET

http.server.ThreadingHTTPServer(("0.0.0.0", ${port}), Reset).serve_forever()
`;
}
