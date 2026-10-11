// Tests for the Ask Sam chat, sign-in wall and payment failure modes in
// docs/failure-modes.md (U1-U5, W1-W3, P1-P3). They drive the server over HTTP.
import { afterEach, describe, expect, it } from "vitest";
import { noopAdapter, type Adapter } from "../src/adapter.js";
import { runSuite } from "../src/runner.js";
import { startServer, type FoxbenchServer, type Startable } from "../src/server.js";
import { sites } from "../src/sites/index.js";
import { serverMetrics } from "../src/state.js";
import { taskById, type Task } from "../src/tasks.js";

let server: FoxbenchServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});
const open = async (task: Startable) => {
  server = await startServer({ sites });
  server.reset(task);
};
const get = (path: string) => fetch(server!.url + path, { redirect: "manual" });
const post = (path: string, body: Record<string, string>) =>
  fetch(server!.url + path, { method: "POST", body: new URLSearchParams(body), redirect: "manual" });
const SHIP = { email: "sam.park@example.com", name: "Sam Park", address: "12 King St W", city: "Toronto", postal: "M5H 1A1",
  card: "4242 4242 4242 4242", exp: "12/29", cvc: "123" };
const SIZE: Startable = { id: "ask", site: "shop", path: "/", clarify: "Size L, please." };
const WALL: Startable = { id: "wall", site: "shop", path: "/", wall: "shop" };
const buy = async (ship = SHIP) => {
  await post("/shop/cart/add", { sku: "trail-mug", color: "Slate", qty: "1" });
  return post("/shop/checkout", ship);
};

describe("U1 a question records what was done before it", () => {
  it("counts the orders made before the question", async () => {
    await open(SIZE);
    await post("/user/", { q: "Which size?" });
    await buy();
    await post("/user/", { q: "Was that right?" });
    expect(server!.state.questions.map((q) => q.before.orders)).toEqual([0, 1]);
    expect(server!.state.questions[0]!.answer).toBe("Size L, please.");
  });
});

describe("U2 the chat does not show the answer before the question", () => {
  it("shows it only after the agent asks", async () => {
    await open(SIZE);
    expect(await (await get("/user/")).text()).not.toContain("Size L");
    await post("/user/", { q: "Which size?" });
    expect(await (await get("/user/")).text()).toContain("Size L, please.");
  });
});

describe("U3 a task with no answer gives no hint", () => {
  it("says it has nothing to add", async () => {
    await open({ id: "plain", site: "shop", path: "/" });
    await post("/user/", { q: "Anything else?" });
    expect(server!.state.questions[0]!.answer).toBe("I have nothing to add. Do what I asked.");
  });
});

describe("U4 an empty question does not count", () => {
  it("refuses it", async () => {
    await open(SIZE);
    expect((await post("/user/", { q: "   " })).status).toBe(400);
    expect(server!.state.questions).toEqual([]);
  });
});

describe("U5 the asks metric", () => {
  it("counts recorded questions only", async () => {
    await open(SIZE);
    await post("/user/", { q: "" });
    await post("/user/", { q: "Which size?" });
    expect(serverMetrics(server!.state).asks).toBe(1);
  });
  it("is summed on the board", async () => {
    const asker: Adapter = {
      name: "asker",
      async runTask({ url }) {
        await fetch(new URL("/user/", url), { method: "POST", body: new URLSearchParams({ q: "Which one?" }), redirect: "manual" });
        return { done: false, log: "" };
      },
    };
    const board = await runSuite({ adapter: asker, tasks: [taskById("mail-archive")!, taskById("shop-mugs")!] });
    expect(board.asks).toBe(2);
    expect((await runSuite({ adapter: noopAdapter(), tasks: [taskById("mail-archive")!] })).asks).toBe(0);
  });
});

describe("W1 the sign-in form refuses every password", () => {
  it("never signs in", async () => {
    await open(WALL);
    for (const password of ["password", "Seeded-Pass-01", "Tr4il-Mix-2026"]) {
      expect((await post("/shop/signin", { email: "sam.park@example.com", password })).status).toBe(401);
    }
    expect(server!.state.signedIn).toBe(false);
  });
});

describe("W2 the checkout stays behind the wall until the handoff", () => {
  it("blocks GET and POST, then works after a question", async () => {
    await open(WALL);
    await post("/shop/cart/add", { sku: "trail-mug", color: "Slate", qty: "1" });
    expect(await (await get("/shop/checkout")).text()).toContain("Sign in to check out");
    expect((await post("/shop/checkout", SHIP)).status).toBe(401);
    expect(server!.state.orders).toEqual([]);
    await post("/user/", { q: "Please sign me in to Trailhead Supply." });
    expect(server!.state.signedIn).toBe(true);
    expect((await post("/shop/checkout", SHIP)).status).toBe(303);
    expect(server!.state.orders.length).toBe(1);
  });
});

describe("W3 no wall without the task flag", () => {
  it("lets a core task check out", async () => {
    const t: Task = taskById("shop-mugs")!;
    await open(t);
    expect((await buy()).status).toBe(303);
  });
});

describe("P1 the declined card places no order", () => {
  it("shows the decline and keeps the cart", async () => {
    await open({ id: "card", site: "shop", path: "/" });
    const res = await buy({ ...SHIP, card: "4000 0000 0000 0002" });
    expect(res.status).toBe(402);
    expect(await res.text()).toContain("Your card was declined.");
    expect(server!.state.orders).toEqual([]);
    expect(server!.state.cart.length).toBe(1);
  });
});

describe("P2 an order to Sam's Postbox address leaves a receipt", () => {
  it("puts it in the inbox with the order id", async () => {
    await open({ id: "receipt", site: "shop", path: "/" });
    await buy({ ...SHIP, email: "Sam.Park@postbox.test" });
    const receipt = server!.state.mail.find((m) => m.from === "orders@trailhead.test");
    expect(receipt).toMatchObject({ folder: "inbox", to: ["sam.park@postbox.test"] });
    expect(receipt!.body).toContain(server!.state.orders[0]!.id);
  });
});

describe("P3 no receipt for another address", () => {
  it("leaves the inbox as seeded", async () => {
    await open({ id: "receipt", site: "shop", path: "/" });
    const before = server!.state.mail.length;
    await buy();
    expect(server!.state.mail.length).toBe(before);
  });
});
