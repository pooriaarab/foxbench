// The scripted perfect agent of the tau2 airline tests: it does a task's
// gold actions through the reservations desk's pages, as a browser agent would.
export interface Action { name: string; arguments: Record<string, unknown> }

const rowFields = (prefix: Record<string, unknown>[] | undefined, fields: string[]) =>
  Object.fromEntries((prefix ?? []).flatMap((row, i) => fields.map((f) => [`${f}_${i}`, String(row[f])])));

/** One airline gold action, done through the pages of the site at `origin`. */
export async function airlineStep(origin: string, a: Action): Promise<Response> {
  const g = a.arguments as Record<string, string> & Record<"flights" | "passengers" | "payment_methods", Record<string, unknown>[]>;
  const get = (path: string) => fetch(origin + path);
  const post = (path: string, f: Record<string, string>) => fetch(origin + path, { method: "POST", body: new URLSearchParams(f) });
  const s = (k: string) => String(g[k]);
  const res = `/reservations/${s("reservation_id")}`;
  const user = `/users/${encodeURIComponent(s("user_id"))}`;
  switch (a.name) {
    case "get_reservation_details": return get(res);
    case "get_user_details": return get(user);
    case "search_direct_flight":
    case "search_onestop_flight":
      return get(`/flights?${new URLSearchParams({ origin: s("origin"), destination: s("destination"), date: s("date"), stops: a.name === "search_direct_flight" ? "direct" : "one stop" })}`);
    case "get_flight_status": return get(`/status?${new URLSearchParams({ flight_number: s("flight_number"), date: s("date") })}`);
    case "list_all_airports": return get("/airports");
    case "calculate": return get(`/calculator?expression=${encodeURIComponent(s("expression"))}`);
    case "transfer_to_human_agents": return post("/transfer", { summary: s("summary") });
    case "cancel_reservation": return post(`${res}/cancel`, {});
    case "update_reservation_flights": return post(`${res}/flights`, { cabin: s("cabin"), payment_id: s("payment_id"), ...rowFields(g.flights, ["flight_number", "date"]) });
    case "update_reservation_baggages": return post(`${res}/baggages`, { total_baggages: s("total_baggages"), nonfree_baggages: s("nonfree_baggages"), payment_id: s("payment_id") });
    case "update_reservation_passengers": return post(`${res}/passengers`, rowFields(g.passengers, ["first_name", "last_name", "dob"]));
    case "send_certificate": return post(`${user}/certificate`, { amount: s("amount") });
    case "book_reservation":
      return post(`${user}/book`, { origin: s("origin"), destination: s("destination"), flight_type: s("flight_type"), cabin: s("cabin"), total_baggages: s("total_baggages"),
        nonfree_baggages: s("nonfree_baggages"), insurance: s("insurance"), ...rowFields(g.flights, ["flight_number", "date"]), ...rowFields(g.passengers, ["first_name", "last_name", "dob"]),
        ...rowFields(g.payment_methods, ["payment_id", "amount"]) });
    default: throw new Error(`no page for ${a.name}`);
  }
}
