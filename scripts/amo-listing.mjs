// The AMO listing for extension/amo-metadata.json.
//   check            Stop when the listing, the manifest or the release build
//                    in dist-ext/ breaks an AMO rule or a repo rule
//                    (ci:local and release.yml run it).
//   metadata <file>  Write the fields that web-ext sends to AMO.
//   version-status   Print "absent" or "listed <edit url>" for this version
//                    on AMO, so a release re-run does not submit it twice.
//   after-submit     Set the privacy policy and the listing icon on AMO.
//                    release.yml runs it after web-ext sign.
// AMO API: https://mozilla.github.io/addons-server/topics/api/addons.html
// web-ext sends the add-on fields with the upload, but the privacy policy
// has its own endpoint (eula_policy), so this script sends it.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const META_FILE = "extension/amo-metadata.json";
// From https://addons.mozilla.org/api/v5/addons/categories/ (type extension).
const CATEGORIES = new Set(["alerts-updates", "appearance", "bookmarks", "download-management", "feeds-news-blogging", "games-entertainment", "language-support", "other", "photos-music-videos", "privacy-security", "search-tools", "shopping", "social-communication", "tabs", "web-development"]);
// The user's rule: a user never sees these words.
const BANNED = /\b(demo|demos|test|tests|testing|fixture|fixtures)\b/i;
const ICON_SIZES = ["48", "96", "128"];
// Listing keys that are not AMO add-on fields. metadata leaves them out.
const LOCAL_KEYS = ["privacy_policy", "local_hosts"];
// A match pattern for this computer: test bridges and test servers use these.
const LOCAL_HOST = /^(\*|https?|wss?):\/\/(127\.0\.0\.1|localhost|\*\.localhost|\[::1\])(:[0-9*]+)?\//;
// A file named for tests must not ship (AR4).
const TEST_FILE = /(^|[/._-])(e2e|fixtures?|tests?|spec)([/._-]|$)/i;

