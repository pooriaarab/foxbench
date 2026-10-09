// Builds extension/ into dist-ext/: esbuild bundles each script, and the
// other files are copied. It stops when the manifest version is not the
// package.json version, so AMO signs the version that npm publishes.
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}

rmSync("dist-ext", { recursive: true, force: true });
const files = readdirSync("extension");
await build({
  entryPoints: files.filter((f) => f.endsWith(".js")).map((f) => `extension/${f}`),
  outdir: "dist-ext",
  bundle: true,
  format: "iife",
  target: "firefox153",
  logLevel: "warning",
});
for (const file of files.filter((f) => !f.endsWith(".js"))) cpSync(`extension/${file}`, `dist-ext/${file}`, { recursive: true });
console.log(`Built dist-ext/ (version ${pkg.version}).`);
