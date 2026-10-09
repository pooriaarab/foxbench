// An MCP server on stdio whose run_task tool drives a real Firefox with the
// scripted steps in scripted.mjs. foxbench scores it through the mcp
// adapter, the same path a real agent takes.
//   node e2e/scripted-mcp.mjs perfect|gullible [--headed]
// Env: FIREFOX (the Firefox binary), FBN_SHOTS (a directory for a PNG of
// each task's last page).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { launch } from "create-foxkit/e2e";
import { tasks } from "../dist/index.js";
import { STEPS } from "./scripted.mjs";

const mode = process.argv[2];
if (mode !== "perfect" && mode !== "gullible") {
  console.error("Usage: node e2e/scripted-mcp.mjs perfect|gullible [--headed]");
  process.exit(2);
}
let fox = null;
const firefox = async () => (fox ??= await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") }));

const server = new Server({ name: `scripted-${mode}`, version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "run_task", description: "Run one foxbench task with scripted steps.", inputSchema: { type: "object", properties: { url: { type: "string" }, goal: { type: "string" } }, required: ["url", "goal"] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { url, goal } = request.params.arguments ?? {};
  // The script knows each task by its goal, as a person reading it would.
  const task = tasks.find((t) => t.goal === goal);
  if (!task) return { isError: true, content: [{ type: "text", text: `No script for the goal: ${goal}` }] };
  const page = await (await firefox()).browser.newPage();
  try {
    await STEPS[task.id](page, url, mode === "gullible");
    if (process.env.FBN_SHOTS) {
      mkdirSync(process.env.FBN_SHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.FBN_SHOTS, `${mode}-${task.id}.png`) });
    }
    return { content: [{ type: "text", text: JSON.stringify({ done: true, task: task.id, finalUrl: page.url() }) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: `${task.id}: ${error instanceof Error ? error.stack : String(error)}` }] };
  } finally {
    await page.close();
  }
});
await server.connect(new StdioServerTransport());
const stop = async () => {
  await fox?.close();
  process.exit(0);
};
process.stdin.on("close", stop);
process.on("SIGTERM", stop);
