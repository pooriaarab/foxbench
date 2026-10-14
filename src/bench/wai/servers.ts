// One stdlib server.py per app, started from a copy that leaves out what the
// agent must not read (WI3), on its own port, reset before each case (WI2).
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";

export interface AppServer {
  app: string;
  port: number;
  proc: ChildProcess;
}

/** What server.py would serve besides the page: the task lists, verifiers, solvers and docs. */
const hidden = (name: string) => ["real-tasks", "function-tasks", "real-tasks.json", "function-tasks.json", "Dockerfile"].includes(name) || /^sanity_check.*\.py$|\.md$/.test(name);

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Copies the app, starts its server and waits until it answers; throws after `timeoutMs`. */
export async function startApp(upstream: string, stage: string, app: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<AppServer> {
  const dir = join(stage, app);
  cpSync(join(upstream, "apps", app), dir, { recursive: true, filter: (src) => { const rel = relative(join(upstream, "apps", app), src); return !rel || rel.includes(sep) || !hidden(rel); } });
  const port = await freePort();
  const proc = spawn("python3", ["-I", "server.py", "--port", String(port)], { cwd: dir, env, stdio: "ignore" });
  const exited = new Promise<never>((_, reject) => proc.once("exit", (code) => reject(new Error(`${app} server exited with ${code}`))));
  const answered = (async () => {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) {
      // 404 means up with no state yet; any answer will do.
      if (await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)) return;
    }
    throw new Error(`${app} server did not answer in ${timeoutMs} ms`);
  })();
  try {
    await Promise.race([answered, exited]);
  } catch (error) {
    proc.kill("SIGKILL");
    throw error;
  }
  return { app, port, proc };
}

/** Puts the app back to its seed state. Throws when the server does not say ok. */
export async function resetApp(server: AppServer): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/reset`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  if (!res.ok || body.status !== "ok") throw new Error(`${server.app} reset answered ${res.status}`);
}

export async function stopApp(server: AppServer): Promise<void> {
  if (server.proc.exitCode !== null) return;
  const done = new Promise<void>((resolve) => server.proc.once("exit", () => resolve()));
  server.proc.kill("SIGKILL");
  await done;
}
