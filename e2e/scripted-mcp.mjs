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
import { browserMode, launch, tunnel } from "create-foxkit/e2e";
import { tasks } from "../dist/index.js";
import { STEPS } from "./scripted.mjs";

const mode = process.argv[2];
if (mode !== "perfect" && mode !== "gullible") {
  console.error("Usage: node e2e/scripted-mcp.mjs perfect|gullible [--headed]");
  process.exit(2);
}
let fox = null;
const firefox = async () => (fox ??= await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") }));

// On Ichabod the browser cannot reach 127.0.0.1. Each task's server goes
// through the shared tunnel, and the steps open its public URL. The steps
// build URLs such as new URL("/mail/", url), which drop the mount path, so
// goto() puts it back. Links and forms in the pages keep working: the tunnel
// routes an absolute path by its Referer. Locally nothing changes.
const remote = browserMode() === "ichabod";
const mounts = new Map();
async function publicUrl(url) {
  if (!remote) return url;
  const local = new URL(url);
  if (!mounts.has(local.origin)) mounts.set(local.origin, tunnel(Number(local.port)).then((t) => t.url));
  return `${await mounts.get(local.origin)}${local.pathname}${local.search}${local.hash}`;
}
function onMount(page, mountUrl) {
  if (!remote) return page;
  const { origin, pathname: prefix } = new URL(mountUrl);
  const goto = page.goto.bind(page);
  page.goto = (target, options) => {
    const next = new URL(target);
    if (next.origin === origin && !next.pathname.startsWith(`${prefix}/`)) next.pathname = `${prefix}${next.pathname}`;
    return goto(next.href, options);
  };
  return page;
}

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
    const start = await publicUrl(url);
    await STEPS[task.id](onMount(page, start), start, mode === "gullible");
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
