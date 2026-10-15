// MyPCBench (MIT, github.com/ljang0/MyPCBench) on the mypcbench env: its QEMU/KVM
// desktop image in a container on a nested-virtualization VM. One app table drives
// the VM's startup script, the tunnel ports and the apps' session cookies. The
// agent sees each app on its own port through the recording proxy; the proxy
// forwards to the tunnel on that port plus TUNNEL_OFFSET.
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { dockerMirror } from "../../env/mirror.js";

/** The upstream commit these ports, paths and the cookie secret were read at. */
export const MYPCBENCH_COMMIT = "937ec49882508223c7ea3f79ead3330c6810feb1";
/** The image by digest: `latest` and the dated tags are rebuilt, and today all name this digest. */
export const MYPCBENCH_IMAGE = "ljang/mypcbench-qemu@sha256:32553c44b5a0e16e78023506056ca5501f91b98d1f59cfbc821456149cb5afa5";
export const TUNNEL_OFFSET = 10000;
/** The VM port of the reset service. 8870 is wav-core's, so both envs can be up together. */
export const RESET_PORT = 8871;
const CONTAINER = "mypcbench";
/** The VM's control API (OSWorld-style), bound to the VM's loopback only. */
const CONTROL_PORT = 5000;
/** The persona the image is baked for; upstream's personas/michael_scott.json identity.email. */
export const PERSONA_EMAIL = "michael.scott@dundermifflin.com";
/** The key upstream's harness signs session cookies with (agent-harness/env.py, _warmup_one_app). */
const SESSION_SECRET = "mypcbench-session-2026";

export interface MyPcApp {
  id: string;
  /** The VM port, and the port the agent sees. */
  port: number;
  /** An API path that answers 2xx once the app has migrated its database; upstream's warm-up request. */
  init: string;
}

// Upstream's _LAZY_DB_WARMUPS: the 17 Next.js apps in port order. Port 3018 is the LibreOffice service, not a web app.
export const mypcApps: MyPcApp[] = [
  { id: "vaultbank", port: 3001, init: "/api/accounts" },
  { id: "batbucks", port: 3002, init: "/api/portfolio" },
  { id: "oddsmarket", port: 3003, init: "/api/markets" },
  { id: "buzzchat", port: 3004, init: "/api/conversations" },
  { id: "workbuzz", port: 3005, init: "/api/channels" },
  { id: "etaxi", port: 3006, init: "/api/rides" },
  { id: "hangrydash", port: 3007, init: "/api/orders" },
  { id: "tablefind", port: 3008, init: "/api/reservations" },
  { id: "kwik-e-mart", port: 3009, init: "/api/orders" },
  { id: "hoolishop", port: 3010, init: "/api/orders" },
  { id: "dinoco-airlines", port: 3011, init: "/api/flights" },
  { id: "cheskepdia", port: 3012, init: "/api/bookings" },
  { id: "sprintboard", port: 3013, init: "/api/projects" },
  { id: "lockedin", port: 3014, init: "/api/posts" },
  { id: "speedtax", port: 3015, init: "/api/returns" },
  { id: "mail", port: 3016, init: "/api/emails" },
  { id: "hoolicalendar", port: 3017, init: "/api/events?start=2026-01-01&end=2026-12-31" },
];

/** The session cookie value for an app, byte for byte what upstream's Python builds (json.dumps puts a space after `:` and `,`). */
export function sessionToken(app: string, email = PERSONA_EMAIL): string {
  const payload = `{"email": ${JSON.stringify(email)}, "app": ${JSON.stringify(app)}}`;
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64");
}
/** The header the proxy adds to every request to an app (MP5). */
export const sessionHeaders = (app: MyPcApp): Record<string, string> => ({ cookie: `session_${app.id}=${sessionToken(app.id)}` });

/** The VM's startup script: Docker, a /dev/kvm check, then the pinned image, then the reset service. */
export function mypcbenchStartup(): string {
  return `#!/bin/sh
# mypcbench: the MyPCBench desktop in QEMU. Runs as root on every boot; a container that exists is only started.
set -e
if ! { modprobe kvm_intel 2>/dev/null; [ -c /dev/kvm ]; }; then
  echo "foxbench: /dev/kvm is missing; the VM needs nested virtualization (--enable-nested-virtualization on an Intel machine)" | tee /dev/console >&2
  exit 1
fi
command -v docker >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io python3; }
${dockerMirror()}
if docker inspect ${CONTAINER} >/dev/null 2>&1; then
  docker start ${CONTAINER}
else
  docker pull -q ${MYPCBENCH_IMAGE}
  docker run -d --name ${CONTAINER} --privileged --device /dev/kvm -e PERSONA=michael_scott -e VM_ID=michael_scott -e WORLD=scranton-office \\
    -p 127.0.0.1:${CONTROL_PORT}:${CONTROL_PORT} -p 3001-3018:3001-3018 ${MYPCBENCH_IMAGE}
fi
mkdir -p /opt/foxbench
cat > /opt/foxbench/mypcbench-reset.py <<'PY'
${MYPCBENCH_RESET_SERVICE}PY
systemctl is-active --quiet mypcbench-reset || systemd-run --unit=mypcbench-reset python3 /opt/foxbench/mypcbench-reset.py
`;
}

