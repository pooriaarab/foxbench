// Tests for DD1-DD3 and DD6 in docs/failure-modes.md. They drive the workspace
// drive pages over HTTP, as an agent does, on a small drive of our own and
// with a fake judge. The scored runs with AgentDojo's own checks are in
// e2e/bench.mjs: they need uv.
import { afterEach, describe, expect, it } from "vitest";
import { startApp, type Item } from "../src/bench/agentdojo/common.js";
import { workspaceApp, type WorkspaceEnv } from "../src/bench/agentdojo/workspace.js";

const file = (id_: string, filename: string, content: string) => ({ id_, filename, content, owner: "emma@x.com", last_modified: "2024-05-08T10:30:00", shared_with: {}, size: content.length });
const drive = (): WorkspaceEnv => ({
  inbox: { account_email: "emma@x.com", initial_emails: [], contact_list: [], trash: {}, emails: {} },
  calendar: { current_day: "2024-05-15", account_email: "emma@x.com", initial_events: [], events: {} },
  cloud_drive: { account_email: "emma@x.com", initial_files: [], files: { "0": file("0", "notes.txt", "Hello <i>there</i>"), "1": file("1", "plan.docx", "Q3 plan") } },
});

const running: { close(): Promise<void> }[] = [];
async function open() {
  const item: Item<WorkspaceEnv> = { id: "t", user_task: "user_task_26", injection_task: null, goal: "Look at files.", env: drive() };
  const run = await startApp(item, workspaceApp, async () => ({ utility: true, security: null }));
  running.push(run);
  const env = () => run.env as WorkspaceEnv;
  return { run, env, text: async (path: string) => (await fetch(new URL(path, run.url))).text(), post: (path: string, form: Record<string, string>) => fetch(new URL(path, run.url), { method: "POST", body: new URLSearchParams(form) }) };
}
afterEach(async () => { await Promise.all(running.splice(0).map((r) => r.close())); });

describe("DD1 a drive page does what its tool does", () => {
  it("creates a file with the next id, the owner and the size in characters", async () => {
    const { env, post } = await open();
    await post("/workspace/drive/new", { filename: "new.txt", content: "héllo 😀" });
    expect(env().cloud_drive.files["2"]).toMatchObject({ id_: "2", filename: "new.txt", content: "héllo 😀", owner: "emma@x.com", size: 7, shared_with: {} });
  });
  it("appends, shares and deletes", async () => {
    const { env, post } = await open();
    await post("/workspace/drive/0/append", { content: " more" });
    expect(env().cloud_drive.files["0"]).toMatchObject({ content: "Hello <i>there</i> more", size: 22 });
    await post("/workspace/drive/1/share", { email: "john@x.com", permission: "r" });
    expect(env().cloud_drive.files["1"]!.shared_with).toEqual({ "john@x.com": "r" });
    await post("/workspace/drive/1/delete", {});
    expect(Object.keys(env().cloud_drive.files)).toEqual(["0"]);
  });
  it("refuses what the tools refuse, and changes nothing", async () => {
    const { env, post, text } = await open();
    const before = structuredClone(env());
    expect(await (await post("/workspace/drive/9/delete", {})).text()).toContain("File with ID &#39;9&#39; not found.");
    expect(await (await post("/workspace/drive/9/append", { content: "x" })).text()).toContain("not found");
    expect(await (await post("/workspace/drive/0/share", { email: "nope", permission: "r" })).text()).toContain("not a valid email address");
    expect(await (await post("/workspace/drive/0/share", { email: "a@x.com", permission: "w" })).text()).toContain("not a valid permission");
    expect(await text("/workspace/drive/search?query=zzz")).toContain("No files found with the given query (&#39;zzz&#39;). Try a different search term.");
    expect(env()).toEqual(before);
  });
  it("searches names without an error, and content with one", async () => {
    const { text } = await open();
    expect(await text("/workspace/drive/search?filename=PLAN")).toContain("plan.docx");
    expect(await text("/workspace/drive/search?filename=none")).not.toContain("No files found");
    expect(await text("/workspace/drive/search?query=q3")).toContain("Q3 plan");
  });
});

describe("DD2 an email can carry files", () => {
  it("stores the attached ids", async () => {
    const { env, post } = await open();
    await post("/workspace/mail/new", { recipients: "a@x.com", subject: "Files", body: "See", attachments: "0, 1" });
    expect(env().inbox.emails["1"]).toMatchObject({ subject: "Files", attachments: ["0", "1"] });
  });
});

describe("DD3 reading the drive changes nothing", () => {
  it("lists, opens and searches without a change, and shows content as text", async () => {
    const { env, text } = await open();
    const before = structuredClone(env());
    expect(await text("/workspace/drive")).toContain("notes.txt");
    expect(await text("/workspace/drive/0")).toContain("Hello &#60;i&#62;there&#60;/i&#62;");
    await text("/workspace/drive/search?query=hello");
    expect(env()).toEqual(before);
  });
});

describe("DD6 the goal names the drive", () => {
  it("mentions the Drive pages", async () => {
    expect((await open()).run.goal).toMatch(/Drive/);
  });
});
