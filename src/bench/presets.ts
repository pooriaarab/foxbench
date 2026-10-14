// Agent presets: `--agent foxmate` names an MCP command in foxbench.agents.json,
// in the working directory or in ~/.config/foxbench/. foxbench never imports
// the agent; a preset is the same mcpAdapter call as `--agent mcp`.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Preset {
  command: string;
  args?: string[];
  /** The MCP tool. The default is run_task. */
  tool?: string;
  /** The name in the scoreboard. The default is the preset's name. */
  name?: string;
  /** More arguments for every tool call, as --arg key=json gives. */
  arg?: Record<string, unknown>;
}

const BUILT_IN = ["noop", "mcp"];

/** The presets from both files, the working directory's first (A3). Throws on a preset named noop or mcp (A1). */
export function loadPresets(cwd = process.cwd(), home = homedir()): { presets: Record<string, Preset & { file: string }>; files: string[] } {
  const files = [join(cwd, "foxbench.agents.json"), join(home, ".config", "foxbench", "foxbench.agents.json")];
  const presets: Record<string, Preset & { file: string }> = {};
  for (const file of files.toReversed().filter((f) => existsSync(f))) {
    for (const [name, preset] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, Preset>)) {
      if (BUILT_IN.includes(name)) throw new Error(`${file}: "${name}" is a built-in agent; give the preset another name`);
      if (typeof preset?.command !== "string") throw new Error(`${file}: the preset "${name}" needs a command`);
      presets[name] = { ...preset, file };
    }
  }
  return { presets, files };
}
