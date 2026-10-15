// The suitecrm env: SuiteCRM 8 and MariaDB for ST-WebAgentBench's SuiteCRM
// tasks. Upstream's compose file names public.ecr.aws/bitnami/*, which is
// gone, so the VM runs the same Bitnami images from bitnamilegacy at pinned
// tags. The agent sees SuiteCRM on SUITECRM_PORT through the recording proxy;
// the proxy forwards to the tunnel on SUITECRM_TUNNEL.

import { dockerMirror } from "../../env/mirror.js";

/** SuiteCRM's port on the VM, and the port the agent sees: the site URL is http://127.0.0.1:8080. */
export const SUITECRM_PORT = 8080;
/** The VM port of the reset service, which restores the seeded database (SE5). */
export const SUITECRM_RESET_PORT = 8871;
/** VM port -> local port the tunnel opens. 18080 is the smoke env's. */
export const SUITECRM_TUNNEL = [{ remote: SUITECRM_PORT, local: 18181 }, { remote: SUITECRM_RESET_PORT, local: 18971 }];
export const SUITECRM_IMAGE = "docker.io/bitnamilegacy/suitecrm:8.8.1";
export const MARIADB_IMAGE = "docker.io/bitnamilegacy/mariadb:11.4.7";
/** The upstream commit (ST-WebAgentBench, Apache-2.0) whose seed and task list foxbench uses. */
export const ST_COMMIT = "67f56dd7df9eca1646c9e49407b087e950aa1e77";
export const SEED_URL = `https://raw.githubusercontent.com/segev-shlomov/ST-WebAgentBench/${ST_COMMIT}/suitecrm_setup/init-db/demo_data.sql`;
const DB = "bitnami_suitecrm";

/** The VM's startup script: Docker, the two containers, the seed (once), and the reset service. */
export function suitecrmStartup(): string {
  return `#!/bin/sh
# suitecrm: runs as root on every boot; a container that exists is only started, and the seed loads once.
set -e
D=\${FOXBENCH_DIR:-/opt/foxbench}
command -v docker >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io; }
${dockerMirror()}
docker network inspect suitecrm >/dev/null 2>&1 || docker network create suitecrm
run() {
  name=$1 image=$2
  shift 2
  if docker inspect "$name" >/dev/null 2>&1; then docker start "$name"; return; fi
  docker run -d --name "$name" --network suitecrm --restart unless-stopped "$@" "$image"
}
run suitecrm-db ${MARIADB_IMAGE} --network-alias mariadb -e ALLOW_EMPTY_PASSWORD=yes -e MARIADB_USER=bn_suitecrm -e MARIADB_DATABASE=${DB} -e MARIADB_PASSWORD=bitnami123
run suitecrm-app ${SUITECRM_IMAGE} -p ${SUITECRM_PORT}:8080 -e SUITECRM_DATABASE_HOST=mariadb -e SUITECRM_DATABASE_PORT_NUMBER=3306 -e SUITECRM_DATABASE_USER=bn_suitecrm -e SUITECRM_DATABASE_NAME=${DB} -e SUITECRM_DATABASE_PASSWORD=bitnami123 -e ALLOW_EMPTY_PASSWORD=yes -e SUITECRM_HOST=127.0.0.1 -e SUITECRM_EXTERNAL_HTTP_PORT_NUMBER=${SUITECRM_PORT}
mkdir -p "$D"
if [ ! -f "$D/seed.sql" ]; then
  # SuiteCRM makes its tables on first boot; load the seed only once they and the site are there.
  until curl -sf -o /dev/null http://127.0.0.1:${SUITECRM_PORT}/; do sleep 5; done
  until [ "$(docker exec suitecrm-db mysql -u root -N -e 'select count(*) from ${DB}.users' 2>/dev/null)" -gt 0 ] 2>/dev/null; do sleep 5; done
  curl -fsSL -o "$D/demo_data.sql" ${SEED_URL}
  docker exec -i suitecrm-db mysql -u root < "$D/demo_data.sql"
  docker exec suitecrm-db mysqldump -u root ${DB} > "$D/seed.sql.tmp"
  mv "$D/seed.sql.tmp" "$D/seed.sql"
fi
cat > "$D/suitecrm-reset.py" <<PY
${suitecrmResetService("$D/seed.sql", SUITECRM_RESET_PORT)}PY
systemctl is-active --quiet suitecrm-reset || systemd-run --unit=suitecrm-reset python3 "$D/suitecrm-reset.py"
`;
}

/** The reset service: POST /reset restores the database from the dump the VM took after the seed load. */
export function suitecrmResetService(seed: string, port: number): string {
  return `import http.server, subprocess

SEED = ${JSON.stringify(seed)}

class Reset(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/reset":
            return self.send_error(404)
        try:
            with open(SEED, "rb") as dump:
                subprocess.run(["docker", "exec", "-i", "suitecrm-db", "mysql", "-u", "root", "${DB}"], stdin=dump, check=True, capture_output=True)
            self.send_response(200)
        except subprocess.CalledProcessError as e:
            self.send_response(500, " ".join(e.stderr.decode(errors="replace").split())[:200])
        self.end_headers()

    def do_GET(self):
        self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_GET

http.server.ThreadingHTTPServer(("0.0.0.0", ${port}), Reset).serve_forever()
`;
}
