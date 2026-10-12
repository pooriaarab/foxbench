// Scripted agents that check the external harness, the way e2e/scripted.mjs
// checks the foxbench sites. They are not part of the package.
//   miniwob perfect   solves six MiniWoB tasks in a real Firefox, with real
//                     clicks and keys; each must pass on MiniWoB's own reward
//   miniwob wrong     clicks the wrong thing on the same six; each must fail
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
