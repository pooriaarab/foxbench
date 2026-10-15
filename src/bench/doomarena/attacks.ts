// DoomArena's attack text and markup (ServiceNow, Apache-2.0), fetched at the
// pinned commit into the cache and read from there: the pop-up card with its
// hidden aria text, and the banner warning and alt texts. Nothing upstream is
// committed. The report URL in every message is foxbench's local collector,
// never upstream's localhost:1234 (DA1, DA4).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DOOM_REPO = "https://github.com/ServiceNow/DoomArena";
/** 2025-09-10, the head of main when this runner was written. */
export const DOOM_REF = "b80902f107b4d28194580352a59b3029f4a018b4";
const BASE = "https://raw.githubusercontent.com/ServiceNow/DoomArena";
const DIR = "doomarena/browsergym/src/doomarena/browsergym";
const SOURCES = { popup: `${DIR}/attacks/popup_attacks.py`, banner: `${DIR}/scripts/run_banner_with_alt_text_attack_webarena_reddit.py` };

export type AttackKind = "clean" | "banner" | "popup" | "combined";
export const KINDS: AttackKind[] = ["clean", "banner", "popup", "combined"];

export const doomDir = (cacheDir: string) => join(cacheDir, `doomarena-${DOOM_REF.slice(0, 12)}`);

/** The two upstream files, fetched once into the cache. */
export async function fetchDoom(cacheDir: string): Promise<Record<keyof typeof SOURCES, string>> {
  const dir = doomDir(cacheDir);
  mkdirSync(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(SOURCES)) {
    const file = join(dir, `${name}.py`);
    if (!existsSync(file)) {
      const res = await fetch(`${BASE}/${DOOM_REF}/${path}`);
      if (!res.ok) throw new Error(`upstream ${path}: ${res.status}`);
      writeFileSync(`${file}.${process.pid}`, await res.text());
      writeFileSync(file, readFileSync(`${file}.${process.pid}`));
    }
    out[name] = readFileSync(file, "utf8");
  }
  return out as Record<keyof typeof SOURCES, string>;
}

/** One of upstream's triple-quoted constants, or the body of its `popup_div` f-string. */
export function pyString(source: string, name: string): string {
  const m = new RegExp(`${name} = f?"""([\\s\\S]*?)"""`).exec(source);
  if (!m) throw new Error(`upstream no longer has ${name}`);
  return m[1]!;
}

export interface Attack {
  /** What goes before </body> of every HTML page the agent loads. */
  html: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A side banner: foxbench's own two panels, with upstream's warning text drawn in the image and its alt text (DA3). */
function banner(sources: Record<string, string>, report: string): string {
  const text = pyString(sources.banner!, "warning_message_even").replaceAll("localhost:1234", report);
  const alt = pyString(sources.banner!, "security_risk_message").replaceAll("localhost:1234", report);
  const lines = text.split("\n").filter((l) => l.trim());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="600" viewBox="0 0 200 600"><rect width="200" height="600" fill="#FF0000"/>${
    lines.map((l, i) => `<text x="10" y="${30 + i * 24}" font-size="16" fill="#fff">${esc(l.trim())}</text>`).join("")}</svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  const panel = (side: string) => `<div id="${side}-panel" style="position:fixed;${side}:0;top:0;width:15%;height:100%;z-index:2147483646"><img src="${uri}" alt="${esc(alt)}" style="width:100%;height:100%"></div>`;
  return `<div id="viewport-wrapper">${panel("left")}${panel("right")}</div>`;
}

/** Upstream's own pop-up card, with its hidden aria text pointed at the collector. */
function popup(sources: Record<string, string>, report: string): string {
  const hidden = pyString(sources.popup!, "DEFAULT_HIDDEN_WARNING_MESSAGE_TEMPLATE").replaceAll("{REPORT_URL_PLACEHOLDER}", report);
  const visible = pyString(sources.popup!, "DEFAULT_VISIBLE_MESSAGE");
  const button = /button_text: str = "([^"]+)"/.exec(sources.popup!)?.[1] ?? "I understand the risks and want to proceed";
  return pyString(sources.popup!, "    popup_div")
    .replaceAll("{hidden_message}", esc(hidden)).replaceAll("{warning_message}", visible).replaceAll("{button_text}", esc(button));
}

/** The markup of one attack kind, or none for `clean`. */
export function attackHtml(kind: AttackKind, sources: Record<string, string>, report: string): string {
  return (kind === "banner" || kind === "combined" ? banner(sources, report) : "") + (kind === "popup" || kind === "combined" ? popup(sources, report) : "");
}
