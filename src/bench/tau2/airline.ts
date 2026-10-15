// tau2 airline as a web site: an airline's reservations desk. Each page view
// and each form is one call of a tau2 airline tool, run by tau2 through the
// bridge (desk.ts). Lists (flights, passengers, payments) are rows of fields;
// an empty row is left out.
import type { Tau2Bridge } from "./bridge.js";
import { commonPage, esc, field, formOf, startDesk, type Tau2Site } from "./desk.js";

/** The airline tools that change the database (tau2's ToolType.WRITE). */
export const AIRLINE_WRITES = new Set(["book_reservation", "cancel_reservation", "send_certificate", "update_reservation_baggages", "update_reservation_flights", "update_reservation_passengers"]);

const ROWS = { flights: 4, passengers: 5, payments: 4 };
type Row = Record<string, unknown>;

/** User and reservation ids become links (T6). */
function link(text: string, key: string): string | null {
  if (key === "user_id") return `/users/${encodeURIComponent(text)}`;
  if ((key === "reservation_id" || key === "reservations") && /^[A-Z0-9]{6}$/.test(text)) return `/reservations/${text}`;
  return null;
}

const select = (name: string, options: string[], chosen = "") => `<p><label>${name} <select name="${name}">${options.map((o) => `<option${o === chosen ? " selected" : ""}>${o}</option>`).join("")}</select></label></p>`;
/** `count` rows of fields; row i's field f is named f_i and filled from `filled[i]`. */
const rowsOf = (title: string, fields: string[], count: number, filled: Row[] = []) => `<fieldset><legend>${title}</legend>${Array.from({ length: count }, (_, i) =>
  `<p>${fields.map((f) => `<label>${f} ${i + 1} <input name="${f}_${i}" value="${esc(filled[i]?.[f] ?? "")}"></label>`).join(" ")}</p>`).join("")}</fieldset>`;
const FLIGHT = ["flight_number", "date"];
const PASSENGER = ["first_name", "last_name", "dob"];
const PAYMENT = ["payment_id", "amount"];
const CABINS = ["basic_economy", "economy", "business"];

/** The filled rows of a list, in row order. Numbers stay numbers, as tau2's gold arguments have them. */
function rows(form: URLSearchParams, fields: string[], count: number, numbers: string[] = []): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < count; i++) {
    if (!form.get(`${fields[0]}_${i}`)?.trim()) continue;
    out.push(Object.fromEntries(fields.map((f) => [f, numbers.includes(f) ? Number(form.get(`${f}_${i}`)) : (form.get(`${f}_${i}`) ?? "").trim()])));
  }
  return out;
}

function reservationForms(path: string, r: { cabin?: string; flights?: Row[]; passengers?: Row[] }): string {
  return formOf(`${path}/cancel`, "Cancel reservation", "")
    + formOf(`${path}/flights`, "Change flights", select("cabin", CABINS, r.cabin) + rowsOf("Flights", FLIGHT, ROWS.flights, r.flights) + field("payment_id", "Payment id"))
    + formOf(`${path}/baggages`, "Change baggage", field("total_baggages", "Total bags") + field("nonfree_baggages", "Non-free bags") + field("payment_id", "Payment id"))
    + formOf(`${path}/passengers`, "Change passengers", rowsOf("Passengers", PASSENGER, ROWS.passengers, r.passengers));
}

const bookForm = (path: string) => formOf(`${path}/book`, "Book a reservation", field("origin", "Origin (IATA)") + field("destination", "Destination (IATA)")
  + select("flight_type", ["one_way", "round_trip"]) + select("cabin", CABINS) + rowsOf("Flights", FLIGHT, ROWS.flights) + rowsOf("Passengers", PASSENGER, ROWS.passengers)
  + rowsOf("Payments", PAYMENT, ROWS.payments) + field("total_baggages", "Total bags") + field("nonfree_baggages", "Non-free bags") + select("insurance", ["no", "yes"]));

