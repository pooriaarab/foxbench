// The scripted agent of the Gaia2 page tests: it does ARE's oracle actions
// through the app pages, as a browser agent would, on ARE's clock.
import type { Adapter } from "../../src/adapter.js";
import { startBridge, type Gaia2Bridge, type OracleCall } from "../../src/bench/gaia2/bridge.js";
import { gaia2Benchmark } from "../../src/bench/gaia2/index.js";
import { benchContext } from "../../src/bench/registry.js";
import { runBenchmarks } from "../../src/bench/run.js";

const ctx = benchContext();
export interface Oracle { order: string[]; steps: Map<string, OracleCall[]>; close(): Promise<void> }
/** ARE's oracle actions for `ids` (all in the execution capability), in the order the benchmark lists the cases. */
export async function loadOracle(ids: string[]): Promise<Oracle> {
  const listed = await gaia2Benchmark({ configs: ["execution"] }).load(ctx, "full");
  const order = listed.map((c) => c.id).filter((id) => ids.includes(id));
  const bridge: Gaia2Bridge = await startBridge(ctx, undefined, ["execution"]);
  const steps = new Map<string, OracleCall[]>();
  for (const id of order) {
    await bridge.start(id, "execution", false);
    steps.set(id, await bridge.oracle());
  }
  return { order, steps, close: () => bridge.close() };
}

const csv = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
const str = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
/** The page and form fields for one oracle action; other apps use the generic form. */
function pageStep(s: OracleCall): [string, Record<string, string>] {
  const a = s.args as Record<string, any>;
  const mail = (action: string) => `/mail/${a.folder_name ?? a.source_folder_name ?? "INBOX"}/${a.email_id}/${action}`;
  switch (`${s.app}.${s.tool}`) {
    case "Emails.send_email": return ["/mail/compose", str({ ...a, recipients: csv(a.recipients), cc: csv(a.cc), attachment_paths: csv(a.attachment_paths) })];
    case "Emails.reply_to_email": return [mail("reply"), str({ content: a.content, attachment_paths: csv(a.attachment_paths) })];
    case "Emails.forward_email": return [mail("forward"), { recipients: csv(a.recipients) }];
    case "Emails.move_email": return [mail("move"), str({ dest_folder_name: a.dest_folder_name })];
    case "Emails.delete_email": return [mail("delete"), {}];
    case "Calendar.add_calendar_event": return ["/calendar/new", str({ ...a, attendees: csv(a.attendees) })];
    case "Calendar.delete_calendar_event": return [`/calendar/events/${a.event_id}/delete`, {}];
    case "Contacts.add_new_contact": return ["/contacts/new", str(a)];
    case "Contacts.edit_contact": return [`/contacts/${a.contact_id}/edit`, str({ ...a.updates, ...Object.fromEntries(Object.keys(a.updates).map((k) => [`was_${k}`, "was"])) })];
    case "Contacts.delete_contact": return [`/contacts/${a.contact_id}/delete`, {}];
    case "Chats.send_message": case "Messages.send_message": return [`/${s.app.toLowerCase()}/send`, str(a)];
    case "Chats.send_message_to_group_conversation": case "Messages.send_message_to_group_conversation": return [`/${s.app.toLowerCase()}/${a.conversation_id}/send`, str(a)];
    case "Chats.create_group_conversation": case "Messages.create_group_conversation": return [`/${s.app.toLowerCase()}/new`, str({ ...a, user_ids: csv(a.user_ids) })];
    case "Shopping.add_to_cart": return ["/shop/cart/add", str(a)];
    case "Shopping.checkout": return ["/shop/cart/checkout", str(a)];
    case "Files.mkdir": case "Files.mv": case "Files.rm": return [`/files/${s.tool}`, str(a)];
    default: return [`/apps/${s.app}/${s.tool}`, { go: "1", ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) }];
  }
}
/** `browse` first looks at these pages; a view that wrote would break ARE's action counts. `wrong` leaves out the last action. */
export function pageAgent(oracle: Oracle, mode: "perfect" | "wrong", ids: string[], browse: string[] = []): Adapter {
  const queue = [...ids];
  return { name: mode, async runTask({ url }) {
    for (const path of browse) await fetch(new URL(path, url));
    const t0 = Date.now();
    let calls = oracle.steps.get(queue.shift()!)!;
    if (mode === "wrong") calls = calls.slice(0, -1);
    // An id ARE's oracle run made (a sent email, a new group) is another id in this run: the page shows it, and later actions use it.
    const made = new Map<string, string>();
    for (const s of calls) {
      await new Promise((r) => setTimeout(r, Math.max(0, s.at * 1000 - (Date.now() - t0))));
      const args = JSON.parse([...made].reduce((t, [from, to]) => t.replaceAll(from, to), JSON.stringify(s.args)));
      const [path, fields] = pageStep({ ...s, args });
      const shown = /<pre>([^<]*)<\/pre>/.exec(await (await fetch(new URL(path, url), { method: "POST", body: new URLSearchParams(fields) })).text())?.[1];
      if (typeof s.result === "string" && shown) made.set(s.result, shown);
    }
    return { done: true, log: mode };
  } };
}
export const runGaia2 = (adapter: Adapter, ids: string[]) => runBenchmarks({ adapter, runs: [{ benchmark: gaia2Benchmark({ configs: ["execution"] }), subset: "full" }], ids, timeoutMs: 180_000 });
