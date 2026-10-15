// The contacts pages, over ARE's Contacts app: a paged list, search, a card
// with its edit and delete forms, the user's own card, and a form to add one.
import { done, esc, form, input, next, type Handler } from "./pages.js";

const FIELDS = ["first_name", "last_name", "gender", "age", "nationality", "city_living", "country", "status", "job", "description", "phone", "email", "address"];
type Contact = Record<string, unknown> & { contact_id: string; first_name: string; last_name: string };
const row = (c: Contact) => `<li><a href="/contacts/${esc(c.contact_id)}">${esc(c.first_name)} ${esc(c.last_name)}</a>${c.is_user ? " (you)" : ""}</li>`;
/** An age is a number for ARE; every other field is text. */
const typed = (field: string, value: string) => (field === "age" ? Number(value) : value);

export const contacts: Handler = async (api, { path, query, form: posted }) => {
  if (path === "/contacts") {
    const q = query.get("q");
    const offset = Number(query.get("offset") ?? 0);
    const found = q ? await api.call("Contacts", "search_contacts", { query: q }) : await api.call("Contacts", "get_contacts", { offset });
    const list: Contact[] = Array.isArray(found) ? found : found.contacts;
    return { title: "Contacts", body: `<p><a href="/contacts/me">Your card</a> · <a href="/contacts/new">Add a contact</a></p><form>${input("q", "Search", q)}<button>Search</button></form><ol>${list.map(row).join("")}</ol>${found.metadata ? next(path, query, offset, list.length, found.metadata.total) : ""}` };
  }
  if (path === "/contacts/new") {
    if (!posted) return { title: "Add a contact", body: form(path, "Add", FIELDS.map((f) => input(f, f)).join("")) };
    return done(await api.call("Contacts", "add_new_contact", Object.fromEntries(FIELDS.map((f) => [f, posted.get(f)]))));
  }
  const m = /^\/contacts\/(\w+)(?:\/(edit|delete))?$/.exec(path);
  if (!m) return null;
  const id = m[1]!;
  if (posted && m[2] === "delete") return done(await api.call("Contacts", "delete_contact", { contact_id: id }));
  if (posted && m[2] === "edit") {
    // The form carries each field's old value as was_<field>; only a changed field is an update.
    const updates = Object.fromEntries(FIELDS.filter((f) => posted.has(f) && posted.get(f) !== posted.get(`was_${f}`)).map((f) => [f, typed(f, posted.get(f)!)]));
    return done(await api.call("Contacts", "edit_contact", { contact_id: id, updates }));
  }
  const c: Contact = id === "me" ? await api.call("Contacts", "get_current_user_details") : await api.call("Contacts", "get_contact", { contact_id: id });
  const fields = FIELDS.map((f) => input(f, f, c[f]) + `<input type="hidden" name="was_${f}" value="${esc(c[f])}">`).join("");
  return { title: `${c.first_name} ${c.last_name}`, body: `<dl>${FIELDS.map((f) => `<dt>${f}</dt><dd>${esc(c[f])}</dd>`).join("")}</dl>${form(`/contacts/${c.contact_id}/edit`, "Edit", fields)}${form(`/contacts/${c.contact_id}/delete`, "Delete", "")}` };
};