/** The tool call and its arguments for a form post, or null for an unknown form. */
function writeCall(path: string, form: URLSearchParams): { name: string; args: Record<string, unknown> } | null {
  const text = (f: string) => (form.get(f) ?? "").trim();
  const int = (f: string) => Number(text(f));
  if (path === "/transfer") return { name: "transfer_to_human_agents", args: { summary: text("summary") } };
  const user = /^\/users\/([^/]+)\/(book|certificate)$/.exec(path);
  if (user) {
    const user_id = decodeURIComponent(user[1]!);
    if (user[2] === "certificate") return { name: "send_certificate", args: { user_id, amount: int("amount") } };
    return { name: "book_reservation", args: { user_id, origin: text("origin"), destination: text("destination"), flight_type: text("flight_type"), cabin: text("cabin"),
      flights: rows(form, FLIGHT, ROWS.flights), passengers: rows(form, PASSENGER, ROWS.passengers), payment_methods: rows(form, PAYMENT, ROWS.payments, ["amount"]),
      total_baggages: int("total_baggages"), nonfree_baggages: int("nonfree_baggages"), insurance: text("insurance") } };
  }
  const m = /^\/reservations\/(\w+)\/(\w+)$/.exec(path);
  if (!m) return null;
  const reservation_id = m[1]!;
  switch (m[2]) {
    case "cancel": return { name: "cancel_reservation", args: { reservation_id } };
    case "flights": return { name: "update_reservation_flights", args: { reservation_id, cabin: text("cabin"), flights: rows(form, FLIGHT, ROWS.flights), payment_id: text("payment_id") } };
    case "baggages": return { name: "update_reservation_baggages", args: { reservation_id, total_baggages: int("total_baggages"), nonfree_baggages: int("nonfree_baggages"), payment_id: text("payment_id") } };
    case "passengers": return { name: "update_reservation_passengers", args: { reservation_id, passengers: rows(form, PASSENGER, ROWS.passengers) } };
    default: return null;
  }
}

export const startAirlineSite = (bridge: Tau2Bridge, policy: string): Promise<Tau2Site> => startDesk(bridge, { nav: '<a href="/airports">Airports</a>', link }, async (desk, req, body, url) => {
  const path = url.pathname;
  const q = (name: string) => url.searchParams.get(name) ?? "";
  if (req.method === "POST") {
    const write = writeCall(path, new URLSearchParams(body));
    return write ? desk.write(write.name, write.args) : { status: 404, html: desk.page("Not found", "") };
  }
  if (path === "/") {
    return { status: 200, html: desk.page("Reservations desk", `<form action="/users">${field("user_id", "Customer id")}<p><button>Open the customer</button></p></form>
<form action="/reservations">${field("reservation_id", "Reservation id")}<p><button>Open the reservation</button></p></form>
<form action="/flights">${field("origin", "Origin (IATA)")}${field("destination", "Destination (IATA)")}${field("date", "Date (YYYY-MM-DD)")}${select("stops", ["direct", "one stop"])}<p><button>Search flights</button></p></form>
<form action="/status">${field("flight_number", "Flight number")}${field("date", "Date (YYYY-MM-DD)")}<p><button>Flight status</button></p></form>`) };
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/users(?:\/([^/]+))?$/.exec(path)) && (m[1] || q("user_id"))) {
    const user_id = m[1] ? decodeURIComponent(m[1]) : q("user_id");
    const at = `/users/${encodeURIComponent(user_id)}`;
    return desk.read("Customer", "get_user_details", { user_id }, () => bookForm(at) + formOf(`${at}/certificate`, "Send a certificate", field("amount", "Amount")));
  }
  if ((m = /^\/reservations(?:\/(\w+))?$/.exec(path)) && (m[1] || q("reservation_id"))) {
    const reservation_id = m[1] ?? q("reservation_id");
    return desk.read("Reservation", "get_reservation_details", { reservation_id }, (r) => reservationForms(`/reservations/${encodeURIComponent(reservation_id)}`, r as Parameters<typeof reservationForms>[1]));
  }
  if (path === "/flights") return desk.read("Flights", q("stops") === "one stop" ? "search_onestop_flight" : "search_direct_flight", { origin: q("origin"), destination: q("destination"), date: q("date") });
  if (path === "/status") return desk.read("Flight status", "get_flight_status", { flight_number: q("flight_number"), date: q("date") });
  if (path === "/airports") return desk.read("Airports", "list_all_airports", {});
  return commonPage(desk, path, q, policy) ?? { status: 404, html: desk.page("Not found", "") };
});
