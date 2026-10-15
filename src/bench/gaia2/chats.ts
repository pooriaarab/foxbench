// The chat pages, over ARE's Chats and Messages apps (the same tools): recent
// conversations, a conversation with its messages, a name lookup, and forms to
// send, start a group, retitle, and add or remove a member.
import { commas, done, esc, form, input, next, stamp, type Handler } from "./pages.js";

/** ARE refuses a longer list: 5 conversations, 10 messages. */
const LIMIT = 5;
interface Conversation { conversation_id: string; title: string | null; participant_ids: string[]; messages: { content: string }[]; last_updated: number }
const text = `<p><label>Message <textarea name="content"></textarea></label></p>${input("attachment_path", "Attach a file (path)")}`;

export const conversations = (app: "Chats" | "Messages", base: string): Handler => async (api, { path, query, form: posted }) => {
  if (path === base) {
    const offset = Number(query.get("offset") ?? 0);
    const list: Conversation[] = await api.call(app, "list_recent_conversations", { offset, limit: LIMIT });
    const rows = list.map((c) => `<li><a href="${base}/${c.conversation_id}">${esc(c.title ?? c.participant_ids.join(", "))}</a> (${esc(c.participant_ids.join(", "))}), ${stamp(c.last_updated)}: ${esc(c.messages[0]?.content.slice(0, 80))}</li>`);
    const lookup = `<form action="${base}/lookup">${input("name", "Find a person's id by name")}<button>Find</button></form>`;
    return { title: app, body: `<p><a href="${base}/new">New group</a></p>${lookup}<ol>${rows.join("")}</ol>${list.length === LIMIT ? next(path, query, offset, list.length, offset + list.length + 1) : ""}${form(`${base}/send`, "Send to a person", input("user_id", "user_id") + text)}` };
  }
  if (path === `${base}/lookup`) return { title: "People", body: `<pre>${esc(JSON.stringify(await api.call(app, "lookup_user_id", { user_name: query.get("name") })))}</pre>` };
  if (path === `${base}/new`) {
    if (!posted) return { title: "New group", body: form(path, "Create", input("user_ids", "user_ids (commas)") + input("title", "Title")) };
    return done(await api.call(app, "create_group_conversation", { user_ids: commas(posted.get("user_ids")), title: posted.get("title") }));
  }
  if (path === `${base}/send` && posted) return done(await api.call(app, "send_message", { user_id: posted.get("user_id"), content: posted.get("content"), attachment_path: posted.get("attachment_path") }));
  const person = new RegExp(`^${base}/users/([\\w-]+)$`).exec(path);
  if (person) return { title: "Person", body: `<p>${esc(await api.call(app, "get_user_name_from_id", { user_id: person[1] }))}</p>` };
  const m = new RegExp(`^${base}/(\\w+)(?:/(send|title|add|remove))?$`).exec(path);
  if (!m) return null;
  const id = m[1]!;
  if (posted && m[2]) {
    const tools = { send: "send_message_to_group_conversation", title: "change_conversation_title", add: "add_participant_to_conversation", remove: "remove_participant_from_conversation" } as const;
    return done(await api.call(app, tools[m[2] as keyof typeof tools], { conversation_id: id, content: posted.get("content"), attachment_path: posted.get("attachment_path"), title: posted.get("title"), user_id: posted.get("user_id") }));
  }
  const offset = Number(query.get("offset") ?? 0);
  const c = await api.call(app, "read_conversation", { conversation_id: id, offset, limit: 10 });
  const rows = c.messages.map((x: { sender_id: string; timestamp: number; content: string }) => `<li><a href="${base}/users/${esc(x.sender_id)}">${esc(x.sender_id)}</a> at ${stamp(x.timestamp)}: ${esc(x.content)}</li>`);
  return { title: c.metadata.conversation_title ?? "Conversation", body: `<ol>${rows.join("")}</ol>${next(path, query, offset, c.messages.length, c.metadata.conversation_length)}`
    + form(`${path}/send`, "Send to the group", text) + form(`${path}/title`, "Change the title", input("title", "title")) + form(`${path}/add`, "Add a person", input("user_id", "user_id")) + form(`${path}/remove`, "Remove a person", input("user_id", "user_id")) };
};
export const chats = conversations("Chats", "/chats");
export const messages = conversations("Messages", "/messages");