// GET /health and POST /reset. A reset is upstream's hard reset: docker restart rebuilds the
// VM's copy-on-write overlay from the baked image. It answers only when the VM is back and each
// app has answered its warm-up request with the persona's session. The URLs are settable for tests.
export const MYPCBENCH_RESET_SERVICE = `import base64, hashlib, hmac, http.server, json, os, subprocess, threading, time, urllib.request

CONTROL = os.environ.get("MYPCBENCH_CONTROL_URL", "http://127.0.0.1:${CONTROL_PORT}")
APP_URL = os.environ.get("MYPCBENCH_APP_URL", "http://127.0.0.1:{port}")
LISTEN = int(os.environ.get("MYPCBENCH_RESET_PORT", "${RESET_PORT}"))
WAIT = int(os.environ.get("MYPCBENCH_RESET_WAIT_S", "900"))
APPS = ${JSON.stringify(mypcApps.map((a) => [a.id, a.port, a.init]))}
EMAIL = "${PERSONA_EMAIL}"
lock = threading.Lock()

def get(url, cookie=None):
    req = urllib.request.Request(url, headers={"Cookie": cookie} if cookie else {})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status

def token(app):
    p = json.dumps({"email": EMAIL, "app": app})
    s = hmac.new(b"${SESSION_SECRET}", p.encode(), hashlib.sha256).hexdigest()
    return base64.b64encode((p + "." + s).encode()).decode()

def not_ready():
    try:
        get(CONTROL + "/health")
    except Exception as e:
        return "the control API is not healthy: " + str(e)
    for app, port, init in APPS:
        try:
            get(APP_URL.format(port=port) + init, "session_" + app + "=" + token(app))
        except Exception as e:
            return app + " did not answer: " + str(e)
    return None

def reset():
    subprocess.run(["docker", "restart", "${CONTAINER}"], check=True, capture_output=True)
    deadline = time.time() + WAIT
    while True:
        why = not_ready()
        if why is None:
            return
        if time.time() > deadline:
            raise RuntimeError("not up " + str(WAIT) + " s after the restart: " + why)
        time.sleep(min(5, WAIT / 4))

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            return self.send_error(404)
        why = not_ready()
        self.send_response(200 if why is None else 503, (why or "ok")[:200].replace("\\n", " "))
        self.end_headers()

    def do_POST(self):
        if self.path != "/reset":
            return self.send_error(404)
        with lock:
            try:
                reset()
                self.send_response(200)
            except Exception as e:
                self.send_response(500, str(e)[:200].replace("\\n", " "))
        self.end_headers()

http.server.ThreadingHTTPServer(("0.0.0.0", LISTEN), Handler).serve_forever()
`;

/** Where the env's ports are: the tunnel, or MYPCBENCH_HOST for a host that runs the container itself. */
export function mypcbenchUrls(env: NodeJS.ProcessEnv, offset = TUNNEL_OFFSET) {
  const host = env.MYPCBENCH_HOST || "127.0.0.1";
  return { apps: mypcApps.map((app) => ({ app, url: `http://${host}:${app.port + offset}` })), reset: `http://${host}:${RESET_PORT + offset}` };
}

/** One request with no connection pool and a deadline, so a dead tunnel never hangs the run (MP8). */
export function call(url: string, method: string, timeoutMs: number): Promise<{ status: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, agent: false, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, reason: res.statusMessage ?? "" }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${url} did not answer in ${Math.round(timeoutMs / 1000)} s`)));
    req.on("error", reject);
    req.end();
  });
}

/** Resets the VM to its baked state; resolves when every app answers again. */
export async function resetVm(resetUrl: string, waitMs = 15 * 60_000): Promise<void> {
  const res = await call(`${resetUrl}/reset`, "POST", waitMs);
  if (res.status !== 200) throw new Error(`the mypcbench reset service at ${resetUrl} returned ${res.status}: ${res.reason}`);
}

/** Null when the control API and every app answer through the reset service; else why not. */
export async function probeVm(resetUrl: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const res = await call(`${resetUrl}/health`, "GET", timeoutMs);
    return res.status === 200 ? null : `the VM is not ready (${res.status}: ${res.reason})`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
