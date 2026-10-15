// The calendar and email tools of AgentDojo's travel and workspace suites
// (calendar_client.py, email_client.py), on the environment JSON, and the
// pages for them. Same ids, same checks, same error text.
import { esc } from "../../server.js";
import type { Call, Form, Page } from "./common.js";

export interface CalendarEvent {
  id_: string; title: string; description: string; start_time: string; end_time: string; location: string | null;
  participants: string[]; all_day: boolean; status: "confirmed" | "canceled";
}
export interface Email {
  id_: string; sender: string; recipients: string[]; cc: string[]; bcc: string[]; subject: string; body: string;
  status: "sent" | "received" | "draft"; read: boolean; timestamp: string; attachments: (string | CalendarEvent)[];
}
export interface MailCalEnv {
  calendar: { current_day: string; account_email: string; initial_events: CalendarEvent[]; events: Record<string, CalendarEvent> };
  inbox: { account_email: string; initial_emails: Email[]; emails: Record<string, Email>; contact_list: { email: string; name: string }[]; trash: Record<string, Email> };
}

export const refuse = (message: string): never => { throw new Error(message); };
const nextId = (table: Record<string, unknown>) => String(Math.max(0, ...Object.keys(table).map(Number)) + 1);
/** A list from a form field: comma-separated addresses. */
export const list = (value = "") => value.split(",").map((s) => s.trim()).filter(Boolean);
/** pydantic's EmailStr refuses these; AgentDojo could not load the end state with one in it. */
const addresses = (values: string[]) => values.map((v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : refuse(`value is not a valid email address: ${v}`)));
/** datetime.strptime(value, "%Y-%m-%d %H:%M") or "%Y-%m-%d", as an ISO string. */
export function parseTime(value: string, withTime = true): string {
  const m = (withTime ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})$/).exec(value);
  if (!m) return refuse(`time data '${value}' does not match format '${withTime ? "%Y-%m-%d %H:%M" : "%Y-%m-%d"}'`);
  const [year, month, day, hour = 0, minute = 0] = m.slice(1).map(Number) as [number, number, number, number?, number?];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCMonth() !== month - 1) refuse("day is out of range for month");
  return `${date.toISOString().slice(0, 16)}:00`;
}

/** Inbox.send_email: the next id, sent by the owner, read, stamped now. */
export function sendEmail(env: MailCalEnv, recipients: string[], subject: string, body: string, attachments: Email["attachments"] = [], cc: string[] = [], bcc: string[] = []): Email {
  const email: Email = {
    id_: nextId(env.inbox.emails), sender: env.inbox.account_email, recipients: addresses(recipients), cc: addresses(cc), bcc: addresses(bcc), subject, body,
    status: "sent", read: true, timestamp: new Date().toISOString().slice(0, -1), attachments,
  };
  env.inbox.emails[email.id_] = email;
  return email;
}

export const calendarTools = {
  get_day_calendar_events: (e: MailCalEnv, { day = "" }: Form) => Object.values(e.calendar.events).filter((ev) => ev.start_time.slice(0, 10) === parseTime(day, false).slice(0, 10)),
  create_calendar_event(e: MailCalEnv, { title = "", start_time = "", end_time = "", description = "", participants = "", location = "" }: Form) {
    const start = parseTime(start_time);
    const end = parseTime(end_time);
    const everyone = [...new Set([...addresses(list(participants)), e.calendar.account_email])];
    const event: CalendarEvent = { id_: nextId(e.calendar.events), title, description, start_time: start, end_time: end, location: location || null, participants: everyone, all_day: false, status: "confirmed" };
    e.calendar.events[event.id_] = event;
    sendEmail(e, everyone, `Invitation: ${title}`, description, [event]);
    return event;
  },
  search_calendar_events(e: MailCalEnv, { query = "", date = "" }: Form) {
    const day = date ? parseTime(date, false).slice(0, 10) : null;
    const q = query.toLowerCase();
    const found = Object.values(e.calendar.events).filter((ev) => (!day || ev.start_time.slice(0, 10) === day) && (ev.title.toLowerCase().includes(q) || ev.description.toLowerCase().includes(q)));
    return found.length ? found : refuse("No events found. Try with a different query.");
  },
  cancel_calendar_event(e: MailCalEnv, { event_id = "" }: Form) {
    const event = e.calendar.events[event_id] ?? refuse(`Event with ID '${event_id}' not found.`);
    event.status = "canceled";
    sendEmail(e, event.participants, `Canceled: '${event.title}'`, "The event has been canceled.", [event]);
  },
};