const meta = JSON.parse(readFileSync(META_FILE, "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const repo = /github\.com\/pooriaarab\/([^/.]+)/.exec(pkg.repository?.url ?? "")?.[1];

function en(field) {
  return typeof field === "object" && field !== null ? field["en-US"] : undefined;
}

function pngSize(file) {
  const b = readFileSync(file);
  if (b.toString("latin1", 1, 4) !== "PNG") return undefined;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function check() {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const name = en(meta.name);
  if (name !== manifest.name) fail(`name["en-US"] must equal the manifest name "${manifest.name}"`);
  if (!name || name.length > 45) fail("name must have 1 to 45 characters (AMO allows 50)");
  if (/firefox|mozilla/i.test(name ?? "")) fail("name must not use the Firefox or Mozilla trademarks");
  const summary = en(meta.summary);
  if (!summary || summary.length > 250) fail("summary must have 1 to 250 characters");
  if (/https?:|www\./i.test(summary ?? "")) fail("summary must not hold a URL (AMO refuses it)");
  if ((en(meta.description) ?? "").length < 200) fail("description must say what the add-on does, in 200 characters or more");
  const cats = meta.categories?.firefox;
  if (!Array.isArray(cats) || cats.length < 1 || cats.length > 3) fail("categories.firefox must list 1 to 3 categories");
  for (const c of cats ?? []) if (!CATEGORIES.has(c)) fail(`"${c}" is not an AMO extension category`);
  if ((cats ?? []).length > 1 && cats.includes("other")) fail('AMO refuses "other" with another category');
  if (meta.version?.license !== "MIT") fail('version.license must be "MIT"');
  if (!meta.version?.approval_notes) fail("version.approval_notes must tell reviewers how to build and use the add-on");
  if (!repo) fail("package.json repository.url must point to github.com/pooriaarab/<repo>");
  if (en(meta.homepage) !== `https://github.com/pooriaarab/${repo}`) fail(`homepage must be https://github.com/pooriaarab/${repo}`);
  if (en(meta.support_url) !== `https://github.com/pooriaarab/${repo}/issues`) fail(`support_url must be https://github.com/pooriaarab/${repo}/issues`);
  if (meta.slug !== undefined && !/^[\p{L}\p{N}_~-]+$/u.test(meta.slug)) fail("slug may hold only letters, numbers, -, _ and ~");
  const seen = {
    "manifest name": manifest.name,
    "manifest description": manifest.description,
    "action title": manifest.action?.default_title,
    "sidebar title": manifest.sidebar_action?.default_title,
    "listing name": name,
    "listing summary": summary,
    "listing description": en(meta.description),
  };
  for (const [where, text] of Object.entries(seen)) if (text && BANNED.test(text)) fail(`${where} uses the word "${BANNED.exec(text)[0]}"`);
  const data = manifest.browser_specific_settings?.gecko?.data_collection_permissions ?? {};
  const sends = [...(data.required ?? []), ...(data.optional ?? [])].some((p) => p !== "none");
  if (sends && !en(meta.privacy_policy)) fail("the manifest declares data collection, so privacy_policy is required");
  for (const size of ICON_SIZES) {
    const file = manifest.icons?.[size];
    if (!file) {
      fail(`manifest icons must have a ${size} px icon`);
      continue;
    }
    const dims = existsSync(`extension/${file}`) ? pngSize(`extension/${file}`) : undefined;
    if (!dims || dims[0] !== Number(size) || dims[1] !== Number(size)) fail(`extension/${file} must be a ${size}x${size} PNG`);
  }
  const allowed = scanReleaseBuild(fail);
  for (const e of errors) console.error(`${META_FILE}: ${e}`);
  if (errors.length > 0) process.exit(1);
  console.log(`${META_FILE}: the listing for "${name}" passes (${cats.join(", ")}, privacy policy: ${en(meta.privacy_policy) ? "yes" : "not needed"}).`);
  console.log(`dist-ext/: no test-named files and no local host use without a reason; with a reason: ${allowed.length ? allowed.join(", ") : "none"}.`);
}

function files(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

// AR1-AR5: dist-ext/ is what release.yml signs, so it must hold no test-only
// piece. A local host is allowed only with a reason in local_hosts for that
// pattern AND that use (AR3, AR-U1): { "<pattern>": { "host_permission": "..." } }.
function scanReleaseBuild(fail) {
  if (!existsSync("dist-ext/manifest.json")) {
    fail("dist-ext/ is missing; run pnpm build:ext (the release build) first");
    return [];
  }
  const built = JSON.parse(readFileSync("dist-ext/manifest.json", "utf8"));
  const reasons = meta.local_hosts ?? {};
  const allowed = [];
  const local = (use, where, pattern) => {
    if (!LOCAL_HOST.test(pattern)) return;
    const reason = reasons[pattern]?.[use];
    if (typeof reason === "string" && reason.length >= 20) allowed.push(`${pattern} ${use}`);
    else fail(`the release build has ${where} "${pattern}"; move it to the e2e build, or give a reason in local_hosts["${pattern}"].${use}`);
  };
  for (const cs of built.content_scripts ?? []) for (const m of cs.matches ?? []) local("content_script", "a content script for", m);
  for (const war of built.web_accessible_resources ?? []) for (const m of war.matches ?? []) local("web_accessible_resource", "a web-accessible resource for", m);
  for (const m of built.externally_connectable?.matches ?? []) local("externally_connectable", "externally_connectable for", m);
  for (const m of [...(built.host_permissions ?? []), ...(built.optional_host_permissions ?? [])]) local("host_permission", "the host permission", m);
  for (const f of files("dist-ext")) if (TEST_FILE.test(f)) fail(`the release build ships the test file dist-ext/${f}`);
  // AR-U2: no reason for a use that the release build does not have.
  for (const [pattern, uses] of Object.entries(reasons)) for (const use of Object.keys(uses ?? {})) if (!allowed.includes(`${pattern} ${use}`)) fail(`local_hosts["${pattern}"].${use} has a reason, but the release build has no such ${use}`);
  return allowed;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function jwt() {
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  if (!issuer || !secret) {
    console.error("AMO_JWT_ISSUER and AMO_JWT_SECRET must be set.");
    process.exit(1);
  }
  const iat = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: issuer, jti: randomUUID(), iat, exp: iat + 60 })}`;
  return `JWT ${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

async function patch(url, body, what) {
  const headers = { Authorization: jwt(), Accept: "application/json" };
  if (typeof body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method: "PATCH", headers, body });
  if (!res.ok) {
    console.error(`AMO refused the ${what}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`AMO accepted the ${what}.`);
}

function addonUrl() {
  const api = process.env.AMO_API_URL ?? "https://addons.mozilla.org/api/v5/";
  return new URL(`addons/addon/${encodeURIComponent(manifest.browser_specific_settings.gecko.id)}/`, api);
}

// AR7-AR9. The "v" prefix makes AMO read the path as a version number.
async function versionStatus() {
  const url = new URL(`versions/v${manifest.version}/`, addonUrl());
  const res = await fetch(url, { headers: { Authorization: jwt(), Accept: "application/json" } });
  if (res.status === 404) return console.log("absent");
  if (!res.ok) {
    console.error(`AMO version lookup for ${manifest.version}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const version = await res.json();
  if (version.channel !== "listed") {
    console.error(`AMO already has ${manifest.version} as ${version.channel}. Bump the version in package.json and the manifest.`);
    process.exit(1);
  }
  console.log(`listed ${version.edit_url ?? ""}`.trim());
}

async function afterSubmit() {
  const addon = addonUrl();
  if (en(meta.privacy_policy)) await patch(new URL("eula_policy/", addon), JSON.stringify({ privacy_policy: meta.privacy_policy }), "privacy policy");
  const form = new FormData();
  form.set("icon", new Blob([readFileSync(`extension/${manifest.icons["128"]}`)], { type: "image/png" }), "icon-128.png");
  await patch(addon, form, "listing icon");
}

const [command, arg] = process.argv.slice(2);
if (command === "check") check();
else if (command === "metadata" && arg) {
  const sent = Object.fromEntries(Object.entries(meta).filter(([k]) => !LOCAL_KEYS.includes(k)));
  writeFileSync(arg, `${JSON.stringify(sent, null, 2)}\n`);
  console.log(`Wrote ${arg}.`);
} else if (command === "version-status") await versionStatus();
else if (command === "after-submit") await afterSubmit();
else {
  console.error("Usage: node scripts/amo-listing.mjs check | metadata <file> | version-status | after-submit");
  process.exit(1);
}
