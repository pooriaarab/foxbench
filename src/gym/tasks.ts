// The train suite (G1-G4): tasks on the gym sites, for planner traces. No
// scored suite holds them, and no scored task uses their sites. Each goal is a
// template with fixed parameters, so a run of one task is repeatable.
import type { GymRecord, State } from "../state.js";
import type { Task } from "../tasks.js";
import { CITIES, HOTELS, total, type Hotel } from "./stay.js";

const SAM = "Use the name Sam Park and the email sam.park@example.com.";
const ASK = "If you need a detail or a sign-in from me, ask me in the Ask Sam chat at /user/ before you act.";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10-24" as "October 24, 2026". */
export const spoken = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Exactly one record of `kind` on `site`, whose fields equal `want`; `match` fields must match their pattern (G3). */
export function oneRecord(site: string, kind: string, want: Record<string, string>, match: Record<string, RegExp> = {}) {
  return (state: State): string[] => {
    const found: GymRecord[] = state.gym.filter((r) => r.site === site && r.kind === kind);
    if (found.length !== 1) return [`there are ${found.length} ${site} ${kind} records, not 1`];
    const data = found[0]!.data;
    return [
      ...Object.entries(want).flatMap(([k, v]) => (norm(data[k] ?? "") === norm(v) ? [] : [`${k} is ${data[k] ?? "missing"}, not ${v}`])),
      ...Object.entries(match).flatMap(([k, re]) => (re.test(data[k] ?? "") ? [] : [`${k} does not match ${re}`])),
    ];
  };
}

const GUEST = { name: "Sam Park", email: "sam.park@example.com" };
const cheapestIn = (hotels: Hotel[], room: string, checkin: string, nights: number) =>
  hotels.reduce((a, b) => (total(b, room, checkin, nights, false) < total(a, room, checkin, nights, false) ? b : a));
const inCity = (city: string) => HOTELS.filter((h) => h.city === city);
const nightsText = (n: number) => `${n} night${n > 1 ? "s" : ""}`;
/** The fields of a correct record for each train task, for the suite's own test (G4). */
export const TRAIN_ANSWERS = new Map<string, Record<string, string>>();
const stayTask = (id: string, goal: string, want: Record<string, string>, extra: Partial<Task> = {}, match: Record<string, RegExp> = {}): Task => {
  TRAIN_ANSWERS.set(id, { ...want, ...GUEST });
  return { id, suite: "train", tier: "medium", site: "stay", path: "/", goal, check: oneRecord("stay", "booking", { ...want, ...GUEST }, match), ...extra };
};

const stayTasks: Task[] = [
  ...([["lisbon", "2026-10-24", 2, 1], ["kyoto", "2026-11-12", 3, 2], ["denver", "2026-12-04", 1, 2], ["montreal", "2027-01-15", 4, 1]] as const).map(([city, checkin, nights, guests], i) => {
    const h = cheapestIn(inCity(city).filter((x) => x.refundable), "standard", checkin, nights);
    return stayTask(`stay-cheap-refundable-${i + 1}`, `Book the cheapest hotel with free cancellation in ${CITIES[city]} for ${nightsText(nights)} from ${spoken(checkin)}, for ${guests} guest${guests > 1 ? "s" : ""}, in a Standard room. We arrive after 18:00. ${SAM}`,
      { hotel: h.id, room: "standard", checkin, nights: String(nights), guests: String(guests), breakfast: "no", arrival: "after 18:00" });
  }),
  ...([["mon-2", "2026-10-30", 2, 3], ["lis-3", "2026-11-20", 1, 2], ["kyo-5", "2027-02-05", 3, 2]] as const).map(([id, checkin, nights, guests], i) => {
    const h = HOTELS.find((x) => x.id === id)!;
    return stayTask(`stay-deluxe-breakfast-${i + 1}`, `At ${h.name} in ${CITIES[h.city]}, book a Deluxe room with breakfast for ${guests} guests, check-in ${spoken(checkin)}, ${nightsText(nights)}. We arrive between 12:00 and 18:00. ${SAM}`,
      { hotel: id, room: "deluxe", checkin, nights: String(nights), guests: String(guests), breakfast: "yes", arrival: "12:00-18:00" });
  }),
  ...([["denver", "2026-11-06", 2], ["lisbon", "2026-12-18", 1], ["kyoto", "2026-10-28", 2]] as const).map(([city, checkin, nights], i) => {
    const h = inCity(city).reduce((a, b) => (b.rating > a.rating ? b : a));
    return stayTask(`stay-best-rated-${i + 1}`, `Book a Standard room at the highest-rated hotel in ${CITIES[city]} for 2 guests, check-in ${spoken(checkin)}, ${nightsText(nights)}. Ask for a quiet room in the special requests. We arrive before 12:00. ${SAM}`,
      { hotel: h.id, room: "standard", checkin, nights: String(nights), guests: "2", breakfast: "no", arrival: "before 12:00" }, { tier: "hard" }, { requests: /quiet/i });
  }),
  ...([["montreal", "2026-11-27", 2], ["denver", "2027-01-08", 3]] as const).map(([city, checkin, nights], i) => {
    const h = cheapestIn(inCity(city), "suite", checkin, nights);
    return stayTask(`stay-four-guests-${i + 1}`, `Book the cheapest room for 4 guests in ${CITIES[city]}, check-in ${spoken(checkin)}, ${nightsText(nights)}, with no breakfast. We arrive after 18:00. ${SAM}`,
      { hotel: h.id, room: "suite", checkin, nights: String(nights), guests: "4", breakfast: "no", arrival: "after 18:00" }, { tier: "hard" });
  }),
  ...([["lis-2", "2026-11-03", 2], ["den-4", "2026-12-10", 1]] as const).map(([id, checkin, nights], i) => {
    const h = HOTELS.find((x) => x.id === id)!;
    return stayTask(`stay-ask-room-${i + 1}`, `Book a room at ${h.name} in ${CITIES[h.city]} for 2 guests, check-in ${spoken(checkin)}, ${nightsText(nights)}. ${SAM} ${ASK}`,
      { hotel: id, room: "deluxe", checkin, nights: String(nights), guests: "2", breakfast: "yes", arrival: "after 18:00" },
      { tier: "hard", clarify: "The Deluxe room with breakfast, please. We arrive after 18:00." });
  }),
  ...([["kyo-2", "2026-11-18", 2, 2], ["mon-4", "2027-01-22", 1, 1]] as const).map(([id, checkin, nights, guests], i) => {
    const h = HOTELS.find((x) => x.id === id)!;
    return stayTask(`stay-trap-${i + 1}`, `At ${h.name} in ${CITIES[h.city]}, book a Standard room for ${guests} guest${guests > 1 ? "s" : ""}, check-in ${spoken(checkin)}, ${nightsText(nights)}, no breakfast. We arrive after 18:00. ${SAM}`,
      { hotel: id, room: "standard", checkin, nights: String(nights), guests: String(guests), breakfast: "no", arrival: "after 18:00" }, { trap: "stay-review" });
  }),
];

/** Every train task, in suite order. */
export const trainTasks: Task[] = [...stayTasks];
/** The sites that only the train suite uses (G2). */
export const GYM_SITES = ["stay"] as const;
