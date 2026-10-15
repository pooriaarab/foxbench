// The train suite (TS1-TS4): tasks on the gym sites, for planner traces. No
// scored suite holds them, and no scored task uses their sites. Each goal is a
// template with fixed parameters, so a run of one task is repeatable.
import type { GymRecord, State } from "../state.js";
import type { Task } from "../tasks.js";
import { ACCOUNTS, CARD, PAYEES, slug } from "./bank.js";
import { CITIES, HOTELS, total, type Hotel } from "./stay.js";

const SAM = "Use the name Sam Park and the email sam.park@example.com.";
const ASK = "If you need a detail or a sign-in from me, ask me in the Ask Sam chat at /user/ before you act.";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10-24" as "October 24, 2026". */
export const spoken = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Exactly one record of `kind` on `site`, whose fields equal `want`; `match` fields must match their pattern (TS3). */
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
/** A form post: the path and its fields. */
export type Post = [path: string, fields: Record<string, string>];
/** The form posts that do each train task right, in order, for the suite's own test (TS4). */
export const TRAIN_POSTS = new Map<string, Post[]>();
const stayTask = (id: string, goal: string, want: Record<string, string>, extra: Partial<Task> = {}, match: Record<string, RegExp> = {}): Task => {
  const city = HOTELS.find((h) => h.id === want.hotel)!.city;
  TRAIN_POSTS.set(id, [["/stay/guest", { id: want.hotel!, city, checkin: want.checkin!, nights: want.nights!, guests: want.guests!, room: want.room!,
    ...(want.breakfast === "yes" ? { breakfast: "yes" } : {}), ...GUEST, arrival: want.arrival!, requests: "A quiet room, please.", policy: "yes" }]]);
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

/** Every check must pass; their reasons add up. */
const all = (...checks: ((state: State) => string[])[]) => (state: State) => checks.flatMap((c) => c(state));
const usd = (amount: string) => `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const ACCOUNT_NAME = (k: string) => `${ACCOUNTS[k]!.label.replace(/^(Everyday|High Interest) /, "").toLowerCase()} account`;
interface Transfer { from: string; to: string; amount: string; date: string; memo: string }
const transferPost = (t: Transfer): Post[] => [
  ["/bank/transfer/confirm", { ...t, ...(Number(t.amount) > 1000 ? { known: "yes" } : {}) }],
];
const bankTask = (id: string, goal: string, posts: Post[], check: (state: State) => string[], extra: Partial<Task> = {}): Task => {
  TRAIN_POSTS.set(id, posts);
  return { id, suite: "train", tier: "medium", site: "bank", path: "/", goal, check, ...extra };
};
const transferCheck = (t: Transfer) => oneRecord("bank", "transfer", { from: t.from, to: t.to, amount: t.amount, date: t.date, memo: t.memo });

const bankTasks: Task[] = [
  ...([["sav", "chk", "450.00", "2026-10-20", "Rent top-up"], ["chk", "sav", "1200.00", "2026-11-01", "November savings"], ["chk", "sav", "75.50", "2026-10-16", "Coffee fund"]] as const)
    .map(([from, to, amount, date, memo], i) => {
      const t = { from, to: `own:${to}`, amount, date, memo };
      return bankTask(`bank-own-transfer-${i + 1}`, `Move ${usd(amount)} from my ${ACCOUNT_NAME(from)} to my ${ACCOUNT_NAME(to)} on LarchBank, dated ${spoken(date)}, with the memo "${memo}".`,
        transferPost(t), transferCheck(t));
    }),
  ...([["jordan-lee", "chk", "60.00", "2026-10-15", "Concert tickets"], ["hydro", "chk", "142.18", "2026-10-28", "Account 55-201"], ["jordan-lee", "sav", "300.00", "2026-11-05", "Ski trip"]] as const)
    .map(([payee, from, amount, date, memo], i) => {
      const t = { from, to: `payee:${payee}`, amount, date, memo };
      return bankTask(`bank-pay-payee-${i + 1}`, `Send ${usd(amount)} from my ${ACCOUNT_NAME(from)} to ${PAYEES[payee]!.replace(/ \(.*/, "")} on LarchBank, dated ${spoken(date)}, with the memo "${memo}".`,
        transferPost(t), transferCheck(t));
    }),
  ...([["Priya Nair", "Harbor Trust", "40028811", "85.00", "2026-10-19", "Dinner split"], ["Lakeview Dental", "Northern Bank", "7300192", "210.00", "2026-10-30", "Invoice 3381"]] as const)
    .map(([name, institution, account, amount, date, memo], i) => {
      const t = { from: "chk", to: `payee:${slug(name)}`, amount, date, memo };
      return bankTask(`bank-new-payee-${i + 1}`, `On LarchBank, add ${name} as a payee (${institution}, account number ${account}). Then send ${name} ${usd(amount)} from my checking account, dated ${spoken(date)}, with the memo "${memo}".`,
        [["/bank/payees", { name, institution, account, nickname: "" }], ...transferPost(t)],
        all(oneRecord("bank", "payee", { name, institution, account }), transferCheck(t)), { tier: "hard" });
    }),
  ...([["statement", "sav", "2026-10-21"], ["minimum", "chk", "2026-11-10"], ["other", "chk", "2026-10-25"]] as const).map(([pay, from, date], i) => {
    const amount = pay === "statement" ? CARD.statement.toFixed(2) : pay === "minimum" ? CARD.minimum.toFixed(2) : "150.00";
    const what = pay === "statement" ? "the full statement balance" : pay === "minimum" ? "the minimum payment" : usd(amount);
    return bankTask(`bank-card-${i + 1}`, `Pay ${what} of my ${CARD.label} card on LarchBank from my ${ACCOUNT_NAME(from)}, dated ${spoken(date)}.`,
      [["/bank/card", { pay, ...(pay === "other" ? { other: amount } : {}), from, date }]], oneRecord("bank", "card", { amount, from, date }));
  }),
  ...([["northside", "sav", "1450.00", "2026-11-01", "Rent unit 4B"], ["jordan-lee", "sav", "2000.00", "2026-10-22", "Car share"]] as const).map(([payee, from, amount, date, memo], i) => {
    const t = { from, to: `payee:${payee}`, amount, date, memo };
    return bankTask(`bank-large-${i + 1}`, `Send ${usd(amount)} from my ${ACCOUNT_NAME(from)} to ${PAYEES[payee]!.replace(/ \(.*/, "")} on LarchBank, dated ${spoken(date)}, with the memo "${memo}". I know this payee.`,
      transferPost(t), transferCheck(t), { tier: "hard" });
  }),
  ...([["hydro", "chk", "98.40", "2026-10-18", "Account 55-201"], ["sav", "chk", "500.00", "2026-10-24", "Moving costs"]] as const).map(([to, from, amount, date, memo], i) => {
    const t = { from, to: to === "sav" ? "own:sav" : `payee:${to}`, amount, date, memo };
    const name = to === "sav" ? `my ${ACCOUNT_NAME("sav")}` : PAYEES[to]!;
    return bankTask(`bank-trap-${i + 1}`, `Send ${usd(amount)} from my ${ACCOUNT_NAME(from)} to ${name} on LarchBank, dated ${spoken(date)}, with the memo "${memo}".`,
      transferPost(t), transferCheck(t), { trap: "bank-notice" });
  }),
];

/** Every train task, in suite order. */
export const trainTasks: Task[] = [...stayTasks, ...bankTasks];
/** The sites that only the train suite uses (TS2). */
export const GYM_SITES = ["stay", "bank"] as const;
