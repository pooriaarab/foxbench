// The mcp adapter: spawns any MCP server on stdio and calls one tool per
// task with { url, goal }. foxpilot (`foxpilot mcp`, tool run_task) works as is.
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Adapter } from "./adapter.js";

export interface McpAdapterOptions {
  /** The program to start, for example "node". */
  command: string;
  args?: string[];
  /** The tool to call. The default is "run_task". */
  tool?: string;
  /** The name in the scoreboard. The default is "mcp". */
  name?: string;
  /** More arguments for every tool call, beside url and goal. */
  extra?: Record<string, unknown>;
  /** The longest time one tool call may take. The default is 10 minutes. */
  timeoutMs?: number;
}

/** Reads the agent's own claim from a tool reply. The score does not use it. */
function claimed(text: string): boolean {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return [value.verified, value.done, value.success].includes(true);
  } catch {
    return false;
  }
}

/** The pids of a process and all its descendants, children first. */
function processTree(root: number): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [root];
  }
  const children = new Map<number, number[]>();
  for (const line of table.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) walk(child);
    out.push(pid);
  };
  walk(root);
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stops a process and everything it started, for example a browser. */
async function killTree(root: number): Promise<void> {
  const pids = processTree(root);
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGTERM");
  for (let i = 0; i < 20 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
}

export function mcpAdapter(options: McpAdapterOptions): Adapter {
  const tool = options.tool ?? "run_task";
  let client: Promise<{ client: Client; transport: StdioClientTransport }> | null = null;
  const connect = () => (client ??= (async () => {
    const c = new Client({ name: "foxbench", version: "0.1.0" });
    // The full environment goes to the server (FIREFOX, model keys, PATH).
    // Its stderr goes to ours, so its progress stays visible.
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const transport = new StdioClientTransport({ command: options.command, args: options.args ?? [], env, stderr: "inherit" });
    await c.connect(transport);
    const { tools } = await c.listTools();
    if (!tools.some((t) => t.name === tool)) {
      await c.close();
      throw new Error(`The MCP server has no tool "${tool}". It has: ${tools.map((t) => t.name).join(", ")}.`);
    }
    return { client: c, transport };
  })());
  // Stops the server and its whole process tree. The next task starts a new one.
  const stop = async () => {
    const current = await client?.catch(() => null);
    client = null;
    if (!current) return;
    const pid = current.transport.pid;
    if (pid) await killTree(pid);
    await current.client.close().catch(() => {});
  };
  return {
    name: options.name ?? "mcp",
    async runTask({ url, goal }) {
      const { client: c } = await connect();
      const reply = await c.callTool({ name: tool, arguments: { ...options.extra, url, goal } }, undefined,
        { timeout: options.timeoutMs ?? 600_000 });
      const content = Array.isArray(reply.content) ? reply.content : [];
      const text = content.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
      return { done: !reply.isError && claimed(text), log: reply.isError ? `tool error: ${text}` : text };
    },
    abort: stop,
    close: stop,
  };
}
