// Tests for DW1-DW3 and DW6 in docs/failure-modes.md. They drive the workspace
// app over HTTP, as an agent does, on a small mailbox of our own and with a
// fake judge. The scored runs with AgentDojo's own checks are in e2e/bench.mjs:
// they need uv.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { casesFile, startApp, type Item } from "../src/bench/agentdojo/common.js";
import type { Email } from "../src/bench/agentdojo/mailcal.js";
import { workspaceApp, workspaceBenchmark, type WorkspaceEnv } from "../src/bench/agentdojo/workspace.js";
import { benchContext, benchmarkById, resolveSuites } from "../src/bench/registry.js";

const mail = (id_: string, over: Partial<Email>): Email => ({ id_, sender: "lily@x.com", recipients: ["emma@x.com"], cc: [], bcc: [], subject: "Hi", body: "Party", status: "received", read: true, timestamp: "2024-05-14T11:00:00", attachments: [], ...over });
const mailbox = (): WorkspaceEnv => ({
  inbox: { account_email: "emma@x.com", initial_emails: [], contact_list: [{ email: "lily@x.com", name: "Lily White" }], trash: {}, emails: { "0": mail("0", {}), "1": mail("1", { subject: "Code", body: "Your code is 4638", read: false }), "2": mail("2", { sender: "emma@x.com", status: "sent", recipients: ["lily@x.com"], body: "Sure" }) } },
  calendar: { current_day: "2024-05-15", account_email: "emma@x.com", initial_events: [], events: { "0": { id_: "0", title: "Sync", description: "Weekly", start_time: "2024-05-15T10:00:00", end_time: "2024-05-15T11:30:00", location: null, participants: ["emma@x.com", "bob@x.com"], all_day: false, status: "confirmed" } } },
  cloud_drive: {},
});

const calls = (...names: string[]) => names.map((name) => ({ function: name, args: {} }));
const offered = (id: string, gt: string[], attack?: string[]) => ({ id, user_task: id, injection_task: attack ? "injection_task_1" : null, goal: id, env: mailbox(), ground_truth: calls(...gt), injection_ground_truth: attack ? calls(...attack) : null });
const running: { close(): Promise<void> }[] = [];
async function open() {
  const item: Item<WorkspaceEnv> = { id: "t", user_task: "user_task_0", injection_task: null, goal: "Check mail.", env: mailbox() };
  const run = await startApp(item, workspaceApp, async () => ({ utility: true, security: null }));
  running.push(run);
  const env = () => run.env as WorkspaceEnv;
  return { run, env, text: async (path: string) => (await fetch(new URL(path, run.url))).text(), post: (path: string, form: Record<string, string>) => fetch(new URL(path, run.url), { method: "POST", body: new URLSearchParams(form) }) };
}
afterEach(async () => { await Promise.all(running.splice(0).map((r) => r.close())); });

describe("DW1 a page does what its tool does", () => {
  it("searches text and sender, and says so when nothing matches", async () => {
    const { text } = await open();
    expect(await text("/workspace/mail/search?query=CODE")).toContain("Your code is 4638");
    expect(await text("/workspace/mail/search?query=sure&sender=EMMA@x.com")).toContain("Sure");
    expect(await text("/workspace/mail/search?query=sure&sender=lily@x.com")).toContain("No emails found. Try with a different query.");
    expect(await text("/workspace/contacts?name=white")).toContain("Lily White");
    expect(await text("/workspace/contacts?email=nobody")).toContain("Contact with email &#39;nobody&#39; not found.");
  });
  it("deletes to the trash", async () => {
    const { env, post } = await open();
    await post("/workspace/mail/0/delete", {});
    expect(Object.keys(env().inbox.emails)).toEqual(["1", "2"]);
    expect(env().inbox.trash["0"]).toMatchObject({ id_: "0" });
    expect(await (await post("/workspace/mail/9/delete", {})).text()).toContain("Email with ID &#39;9&#39; not found.");
  });
  it("reschedules keeping the length, and adds participants without deduplicating", async () => {
    const { env, post } = await open();
    await post("/workspace/calendar/0/reschedule", { new_start_time: "2024-05-16 09:00" });
    expect(env().calendar.events["0"]).toMatchObject({ start_time: "2024-05-16T09:00:00", end_time: "2024-05-16T10:30:00" });
    expect(env().inbox.emails["3"]).toMatchObject({ subject: "Rescheduled: '{event.title}'", body: "The event has been rescheduled. It will start on  2024-05-16 at 09:00:00 and end on 2024-05-16 at 10:30:00.", recipients: ["emma@x.com", "bob@x.com"] });
    await post("/workspace/calendar/0/participants", { participants: "bob@x.com, c@x.com" });
    expect(env().calendar.events["0"]!.participants).toEqual(["emma@x.com", "bob@x.com", "bob@x.com", "c@x.com"]);
  });
  it("shows the current day", async () => {
    expect(await (await open()).text("/workspace/today")).toContain("Today is 2024-05-15.");
  });
});

describe("DW2 only the Unread page marks mail read", () => {
  it("leaves the read flags alone on every other page", async () => {
    const { env, text } = await open();
    for (const path of ["/workspace/mail/inbox", "/workspace/mail/sent", "/workspace/mail/drafts", "/workspace/mail/search?query=code", "/workspace/calendar?day=2024-05-15"]) await text(path);
    expect(env().inbox.emails["1"]!.read).toBe(false);
    expect(await text("/workspace/mail/inbox")).toContain(", unread)");
  });
  it("marks mail read and lists it", async () => {
    const { env, text } = await open();
    expect(await text("/workspace/mail/unread")).toContain("Your code is 4638");
    expect(env().inbox.emails["1"]!.read).toBe(true);
    expect(await text("/workspace/mail/unread")).not.toContain("Your code is 4638");
  });
});

describe("DW3 only cases with a page for every call are offered", () => {
  it("offers mail cases, with or without a mail attack, and withholds drive cases", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "fbn-ws-"));
    writeFileSync(casesFile(cacheDir, "workspace"), JSON.stringify([offered("a", ["search_emails"]), offered("b", ["list_files"]), offered("c", ["search_emails"], ["delete_file"]), offered("d", ["search_emails"], ["send_email"]), offered("e", ["search_emails"], [])]));
    expect((await workspaceBenchmark.load(benchContext({ cacheDir }), "full")).map((c) => c.id)).toEqual(["a", "d", "e"]);
  });
});

describe("DW6 the suite is registered and the goal names the app", () => {
  it("registers the suite under its own id and names uv when it is missing", async () => {
    expect(resolveSuites("agentdojo-workspace")[0]!.benchmark.id).toBe("agentdojo-workspace");
    expect(await benchmarkById("agentdojo-workspace")!.check(benchContext({ env: { PATH: "/nonexistent" } }))).toMatchObject({ ready: false, reason: expect.stringContaining("uv") });
  });
  it("starts with the app sentence, then the task", async () => {
    const { run } = await open();
    expect(run.goal).toMatch(/^You .*workspace web app.*Inbox.*Calendar/);
    expect(run.goal.endsWith("Check mail.")).toBe(true);
    expect(run.startPath).toBe("/workspace/");
  });
});
