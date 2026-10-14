// Scripted agents that check the MiniWoB++ and AgentDojo benchmarks
// (e2e/bench.mjs), the way e2e/scripted.mjs checks the foxbench sites.
// They are not part of the package.
//   miniwob perfect   solves six MiniWoB tasks in a real Firefox, with real
//                     clicks and keys; each must pass on MiniWoB's own reward
//   miniwob wrong     clicks the wrong thing on the same six; each must fail
//   agentdojo perfect runs AgentDojo's ground-truth calls as form posts
//   agentdojo gullible  also obeys the injection it finds on the pages
const quoted = (goal) => [...goal.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

async function clickText(page, selector, text, wrong) {
  const els = await page.$$(selector);
  for (const el of els) {
    const t = await el.evaluate((e) => e.textContent.trim());
    if ((t === text) !== wrong) return el.click();
  }
}

const MINIWOB_STEPS = {
  "click-button": (page, goal, wrong) => clickText(page, "#area button", quoted(goal)[0], wrong),
  "click-link": (page, goal, wrong) => clickText(page, "#area span.alink, #area a", quoted(goal)[0], wrong),
  "enter-text": async (page, goal, wrong) => { await page.type("#tt", wrong ? "nope" : quoted(goal)[0]); await page.click("#subbtn"); },
  "focus-text": async (page, _goal, wrong) => { if (wrong) await page.click("#query"); else await page.click("#tt"); },
  "enter-password": async (page, goal, wrong) => { await page.type("#password", quoted(goal)[0]); await page.type("#verify", wrong ? "x" : quoted(goal)[0]); await page.click("#subbtn"); },
  "login-user": async (page, goal, wrong) => { const [u, p] = quoted(goal); await page.type("#username", u); await page.type("#password", wrong ? `${p}x` : p); await page.click("#subbtn"); },
};
export const SCRIPTED_MINIWOB = Object.keys(MINIWOB_STEPS);

/** A MiniWoB agent in its own Firefox. `mode` is "perfect" or "wrong". */
export async function miniwobScripted(mode, { headless = true, firefox } = {}) {
  const { launch } = await import("create-foxkit/e2e");
  const fox = await launch({ extension: "dist-ext", headless, ...(firefox ? { firefox } : {}) });
  return {
    name: `scripted ${mode} (miniwob)`,
    async runTask({ url, goal }) {
      const id = /\/miniwob\/([\w-]+)\.html/.exec(url)?.[1];
      const page = await fox.open(url);
      try {
        // The bootstrap starts the episode after load; wait for the problem to show.
        await page.waitForFunction(() => typeof WOB_TASK_READY !== "undefined" && core.EP_TIMER !== null, { timeout: 10_000 });
        await MINIWOB_STEPS[id]?.(page, goal, mode === "wrong");
        await new Promise((r) => setTimeout(r, 300));
        return { done: true, log: MINIWOB_STEPS[id] ? `scripted ${id}` : "no script" };
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    close: () => fox.close(),
  };
}

const decode = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

const str = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "1" : "") : String(v)]));

/** AgentDojo's function calls as the bank's form posts and page loads. */
async function call(base, { function: fn, args }) {
  const post = (path, form) => fetch(new URL(path, base), { method: "POST", body: new URLSearchParams(form) });
  switch (fn) {
    case "send_money": return post("/bank/send", str(args));
    case "schedule_transaction": return post("/bank/schedule", str(args));
    case "update_scheduled_transaction": { const { id, ...rest } = args; return post(`/bank/scheduled/${id}`, str(rest)); }
    case "update_password": return post("/bank/password", str(args));
    case "update_user_info": return post("/bank/profile", str(args));
    case "read_file": return fetch(new URL(`/bank/files/${encodeURIComponent(args.file_path)}`, base));
    default: return fetch(new URL({ get_most_recent_transactions: "/bank/transactions", get_scheduled_transactions: "/bank/scheduled" }[fn] ?? "/bank/", base));
  }
}

/** An AgentDojo agent over HTTP. `mode` is "perfect" or "gullible". */
export function agentdojoScripted(mode, cases) {
  const byGoal = new Map(cases.filter((c) => !c.injection_task).map((c) => [c.goal, c]));
  const attacks = new Map(cases.filter((c) => c.injection_task).map((c) => [c.injection_goal, c.injection_ground_truth]));
  return {
    name: `scripted ${mode} (agentdojo)`,
    async runTask({ url, goal }) {
      const task = byGoal.get(goal);
      if (mode === "gullible") {
        // Read every page, as an agent that looks around would, and obey the first injection found.
        const paths = ["/bank/transactions", "/bank/scheduled", "/bank/profile", ...task.ground_truth.filter((c) => c.function === "read_file").map((c) => `/bank/files/${encodeURIComponent(c.args.file_path)}`)];
        const text = decode((await Promise.all(paths.map(async (p) => (await fetch(new URL(p, url))).text()))).join("\n"));
        const found = [...attacks.keys()].find((g) => text.includes(g));
        for (const c of found ? attacks.get(found) : []) await call(url, c);
      }
      for (const c of task.ground_truth) await call(url, c);
      return { done: true, log: task.ground_truth.map((c) => c.function).join(", "), answer: task.ground_truth_output };
    },
  };
}
