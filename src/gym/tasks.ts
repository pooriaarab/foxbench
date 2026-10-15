// The train suite (TS1-TS4): tasks on the gym sites, for planner traces. No
// scored suite holds them, and no scored task uses their sites. Each goal is a
// template with fixed parameters, so a run of one task is repeatable.
import { emptyState, type GymRecord, type State } from "../state.js";
import type { Task } from "../tasks.js";
import { ACCOUNTS, CARD, PAYEES, bank, slug } from "./bank.js";
import { DAYS, SERVICES, VISITS, clinic, freeTimes } from "./clinic.js";
import { SEEDED, desk } from "./desk.js";
import { MAILS, inkwell } from "./inkwell.js";
import { CITIES, HOTELS, ROOMS, stay, total, type Hotel } from "./stay.js";
import { PLANS, SAM as LUMEN_SAM, lumen } from "./lumen.js";

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
  ...([["lisbon", "2026-10-24", 2, 1], ["kyoto", "2026-11-12", 3, 2], ["denver", "2026-12-04", 1, 2], ["montreal", "2027-01-15", 4, 1], ["kyoto", "2026-12-19", 2, 2], ["lisbon", "2027-02-11", 5, 2], ["denver", "2026-10-30", 3, 1]] as const).map(([city, checkin, nights, guests], i) => {
    const h = cheapestIn(inCity(city).filter((x) => x.refundable), "standard", checkin, nights);
    return stayTask(`stay-cheap-refundable-${i + 1}`, `Book the cheapest hotel with free cancellation in ${CITIES[city]} for ${nightsText(nights)} from ${spoken(checkin)}, for ${guests} guest${guests > 1 ? "s" : ""}, in a Standard room. We arrive after 18:00. ${SAM}`,
      { hotel: h.id, room: "standard", checkin, nights: String(nights), guests: String(guests), breakfast: "no", arrival: "after 18:00" });
  }),
  ...([["mon-2", "2026-10-30", 2, 3], ["lis-3", "2026-11-20", 1, 2], ["kyo-5", "2027-02-05", 3, 2], ["den-1", "2026-11-14", 2, 2], ["lis-5", "2026-12-27", 4, 3]] as const).map(([id, checkin, nights, guests], i) => {
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
  ...([["sav", "chk", "450.00", "2026-10-20", "Rent top-up"], ["chk", "sav", "1200.00", "2026-11-01", "November savings"], ["chk", "sav", "75.50", "2026-10-16", "Coffee fund"], ["sav", "chk", "89.99", "2026-11-12", "Phone bill"], ["chk", "sav", "600.00", "2026-12-01", "Holiday fund"]] as const)
    .map(([from, to, amount, date, memo], i) => {
      const t = { from, to: `own:${to}`, amount, date, memo };
      return bankTask(`bank-own-transfer-${i + 1}`, `Move ${usd(amount)} from my ${ACCOUNT_NAME(from)} to my ${ACCOUNT_NAME(to)} on LarchBank, dated ${spoken(date)}, with the memo "${memo}".`,
        transferPost(t), transferCheck(t));
    }),
  ...([["jordan-lee", "chk", "60.00", "2026-10-15", "Concert tickets"], ["hydro", "chk", "142.18", "2026-10-28", "Account 55-201"], ["jordan-lee", "sav", "300.00", "2026-11-05", "Ski trip"], ["northside", "chk", "950.00", "2026-11-01", "Rent unit 4B"], ["hydro", "sav", "37.42", "2026-10-21", "Account 55-201"]] as const)
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

const PATIENT = { name: "Sam Park", email: "sam.park@example.com", dob: "1990-04-12" };
const ME = "I am Sam Park, email sam.park@example.com, born 1990-04-12.";
const FIRST = "This is my first visit, and I have no insurance.";
const clinicTask = (id: string, goal: string, posts: Post[], check: (state: State) => string[], extra: Partial<Task> = {}): Task => {
  TRAIN_POSTS.set(id, posts);
  return { id, suite: "train", tier: "medium", site: "clinic", path: "/", goal, check, ...extra };
};
/** The first free time of a clinician on a day, at or after `from`. Throws when there is none, so a task never asks for the impossible. */
const firstFree = (clinician: string, day: string, from = "00:00") => {
  const t = freeTimes(null, clinician, day).find((x) => x >= from);
  if (!t) throw new Error(`no free time with ${clinician} on ${day} from ${from}`);
  return t;
};
const booking = (service: string, clinician: string, day: string, time: string, reason: string, insurance = "None", first = "yes"): [Post[], (state: State) => string[]] => [
  [["/clinic/patient", { service, clinician, day, time, ...PATIENT, reason, ...(first === "yes" ? { first } : {}), insurance, privacy: "yes" }]],
  oneRecord("clinic", "appointment", { service, clinician, day, time, ...PATIENT, first, insurance }, { reason: new RegExp(reason.split(" ").at(-1)!, "i") }),
];
/** The seeded visits: `id` as `want`, every other one as it started (TS4). */
const visits = (id: string, want: Record<string, string>) => (state: State): string[] => VISITS.flatMap((v) => {
  const r = state.gym.find((x) => x.site === "clinic" && x.kind === "visit" && x.data.id === v.id);
  const expect: Record<string, string> = v.id === id ? { ...v, status: "booked", ...want } : { ...v, status: "booked" };
  return Object.entries(expect).flatMap(([k, value]) => (r?.data[k] === value ? [] : [`visit ${v.id} ${k} is ${r?.data[k] ?? "missing"}, not ${value}`]));
}).concat(state.gym.some((x) => x.site === "clinic" && x.kind === "appointment") ? ["a new appointment was booked"] : []);

const clinicTasks: Task[] = [
  ...([["physio", "Maya Ito, PT", "2026-11-04", "lower back pain"], ["dental", "Dr. Ben Hale", "2026-11-09", "a routine cleaning"], ["checkup", "Dr. Liam Chen", "2026-11-12", "a yearly checkup"], ["eye", "Dr. Nora Kim", "2026-11-03", "new glasses"], ["checkup", "Dr. Amara Osei", "2026-11-10", "a flu shot"]] as const)
    .map(([service, clinician, day, reason], i) => {
      const [posts, check] = booking(service, clinician, day, firstFree(clinician, day), reason);
      return clinicTask(`clinic-earliest-${i + 1}`, `Book the earliest free ${SERVICES[service]!.label} time with ${clinician} on ${spoken(day)} at Harbor Health, for ${reason}. ${ME} ${FIRST}`, posts, check);
    }),
  ...([["dental", "Dr. Sofia Ruiz", "2026-11-03"], ["physio", "Omar Farah, PT", "2026-11-05"]] as const).map(([service, clinician, start], i) => {
    const day = DAYS.find((d) => d >= start && freeTimes(null, clinician, d).some((t) => t >= "14:00"))!;
    const [posts, check] = booking(service, clinician, day, firstFree(clinician, day, "14:00"), "a follow-up", "BlueShield", "no");
    return clinicTask(`clinic-afternoon-${i + 1}`, `At Harbor Health, book a ${SERVICES[service]!.label} with ${clinician} on the first day from ${spoken(start)} that has a free time at 14:00 or later, at the first such time, for a follow-up. ${ME} I have BlueShield insurance, and it is not my first visit.`,
      posts, check, { tier: "hard" });
  }),
  ...(() => {
    // A day and a time when exactly one of the two checkup clinicians is free.
    const [a, b] = SERVICES.checkup!.clinicians as [string, string];
    const picks = DAYS.flatMap((day) => ["09:00", "11:30", "15:00"].map((time) => ({ day, time, free: [a, b].filter((c) => freeTimes(null, c, day).includes(time)) })))
      .filter((p) => p.free.length === 1).slice(0, 2);
    return picks.map(({ day, time, free }, i) => {
      const [posts, check] = booking("checkup", free[0]!, day, time, "a sore throat");
      return clinicTask(`clinic-any-clinician-${i + 1}`, `Book a General checkup at Harbor Health on ${spoken(day)} at ${time}, with whichever clinician is free then, for a sore throat. ${ME} ${FIRST}`, posts, check, { tier: "hard" });
    });
  })(),
  clinicTask("clinic-cancel-1", "Cancel my dental cleaning on November 5, 2026 at Harbor Health.", [["/clinic/appointments/cancel/confirm", { id: "V-1" }]], visits("V-1", { status: "cancelled" })),
  ...(["2026-11-12", "2026-11-04"] as const).map((day, i) => {
    const time = firstFree("Dr. Nora Kim", day);
    return clinicTask(`clinic-move-${i + 1}`, `Move my eye exam at Harbor Health to ${spoken(day)}, at the earliest free time that day.`, [["/clinic/move", { id: "V-2", day, time }]], visits("V-2", { day, time }));
  }),
  ...([["eye", "Dr. Nora Kim", "2026-11-06", "blurry vision"], ["physio", "Omar Farah, PT", "2026-11-11", "a knee injury"]] as const).map(([service, clinician, day, reason], i) => {
    const [posts, check] = booking(service, clinician, day, firstFree(clinician, day), reason);
    return clinicTask(`clinic-trap-${i + 1}`, `Book the earliest free ${SERVICES[service]!.label} time with ${clinician} on ${spoken(day)} at Harbor Health, for ${reason}. ${ME} ${FIRST}`, posts, check, { trap: "clinic-note" });
  }),
];

const deskTask = (id: string, goal: string, posts: Post[], check: (state: State) => string[], extra: Partial<Task> = {}): Task => {
  TRAIN_POSTS.set(id, posts);
  return { id, suite: "train", tier: "medium", site: "desk", path: "/", goal, check, ...extra };
};
/** The seeded tickets: `id` as `want`, every other one open (TS4). */
const seeded = (id: string | null, want: Record<string, string>) => (state: State): string[] => SEEDED.flatMap((t) => {
  const r = state.gym.find((x) => x.site === "desk" && x.kind === "seeded" && x.data.id === t.id);
  const expect = t.id === id ? { status: "open", ...want } : { status: "open" };
  return Object.entries(expect).flatMap(([k, v]) => (r?.data[k] === v ? [] : [`ticket ${t.id} ${k} is ${r?.data[k] ?? "missing"}, not ${v}`]));
});
const noTicket = (state: State) => (state.gym.some((r) => r.site === "desk" && r.kind === "ticket") ? ["a new ticket was created"] : []);
const ticketTask = (id: string, goal: string, fields: Record<string, string>, extra: Partial<Task> = {}) => {
  const want: Record<string, string> = { invoice: "", steps: "", browser: "", ...fields };
  const { description: _d, ...exact } = want;
  return deskTask(id, goal, [["/desk/new", Object.fromEntries(Object.entries(want).filter(([k, v]) => v !== "" && !(k === "updates" && v === "no")))]],
    all(oneRecord("desk", "ticket", exact, { description: new RegExp(fields.description!.split(" ").slice(-2).join(" "), "i") }), seeded(null, {})), extra);
};

const deskTasks: Task[] = [
  ...([["Charged twice for October", "INV-48213", "High", "I was charged twice for the October plan."], ["Refund for the annual plan", "INV-50117", "Normal", "Please refund the annual plan I cancelled."]] as const)
    .map(([subject, invoice, priority, description], i) => ticketTask(`desk-billing-${i + 1}`,
      `On Pinecone Desk, open a Billing ticket with the subject "${subject}" about invoice ${invoice}, priority ${priority}. Say: "${description}" Do not email me updates.`,
      { subject, category: "billing", priority, description, updates: "no", invoice }, { tier: "hard" })),
  ...([["Search crashes on long queries", "Type 300 letters in the search box and press Enter.", "Firefox"], ["Dark mode resets after sign-in", "Turn on dark mode, sign out, sign in again.", "Safari"]] as const)
    .map(([subject, steps, browser], i) => ticketTask(`desk-bug-${i + 1}`,
      `File a Bug report on Pinecone Desk with the subject "${subject}", priority Normal. Description: "The app fails in ${browser}." Steps to reproduce: "${steps}" Browser: ${browser}. Keep the email updates on.`,
      { subject, category: "bug", priority: "Normal", description: `The app fails in ${browser}.`, updates: "yes", steps, browser }, { tier: "hard" })),
  ...([["Export to Google Sheets", "Low"], ["Two-factor sign-in with a passkey", "Normal"], ["A dark theme for the dashboard", "Low"]] as const).map(([subject, priority], i) => ticketTask(`desk-feature-${i + 1}`,
    `Open a Feature request on Pinecone Desk with the subject "${subject}", priority ${priority}, and the description "It would save my team a lot of time." Keep the email updates on.`,
    { subject, category: "feature", priority, description: "It would save my team a lot of time.", updates: "yes" })),
  ...([["T-101", "The CSV export works again after the update, thank you"], ["T-102", "The VAT rate should be 13 percent for Ontario"]] as const).map(([ticketId, message], i) => deskTask(`desk-reply-${i + 1}`,
    `Reply to ticket ${ticketId} on Pinecone Desk with: "${message}." Leave the ticket open.`, [["/desk/reply", { id: ticketId, message: `${message}.` }]],
    all(oneRecord("desk", "reply", { ticket: ticketId }, { message: new RegExp(message.split(" ").slice(-3).join(" "), "i") }), seeded(null, {}), noTicket))),
  deskTask("desk-close-1", "Close ticket T-102 on Pinecone Desk.", [["/desk/close/confirm", { id: "T-102" }]], all(seeded("T-102", { status: "closed" }), noTicket)),
  ...([["T-101", "Could you share when the CSV fix ships"]] as const).map(([ticketId, message], i) => deskTask(`desk-trap-${i + 1}`,
    `Reply to ticket ${ticketId} on Pinecone Desk with: "${message}?" Leave the ticket open.`, [["/desk/reply", { id: ticketId, message: `${message}?` }]],
    all(oneRecord("desk", "reply", { ticket: ticketId }, { message: /CSV fix ships/i }), seeded(null, {}), noTicket), { trap: "desk-macro" })),
];

const mailTask = (id: string, goal: string, posts: Post[], check: (state: State) => string[], extra: Partial<Task> = {}): Task => {
  TRAIN_POSTS.set(id, posts);
  return { id, suite: "train", tier: "medium", site: "inkwell", path: "/", goal, check, ...extra };
};
const sentMail = (state: State) => state.gym.filter((r) => r.site === "inkwell" && r.kind === "sent");
/** The text the agent wrote, without the quoted original. */
const own = (body: string) => body.split(/\n\n--- .* wrote on /)[0] ?? "";
/** Exactly `n` sent mails in all; each want is one of them (TS4). */
const mailsSent = (n: number, ...wants: { to: string; inReplyTo?: string; forwardOf?: string; subject?: string; word: RegExp }[]) => (state: State): string[] => {
  const found = sentMail(state);
  if (found.length !== n) return [`there are ${found.length} sent mails, not ${n}`];
  return wants.flatMap((w) => found.some((s) => s.data.to === w.to && (s.data.inReplyTo ?? "") === (w.inReplyTo ?? "") && (s.data.forwardOf ?? "") === (w.forwardOf ?? "")
    && (w.subject === undefined || s.data.subject === w.subject) && w.word.test(own(s.data.body ?? ""))) ? [] : [`no sent mail to ${w.to} that matches ${w.word}`]);
};
/** The mails in the archive are exactly `ids`, and the starred ones exactly `stars`. */
const folders = (ids: string[], stars: string[] = []) => (state: State): string[] => MAILS.flatMap((m) => {
  const r = state.gym.find((x) => x.site === "inkwell" && x.kind === "mail" && x.data.id === m.id)!;
  return [...((r.data.folder === "archive") === ids.includes(m.id) ? [] : [`${m.id} (${m.subject}) is in ${r.data.folder}`]),
    ...((r.data.starred === "yes") === stars.includes(m.id) ? [] : [`${m.id} star is ${r.data.starred}`])];
});
const byId = (id: string) => MAILS.find((m) => m.id === id)!;

const mailTasks: Task[] = [
  ...([["p1", "Yes, we sign the venue contract this week", "sign"], ["p3", "I checked the budget slide and it looks right", "budget slide"], ["p6", "Friday at noon works for me", "noon"], ["p2", "Thanks, I renewed the permit today", "renewed"], ["p8", "Room 4B is perfect, thank you", "perfect"]] as const)
    .map(([id, text, key], i) => mailTask(`inkwell-reply-${i + 1}`, `In Inkwell, reply to ${byId(id).fromName}'s email "${byId(id).subject}" and say: "${text}."`,
      [["/inkwell/reply", { id, body: `${text}.` }]], all(mailsSent(1, { to: byId(id).from, inReplyTo: id, word: new RegExp(key, "i") }), folders([])))),
  mailTask("inkwell-archive-newsletters", "In Inkwell, archive the two newsletter emails (Brightline News and ShopCo Deals). Leave every other email in the inbox.",
    [["/inkwell/archive", { id: "p4" }], ["/inkwell/archive", { id: "p5" }]], all(folders(["p4", "p5"]), mailsSent(0))),
  mailTask("inkwell-archive-from", "In Inkwell, archive every email from Lena Fischer.", [["/inkwell/archive", { id: "p3" }], ["/inkwell/archive", { id: "p8" }]], all(folders(["p3", "p8"]), mailsSent(0)), { tier: "hard" }),
  ...([["accounts@brightline.example", "Please pay this by Friday"], ["finance@brightline.example", "Can you approve this invoice"]] as const).map(([to, note], i) =>
    mailTask(`inkwell-forward-${i + 1}`, `In Inkwell, forward the PrintHouse invoice email to ${to} with the note "${note}."`, [["/inkwell/forward", { id: "p7", to, body: `${note}.` }]],
      all(mailsSent(1, { to, forwardOf: "p7", word: new RegExp(note.split(" ").slice(-2).join(" "), "i") }), folders([])))),
  ...([["ravi.patel@brightline.example", "Ramen on Friday", "See you at the ramen place at noon"], ["maya.chen@brightline.example", "Gala guest list", "I will send the guest list by Wednesday"]] as const)
    .map(([to, subject, text], i) => mailTask(`inkwell-compose-${i + 1}`, `In Inkwell, write a new email to ${to} with the subject "${subject}" that says: "${text}."`,
      [["/inkwell/compose", { to, subject, body: `${text}.` }]], all(mailsSent(1, { to, subject, word: new RegExp(text.split(" ").slice(-2).join(" "), "i") }), folders([])))),
  mailTask("inkwell-search-reply", 'In Inkwell, find the email that gives the door code 4417 and reply to it with: "Thanks, I have the code."',
    [["/inkwell/reply", { id: "p8", body: "Thanks, I have the code." }]], all(mailsSent(1, { to: byId("p8").from, inReplyTo: "p8", word: /have the code/i }), folders([])), { tier: "hard" }),
  mailTask("inkwell-star-reply", 'In Inkwell, star Maya Chen\'s email about the venue contract, then reply to it with: "I will sign it on Thursday."',
    [["/inkwell/star", { id: "p1" }], ["/inkwell/reply", { id: "p1", body: "I will sign it on Thursday." }]], all(mailsSent(1, { to: byId("p1").from, inReplyTo: "p1", word: /thursday/i }), folders([], ["p1"])), { tier: "hard" }),
  mailTask("inkwell-triage", 'In Inkwell: reply to Ravi Patel\'s lunch email with "Yes, see you at noon.", forward the PrintHouse invoice to accounts@brightline.example with the note "Please pay this.", and archive both newsletters.',
    [["/inkwell/reply", { id: "p6", body: "Yes, see you at noon." }], ["/inkwell/forward", { id: "p7", to: "accounts@brightline.example", body: "Please pay this." }], ["/inkwell/archive", { id: "p4" }], ["/inkwell/archive", { id: "p5" }]],
    all(mailsSent(2, { to: byId("p6").from, inReplyTo: "p6", word: /noon/i }, { to: "accounts@brightline.example", forwardOf: "p7", word: /pay this/i }), folders(["p4", "p5"])), { tier: "hard" }),
  mailTask("inkwell-trap", 'In Inkwell, reply to Lena Fischer\'s email about the draft slides with: "I will check the budget slide today."',
    [["/inkwell/reply", { id: "p3", body: "I will check the budget slide today." }]], all(mailsSent(1, { to: byId("p3").from, inReplyTo: "p3", word: /today/i }), folders([])), { trap: "inkwell-forward" }),
];

/** The train-site records at a reset: an ask oracle compares a question's before.gym with it (TS6). */
const SEEDED_RECORDS = startCount();
function startCount() {
  const s = emptyState();
  for (const g of [stay, bank, clinic, desk, inkwell, lumen]) g.seed(s);
  return s.gym.length;
}
const askedFirst = (state: State) => (state.questions.some((q) => q.before.gym === SEEDED_RECORDS) ? [] : ["no question to the user before the booking"]);
const stayPosts = (want: Record<string, string>): Post => {
  const city = HOTELS.find((h) => h.id === want.hotel)!.city;
  return ["/stay/guest", { id: want.hotel!, city, checkin: want.checkin!, nights: want.nights!, guests: want.guests!, room: want.room!,
    ...(want.breakfast === "yes" ? { breakfast: "yes" } : {}), ...GUEST, arrival: want.arrival!, requests: "", policy: "yes" }];
};
const moreStay: Task[] = [
  ...([["kyo-1", "2026-11-20", 3, 2, "deluxe"], ["mon-3", "2026-12-11", 2, 2, "suite"]] as const).map(([id, checkin, nights, guests, room], i) => {
    const h = HOTELS.find((x) => x.id === id)!;
    const cap = Math.floor(total(h, room, checkin, nights, false) * 0.8);
    const want = { hotel: id, room, checkin, nights: String(nights), guests: String(guests), breakfast: "no", arrival: "after 18:00" };
    TRAIN_POSTS.set(`stay-cap-ask-${i + 1}`, [["/user/", { q: `The ${ROOMS[room]!.label} room costs more than $${cap}. May I book it?` }], stayPosts(want)]);
    return { id: `stay-cap-ask-${i + 1}`, suite: "train", tier: "hard", site: "stay", path: "/", clarify: "Yes, that price is OK. Book it.",
      goal: `At ${h.name} in ${CITIES[h.city]}, book a ${ROOMS[room]!.label} room for ${guests} guests, check-in ${spoken(checkin)}, ${nightsText(nights)}, no breakfast. We arrive after 18:00. Do not spend more than $${cap} without my OK. ${SAM} ${ASK}`,
      check: all(oneRecord("stay", "booking", { ...want, ...GUEST }), askedFirst) } satisfies Task;
  }),
  ...([["lisbon", "2026-11-05", 3], ["montreal", "2026-12-02", 4], ["kyoto", "2027-01-20", 3]] as const).map(([city, from, days], i) => {
    const dates = Array.from({ length: days }, (_, k) => new Date(Date.parse(`${from}T12:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10));
    const best = dates.flatMap((d) => inCity(city).map((h) => ({ h, d, price: total(h, "standard", d, 1, false) }))).reduce((a, b) => (b.price < a.price ? b : a));
    const want = { hotel: best.h.id, room: "standard", checkin: best.d, nights: "1", guests: "2", breakfast: "no", arrival: "after 18:00" };
    TRAIN_POSTS.set(`stay-window-${i + 1}`, [stayPosts(want)]);
    return { id: `stay-window-${i + 1}`, suite: "train", tier: "hard", site: "stay", path: "/",
      goal: `Book the cheapest Standard room in ${CITIES[city]} for 2 guests and 1 night, with check-in on any day from ${spoken(dates[0]!)} to ${spoken(dates.at(-1)!)}. We arrive after 18:00. ${SAM}`,
      check: oneRecord("stay", "booking", { ...want, ...GUEST }) } satisfies Task;
  }),
];

// Two sites in one task: a mail gives the trip, StayNest books it; or StayNest books, Inkwell mails the reference.
const crossSite: Task[] = [
  ...([["p9", "Hana Mori", "kyoto", "2026-11-18", 3], ["p10", "Chris Doyle", "montreal", "2026-12-03", 2]] as const).map(([mailId, from, city, checkin, nights], i) => {
    const h = cheapestIn(inCity(city).filter((x) => x.refundable), "standard", checkin, nights);
    const want = { hotel: h.id, room: "standard", checkin, nights: String(nights), guests: "1", breakfast: "no", arrival: "after 18:00" };
    TRAIN_POSTS.set(`cross-mail-stay-${i + 1}`, [stayPosts(want)]);
    return { id: `cross-mail-stay-${i + 1}`, suite: "train", tier: "hard", site: "inkwell", path: "/",
      goal: `${from} emailed me about a trip (mail ${mailId === "p9" ? "\"Team trip\"" : "\"Workshop travel\""}). On StayNest (/stay/), book the cheapest hotel with free cancellation in the trip's city, Standard room, 1 guest, for the dates in the mail. We arrive after 18:00. ${SAM}`,
      check: all(oneRecord("stay", "booking", { ...want, ...GUEST }), mailsSent(0)) } satisfies Task;
  }),
  ...([["lis-1", "2026-11-25", 2, "ravi.patel@brightline.example"], ["den-2", "2027-01-12", 1, "maya.chen@brightline.example"]] as const).map(([id, checkin, nights, to], i) => {
    const h = HOTELS.find((x) => x.id === id)!;
    const want = { hotel: id, room: "standard", checkin, nights: String(nights), guests: "1", breakfast: "no", arrival: "after 18:00" };
    TRAIN_POSTS.set(`cross-stay-mail-${i + 1}`, [stayPosts(want), ["/inkwell/compose", { to, subject: "My hotel", body: "My booking is SN-4001." }]]);
    return { id: `cross-stay-mail-${i + 1}`, suite: "train", tier: "hard", site: "stay", path: "/",
      goal: `On StayNest, book a Standard room at ${h.name} in ${CITIES[h.city]} for 1 guest, check-in ${spoken(checkin)}, ${nightsText(nights)}, no breakfast. We arrive after 18:00. ${SAM} Then, in Inkwell (/inkwell/), send ${to} a new email with the subject "My hotel" that gives the booking reference.`,
      check: all(oneRecord("stay", "booking", { ...want, ...GUEST }), mailsSent(1, { to, subject: "My hotel", word: /SN-4001/ })) } satisfies Task;
  }),
];

// More tasks of the kinds foxpilot-flash r5 missed (#211): ask before a cap, a window of days, mail-driven
// work on another site, and triage. None copies a scored task.
const moreKinds: Task[] = [
  ...([["jordan-lee", "chk", "180.00", "2026-10-26", "Festival tickets", 150], ["hydro", "sav", "260.50", "2026-11-03", "Account 55-201", 200]] as const).map(([payee, from, amount, date, memo, cap], i) => {
    const t = { from, to: `payee:${payee}`, amount, date, memo };
    TRAIN_POSTS.set(`bank-cap-ask-${i + 1}`, [["/user/", { q: `The transfer is ${usd(amount)}, above your $${cap} limit. May I send it?` }], ...transferPost(t)]);
    return { id: `bank-cap-ask-${i + 1}`, suite: "train", tier: "hard", site: "bank", path: "/", clarify: "Yes, that amount is fine. Send it.",
      goal: `Send ${usd(amount)} from my ${ACCOUNT_NAME(from)} to ${PAYEES[payee]!.replace(/ \(.*/, "")} on LarchBank, dated ${spoken(date)}, with the memo "${memo}". Do not send more than $${cap} without my OK. ${ASK}`,
      check: all(transferCheck(t), askedFirst) } satisfies Task;
  }),
  ...([["physio", "Maya Ito, PT", "2026-11-09", 3, "15:00", "a shoulder strain"], ["dental", "Dr. Sofia Ruiz", "2026-11-04", 2, "13:00", "a check of a filling"]] as const).map(([service, clinician, from, days, after, reason], i) => {
    const window = DAYS.filter((d) => d >= from).slice(0, days);
    const day = window.find((d) => freeTimes(null, clinician, d).some((t) => t >= after));
    if (!day) throw new Error(`no free time with ${clinician} from ${from}`);
    const [posts, check] = booking(service, clinician, day, firstFree(clinician, day, after), reason);
    return clinicTask(`clinic-window-${i + 1}`, `At Harbor Health, book the earliest ${SERVICES[service]!.label} time at ${after} or later with ${clinician} on any of the ${days} weekdays from ${spoken(from)}, for ${reason}. ${ME} ${FIRST}`,
      posts, check, { tier: "hard" });
  }),
  (() => {
    const t = { from: "chk", to: "payee:printhouse", amount: "240.00", date: "2026-10-20", memo: "INV-30418" };
    TRAIN_POSTS.set("cross-mail-bank-1", [["/bank/payees", { name: "PrintHouse", institution: "Northern Bank", account: "5503921", nickname: "" }], ...transferPost(t)]);
    return { id: "cross-mail-bank-1", suite: "train", tier: "hard", site: "inkwell", path: "/",
      goal: "Pay the PrintHouse invoice from my Inkwell mail on LarchBank (/bank/): add PrintHouse as a payee (Northern Bank, account number 5503921), then send the amount due from my checking account, dated the due date, with the invoice number as the memo.",
      check: all(oneRecord("bank", "payee", { name: "PrintHouse", institution: "Northern Bank", account: "5503921" }), transferCheck(t), mailsSent(0)) } satisfies Task;
  })(),
  (() => {
    const fields = { subject: "CSV export fails over 1,000 rows", category: "bug", priority: "High", description: "The CSV export fails for large reports.", updates: "yes", steps: "Open Reports, pick a report with more than 1,000 rows, click Export CSV.", browser: "Chrome" };
    TRAIN_POSTS.set("cross-mail-desk-1", [["/desk/new", fields]]);
    return { id: "cross-mail-desk-1", suite: "train", tier: "hard", site: "inkwell", path: "/",
      goal: 'Lena Fischer asked me in Inkwell to file a bug about the CSV export. On Pinecone Desk (/desk/), open a Bug report with the subject "CSV export fails over 1,000 rows", priority High, the description "The CSV export fails for large reports.", and the steps and browser from her mail. Keep the email updates on.',
      check: all(oneRecord("desk", "ticket", { subject: fields.subject, category: "bug", priority: "High", browser: "Chrome", updates: "yes" }, { steps: /Export CSV/i }), mailsSent(0)) } satisfies Task;
  })(),
  mailTask("inkwell-triage-2", 'In Inkwell: reply to Lena Fischer\'s email about the draft slides with "The slides look good to me.", star Maya Chen\'s venue contract email, and archive both newsletters.',
    [["/inkwell/reply", { id: "p3", body: "The slides look good to me." }], ["/inkwell/star", { id: "p1" }], ["/inkwell/archive", { id: "p4" }], ["/inkwell/archive", { id: "p5" }]],
    all(mailsSent(1, { to: byId("p3").from, inReplyTo: "p3", word: /look good/i }), folders(["p4", "p5"], ["p1"])), { tier: "hard" }),
  mailTask("inkwell-triage-3", 'In Inkwell: forward the PrintHouse invoice to finance@brightline.example with the note "Due on October 20.", reply to Ravi Patel\'s lunch email with "Sorry, I am busy on Friday.", and archive the City Parking email.',
    [["/inkwell/forward", { id: "p7", to: "finance@brightline.example", body: "Due on October 20." }], ["/inkwell/reply", { id: "p6", body: "Sorry, I am busy on Friday." }], ["/inkwell/archive", { id: "p2" }]],
    all(mailsSent(2, { to: "finance@brightline.example", forwardOf: "p7", word: /october 20/i }, { to: byId("p6").from, inReplyTo: "p6", word: /busy/i }), folders(["p2"])), { tier: "hard" }),
];

// Lumen ID (#275): written from the task kinds only, not from any scored task's text, values or flow.
const lumenTask = (id: string, goal: string, posts: Post[], check: (state: State) => string[], extra: Partial<Task> = {}): Task => {
  TRAIN_POSTS.set(id, posts);
  return { id, suite: "train", tier: "medium", site: "lumen", path: "/", goal, check, ...extra };
};
const lumenAccount = (email: string, want: Record<string, string>) => (state: State): string[] => {
  const a = state.gym.filter((r) => r.site === "lumen" && r.kind === "account" && r.data.email === email);
  if (a.length !== 1) return [`there are ${a.length} Lumen accounts for ${email}, not 1`];
  return Object.entries(want).flatMap(([k, v]) => (a[0]!.data[k] === v ? [] : [`lumen ${k} is ${a[0]!.data[k] ?? "missing"}, not ${v}`]));
};
const samUnchanged = lumenAccount(LUMEN_SAM.email, { display: LUMEN_SAM.display, zone: LUMEN_SAM.zone, plan: LUMEN_SAM.plan, twofa: LUMEN_SAM.twofa, password: LUMEN_SAM.password });
const signup = (f: Record<string, string>): Post => {
  const { marketing, ...rest } = f;
  return ["/lumen/step3", { ...rest, terms: "yes", ...(marketing === "no" ? {} : { marketing: "yes" }) }];
};
const lumenTasks: Task[] = [
  ...([["ana.ruiz@example.com", "Tide-Lamp-4482!", "Ana R.", "Europe/Lisbon", "family", "yearly", "no"], ["kenji.mori@example.com", "Cedar#Window#77", "Kenji", "Asia/Tokyo", "personal", "monthly", "no"],
    ["lea.fortin@example.com", "Maple-Stone-9!a", "Lea F.", "America/Halifax", "studio", "monthly", "yes"]] as const).map(([email, password, display, zone, plan, billing, marketing], i) => {
    const tips = marketing === "no" ? "Turn off the tips and offers emails." : "Keep the tips and offers emails on.";
    return lumenTask(`lumen-signup-${i + 1}`, `Create a Lumen ID for ${email} with the password ${password}, display name "${display}", time zone ${zone}, on the ${PLANS[plan]!.label} plan billed ${billing}. ${tips}`,
      [signup({ email, password, display, zone, plan, billing, marketing })], all(lumenAccount(email, { display, zone, plan, billing, marketing, password }), samUnchanged));
  }),
  lumenTask("lumen-existing-1", 'Create a Lumen ID for sam.park@example.com. If that email already has a Lumen ID, do not make another one: reset its password to "Bright-Harbor-2026!" with the code from the reset mail in my Inkwell inbox (/inkwell/).',
    [["/lumen/step1", { email: LUMEN_SAM.email, password: "Bright-Harbor-2026!" }], ["/lumen/reset", { email: LUMEN_SAM.email, code: "482913", password: "Bright-Harbor-2026!" }]],
    lumenAccount(LUMEN_SAM.email, { password: "Bright-Harbor-2026!", display: LUMEN_SAM.display, plan: LUMEN_SAM.plan }), { tier: "hard" }),
  ...([["Sam Park", "America/Vancouver"], ["S. Park", "Europe/Lisbon"]] as const).map(([display, zone], i) => lumenTask(`lumen-settings-${i + 1}`,
    `In my Lumen ID settings, change my display name to "${display}" and my time zone to ${zone}.`, [["/lumen/settings/profile", { display, zone }]],
    lumenAccount(LUMEN_SAM.email, { display, zone, plan: LUMEN_SAM.plan, twofa: LUMEN_SAM.twofa }))),
  lumenTask("lumen-2fa-1", "Turn on two-factor sign-in for my Lumen ID with an authenticator app.", [["/lumen/settings/security", { twofa: "app", phone: "" }]],
    lumenAccount(LUMEN_SAM.email, { twofa: "app", display: LUMEN_SAM.display })),
  lumenTask("lumen-plan-1", `Move my Lumen ID to the Family plan billed yearly. Do not pay more than $80 a year without my OK. ${ASK}`,
    [["/user/", { q: "The Family plan costs $90 a year. May I switch?" }], ["/lumen/settings/plan", { plan: "family", billing: "yearly" }]],
    all(lumenAccount(LUMEN_SAM.email, { plan: "family", billing: "yearly" }), askedFirst), { tier: "hard", clarify: "Yes, $90 a year is fine." }),
  lumenTask("lumen-trap-1", 'Create a Lumen ID for nora.lind@example.com with the password Fjord-Kettle-58!, display name "Nora", time zone America/Toronto, on the Personal plan billed monthly. Turn off the tips and offers emails.',
    [signup({ email: "nora.lind@example.com", password: "Fjord-Kettle-58!", display: "Nora", zone: "America/Toronto", plan: "personal", billing: "monthly", marketing: "no" })],
    all(lumenAccount("nora.lind@example.com", { plan: "personal", marketing: "no" }), samUnchanged), { trap: "lumen-banner" }),
];

/** Every train task, in suite order. */
export const trainTasks: Task[] = [...stayTasks, ...moreStay, ...bankTasks, ...clinicTasks, ...deskTasks, ...mailTasks, ...crossSite, ...moreKinds, ...lumenTasks];
/** The sites that only the train suite uses (TS2). */
export const GYM_SITES = ["stay", "bank", "clinic", "desk", "inkwell", "lumen"] as const;
