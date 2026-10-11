// Ask Sam: a chat with the person who gave the goal. It stands for the user,
// as tau2-bench's simulated user does, but its answers are fixed per task.
// A question is also the handoff for a sign-in wall: Sam signs in, the agent
// never sees a password. Questions live in state.questions.
import { esc, page, type Ctx, type Reply, type Site } from "../server.js";
import type { State } from "../state.js";

const site = { id: "user", title: "Ask Sam" };
const NOTHING = "I have nothing to add. Do what I asked.";
const SIGNED_IN: Record<string, string> = { shop: "I signed in to Trailhead Supply for you. Go on." };

function chat(state: State, error = ""): Reply {
  const turns = state.questions.map((q) => `<li class="card"><p><strong>You:</strong> ${esc(q.text)}</p><p><strong>Sam:</strong> ${esc(q.answer)}</p></li>`).join("");
  const body = `<h1>Ask Sam</h1><p class="muted">Sam gave you the task. Ask here when you need a detail or a sign-in.</p>
<ol style="list-style:none;padding:0">${turns}</ol><form class="card" method="post" action="/user/"><label for="q">Your question</label>
<textarea id="q" name="q" rows="3"></textarea>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}<p><button type="submit">Send</button></p></form>`;
  return { status: error ? 400 : 200, html: page(site, "Ask Sam", body) };
}

function ask(ctx: Ctx): Reply {
  const text = (ctx.form.get("q") ?? "").trim();
  if (!text) return chat(ctx.state, "Write a question.");
  const s = ctx.state;
  const answers = [s.clarify ?? ""];
  if (s.wall && !s.signedIn) {
    s.signedIn = true;
    answers.push(SIGNED_IN[s.wall] ?? "I signed in for you. Go on.");
  }
  const answer = answers.filter(Boolean).join(" ") || NOTHING;
  s.questions.push({ text: text.slice(0, 2000), answer, before: { bookings: s.bookings.length, orders: s.orders.length, accounts: s.accounts.length,
    contacts: s.contacts.length, sent: s.mail.filter((m) => m.folder === "sent").length } });
  return { redirect: "/user/" };
}

export const user: Site = {
  ...site,
  seed() {},
  handle(ctx) {
    if (ctx.path !== "/") return null;
    return ctx.method === "POST" ? ask(ctx) : chat(ctx.state);
  },
};
