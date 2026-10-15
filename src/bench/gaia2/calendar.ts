// The calendar pages, over ARE's Calendar app: today or a range, search, tags,
// an event with its delete form, and a form to add one.
import { commas, done, esc, form, input, next, stamp, type Handler } from "./pages.js";

const LIMIT = 10;
interface Event { event_id: string; title: string; start_datetime: number; end_datetime: number; tag: string | null; description: string | null; location: string | null; attendees: string[] }
const row = (e: Event) => `<li><a href="/calendar/events/${esc(e.event_id)}">${esc(e.title)}</a>, ${stamp(e.start_datetime)} to ${stamp(e.end_datetime)}${e.location ? ` at ${esc(e.location)}` : ""}</li>`;
const FIELDS = ["title", "start_datetime", "end_datetime", "tag", "description", "location"];

export const calendar: Handler = async (api, { path, query, form: posted }) => {
  if (path === "/calendar") {
    const [from, to, q, tag] = ["from", "to", "q", "tag"].map((k) => query.get(k));
    const offset = Number(query.get("offset") ?? 0);
    const found = q ? await api.call("Calendar", "search_events", { query: q }) : tag ? await api.call("Calendar", "get_calendar_events_by_tag", { tag })
      : from && to ? await api.call("Calendar", "get_calendar_events_from_to", { start_datetime: from, end_datetime: to, offset, limit: LIMIT }) : await api.call("Calendar", "read_today_calendar_events");
    const events: Event[] = Array.isArray(found) ? found : found.events;
    const tags: string[] = await api.call("Calendar", "get_all_tags");
    const range = `<form>${input("from", "From (YYYY-MM-DD HH:MM:SS)", from)}${input("to", "To (YYYY-MM-DD HH:MM:SS)", to)}<button>Show</button></form><form>${input("q", "Search", q)}<button>Search</button></form>`;
    return { title: "Calendar", body: `<p><a href="/calendar">Today</a> · <a href="/calendar/new">Add an event</a> · Tags: ${tags.map((t) => `<a href="/calendar?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join(" ")}</p>${range}<ol>${events.map(row).join("")}</ol>${found.total === undefined ? "" : next(path, query, offset, events.length, found.total)}` };
  }
  if (path === "/calendar/new") {
    if (!posted) return { title: "Add an event", body: form(path, "Add", FIELDS.map((f) => input(f, f)).join("") + input("attendees", "attendees (commas)")) };
    return done(await api.call("Calendar", "add_calendar_event", { ...Object.fromEntries(FIELDS.map((f) => [f, posted.get(f)])), attendees: commas(posted.get("attendees")) }));
  }
  const m = /^\/calendar\/events\/(\w+)(\/delete)?$/.exec(path);
  if (!m) return null;
  if (posted && m[2]) return done(await api.call("Calendar", "delete_calendar_event", { event_id: m[1] }));
  const e: Event = await api.call("Calendar", "get_calendar_event", { event_id: m[1] });
  return { title: e.title, body: `<p>${stamp(e.start_datetime)} to ${stamp(e.end_datetime)}${e.location ? ` at ${esc(e.location)}` : ""}${e.tag ? `, ${esc(e.tag)}` : ""}</p><p>${esc(e.description)}</p><p>With ${esc(e.attendees.join(", "))}</p>${form(`${path}/delete`, "Delete", "")}` };
};
