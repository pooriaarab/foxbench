// Tests for the tau2 airline site failure modes in docs/failure-modes.md
// (T18-T20), on tau2's real code, the same way as tests/tau2-retail.test.ts:
// a scripted agent does each task's gold actions through the pages.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchContext } from "../src/bench/registry.js";
import { AIRLINE_WRITES, startAirlineSite } from "../src/bench/tau2/airline.js";
import { fetchTau2, startBridge, type Tau2Bridge } from "../src/bench/tau2/bridge.js";
import type { Tau2Site } from "../src/bench/tau2/desk.js";
import { airlineStep, type Action } from "./fixtures/tau2-airline-agent.js";

const ctx = benchContext();
let bridge: Tau2Bridge;
let site: Tau2Site;
let tasks: { id: string; evaluation_criteria: { actions: Action[] | null } }[] = [];

beforeAll(async () => {
  const dir = await fetchTau2(ctx);
  tasks = JSON.parse(readFileSync(join(dir, "data/tau2/domains/airline/tasks.json"), "utf8"));
  bridge = await startBridge(ctx, "airline");
  site = await startAirlineSite(bridge, readFileSync(join(dir, "data/tau2/domains/airline/policy.md"), "utf8"));
}, 600_000);
afterAll(async () => {
  await site?.close();
  await bridge?.close();
});

const get = (path: string) => fetch(site.origin + path);

describe("tau2 airline site", () => {
  it("T18 the gold actions through the pages make the gold write calls, for all 50 tasks", async () => {
    expect(tasks).toHaveLength(50);
    const mismatched: string[] = [];
    for (const task of tasks) {
      const gold = (task.evaluation_criteria.actions ?? []).filter((a) => AIRLINE_WRITES.has(a.name));
      await site.reset();
      const want = [];
      for (const a of gold) want.push({ name: a.name, arguments: a.arguments, error: (await bridge.call(a.name, a.arguments)).error });
      await site.reset();
      for (const a of task.evaluation_criteria.actions ?? []) await airlineStep(site.origin, a);
      const got = site.calls.filter((c) => AIRLINE_WRITES.has(c.name)).map((c) => ({ name: c.name, arguments: c.arguments, error: c.error }));
      try {
        expect(got).toEqual(want);
      } catch {
        mismatched.push(`${task.id}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
    }
    expect(mismatched).toEqual([]);
  }, 600_000);

  it("T19 each page view is one read call, and the forms start from the reservation", async () => {
    await site.reset();
    const html = await (await get("/reservations/4WQ150")).text();
    expect(html).toMatch(/name="flight_number_0" value="HAT\d+"/);
    expect(html).toMatch(/name="first_name_0" value="\w+"/);
    for (const path of ["/", "/airports", "/users/chen_jackson_3290", "/flights?origin=JFK&destination=SFO&date=2024-05-20&stops=direct", "/status?flight_number=HAT001&date=2024-05-20", "/policy", "/transfer"]) {
      const before = site.calls.length;
      expect((await get(path)).status).toBeLessThan(500);
      expect(site.calls.length - before).toBeLessThanOrEqual(1);
    }
    expect(site.calls.every((c) => !AIRLINE_WRITES.has(c.name))).toBe(true);
  });

  it("T20 empty rows are left out and numbers stay numbers", async () => {
    await site.reset();
    const res = await fetch(`${site.origin}/reservations/4WQ150/baggages`, { method: "POST", body: new URLSearchParams({ total_baggages: "2", nonfree_baggages: "0", payment_id: "nope" }) });
    expect(res.status).toBe(400);
    expect(site.calls.at(-1)).toMatchObject({ name: "update_reservation_baggages", arguments: { total_baggages: 2, nonfree_baggages: 0 }, error: true });
    await fetch(`${site.origin}/reservations/4WQ150/passengers`, { method: "POST", body: new URLSearchParams({ first_name_0: "Ann", last_name_0: "Lee", dob_0: "1990-01-01", first_name_1: "", last_name_1: "", dob_1: "" }) });
    expect(site.calls.at(-1)!.arguments).toEqual({ reservation_id: "4WQ150", passengers: [{ first_name: "Ann", last_name: "Lee", dob: "1990-01-01" }] });
  });
});
