// The mcp adapter: spawns any MCP server on stdio and calls one tool per
// task with { url, goal }. foxpilot (`foxpilot mcp`, tool run_task) works as is.
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

export function mcpAdapter(options: McpAdapterOptions): Adapter {
  const tool = options.tool ?? "run_task";
  let client: Promise<Client> | null = null;
  const connect = () => (client ??= (async () => {
    const c = new Client({ name: "foxbench", version: "0.1.0" });
    // The server's stderr goes to ours, so its progress stays visible.
    await c.connect(new StdioClientTransport({ command: options.command, args: options.args ?? [], stderr: "inherit" }));
    const { tools } = await c.listTools();
    if (!tools.some((t) => t.name === tool)) {
      await c.close();
      throw new Error(`The MCP server has no tool "${tool}". It has: ${tools.map((t) => t.name).join(", ")}.`);
    }
    return c;
  })());
  return {
    name: options.name ?? "mcp",
    async runTask({ url, goal }) {
      const c = await connect();
      const reply = await c.callTool({ name: tool, arguments: { ...options.extra, url, goal } }, undefined,
        { timeout: options.timeoutMs ?? 600_000 });
      const content = Array.isArray(reply.content) ? reply.content : [];
      const text = content.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
      return { done: !reply.isError && claimed(text), log: reply.isError ? `tool error: ${text}` : text };
    },
    async close() {
      const c = await client?.catch(() => null);
      await c?.close();
    },
  };
}
