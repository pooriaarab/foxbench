// A tiny MCP server for tests/runner.test.ts. run_task returns its pid and
// the FBN_PROBE environment variable. A goal that contains "hang" never
// returns. With FBN_CHILD_FILE set, it starts a long sleep (like a browser)
// and writes the sleep's pid to that file.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FBN_CHILD_FILE) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  writeFileSync(process.env.FBN_CHILD_FILE, String(child.pid));
}
const server = new Server({ name: "fixture", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "run_task", inputSchema: { type: "object", properties: { url: { type: "string" }, goal: { type: "string" } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (String(request.params.arguments?.goal).includes("hang")) await new Promise(() => {});
  return { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, probe: process.env.FBN_PROBE ?? null }) }] };
});
await server.connect(new StdioServerTransport());
