// Runs a task's own Python verifier against the app's state. The helper is
// written into a directory foxbench owns and run with -I, so the verifier is
// loaded by path and nothing is picked up from the fetched tree or the cwd.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARK = "@@foxbench ";
const HELPER = `import importlib.util, json, sys
app_dir, verify, url = sys.argv[1:4]
try:
    spec = importlib.util.spec_from_file_location("task", app_dir + "/" + verify)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    passed, message = mod.verify(url)
    out = {"passed": bool(passed), "message": str(message)}
except BaseException as e:
    out = {"passed": False, "message": "verifier error: %s: %s" % (type(e).__name__, e)}
print("${MARK}" + json.dumps(out))
`;

export function writeHelper(cacheDir: string): string {
  const dir = join(cacheDir, "wai-helper");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "verify.py");
  writeFileSync(path, HELPER);
  return path;
}

/** The verifier's verdict. A throw, a timeout or no answer is a fail with the reason (WI6). */
export function runVerifier(helper: string, appDir: string, verify: string, url: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ passed: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile("python3", ["-I", helper, appDir, verify, url], { cwd: join(helper, ".."), env, timeout: timeoutMs, maxBuffer: 1 << 24 }, (error, stdout, stderr) => {
      const line = stdout.split("\n").findLast((l) => l.startsWith(MARK));
      if (line) return resolve(JSON.parse(line.slice(MARK.length)));
      resolve({ passed: false, message: `verifier gave no answer: ${error ? error.message : stderr.slice(-200)}` });
    });
  });
}