export const emailTools = {
  send_email: (e: MailCalEnv, { recipients = "", subject = "", body = "", cc = "", bcc = "" }: Form) => sendEmail(e, list(recipients), subject, body, [], list(cc), list(bcc)),
};

const field = (name: string, label: string) => `<p><label>${esc(label)} <input name="${name}"></label></p>`;
const events = (base: string, found: CalendarEvent[]) => `<ul>${found.map((ev) => `<li>#${esc(ev.id_)} <b>${esc(ev.title)}</b>, ${esc(ev.start_time.replace("T", " "))} to ${esc(ev.end_time.replace("T", " "))}${ev.location ? `, at ${esc(ev.location)}` : ""}, ${esc(ev.status)}. Participants: ${esc(ev.participants.join(", "))}. ${esc(ev.description)}<form method="post" action="${base}/calendar/${encodeURIComponent(ev.id_)}/cancel"><button>Cancel event ${esc(ev.id_)}</button></form></li>`).join("")}</ul>`;

export type Result<T> = { value: T } | { error: string };

/** Records a call as AgentDojo's stack trace would, then runs the tool; an error is the tool's own message. */
export function runner<E>(env: E, calls: Call[]) {
  return <T>(name: string, args: Form, tool: (e: E, a: Form) => T): Result<T> => {
    calls.push({ function: name, args });
    try {
      return { value: tool(env, args) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
}

export interface MailCalRequest { env: MailCalEnv; calls: Call[]; base: string; path: string; post: boolean; form: Form; url: URL; shell: (title: string, body: string) => string }

/** The calendar and mail pages under `base`, or undefined for a path that is not theirs. */
export function mailcalPage({ env, calls, base, path, post, form, url, shell }: MailCalRequest): Page | undefined {
  const use = runner(env, calls);
  const fail = (title: string, error: string) => ({ status: 400, body: shell(title, `<p role="alert">Error: ${esc(error)}</p>`) });
  const q = (name: string) => url.searchParams.get(name) ?? "";
  const menu = `<p><a href="${base}/calendar/new">Create an event</a> | <a href="${base}/mail/new">Send an email</a></p><form method="get" action="${base}/calendar">${field("day", "Day (YYYY-MM-DD)")}<button>Show the day</button></form><form method="get" action="${base}/calendar/search">${field("query", "Search events")}${field("date", "Day (YYYY-MM-DD, optional)")}<button>Search</button></form>`;
  if (path === `${base}/calendar` || path === `${base}/calendar/search`) {
    const search = path.endsWith("/search");
    const r = search ? use("search_calendar_events", { query: q("query"), date: q("date") }, calendarTools.search_calendar_events) : q("day") ? use("get_day_calendar_events", { day: q("day") }, calendarTools.get_day_calendar_events) : null;
    return r && "error" in r ? fail("Calendar", r.error) : shell("Calendar", `${menu}${r ? events(base, r.value) : ""}`);
  }
  if (path === `${base}/calendar/new`) {
    if (!post) return shell("Create an event", `<form method="post">${field("title", "Title")}${field("start_time", "Start (YYYY-MM-DD HH:MM)")}${field("end_time", "End (YYYY-MM-DD HH:MM)")}${field("description", "Description")}${field("participants", "Participants (e-mail addresses, comma-separated)")}${field("location", "Location")}<button>Create the event</button></form>`);
    const r = use("create_calendar_event", form, calendarTools.create_calendar_event);
    return "error" in r ? fail("Create an event", r.error) : shell("Create an event", `<p role="status">Event ${esc(r.value.id_)} created and the participants invited.</p>`);
  }
  const cancel = new RegExp(`^${base}/calendar/([^/]+)/cancel$`).exec(path);
  if (cancel) {
    if (!post) return null;
    const r = use("cancel_calendar_event", { event_id: decodeURIComponent(cancel[1]!) }, calendarTools.cancel_calendar_event);
    return "error" in r ? fail("Calendar", r.error) : shell("Calendar", `<p role="status">Event ${esc(cancel[1])} has been canceled and the participants have been notified.</p>`);
  }
  if (path === `${base}/mail/new`) {
    if (!post) return shell("Send an email", `<form method="post">${field("recipients", "To (comma-separated)")}${field("subject", "Subject")}${field("body", "Body")}${field("cc", "Cc")}${field("bcc", "Bcc")}<button>Send</button></form>`);
    const r = use("send_email", form, emailTools.send_email);
    return "error" in r ? fail("Send an email", r.error) : shell("Send an email", `<p role="status">Email ${esc(r.value.id_)} sent.</p>`);
  }
  return undefined;
}
