// Routines for the children: a habit for a person, on some days of the week, with a check-in for today. A child
// ticks only the child's own. There is no streak and no score. docs/ONTOLOGY.md, section 2.5.
// All data is fictional.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { displayAccess } from "../src/devices/trmnl";
import { cadenceLabel, dueOn, routineDays } from "../src/routines";
import { call } from "./helpers";

const AWAY = "10.7.7.9";
const FRIDGE_IP = "10.0.0.41";
const FRIDGE = "41:B4:10:39:A1:62";
const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone", ip: AWAY });
const as = (secret: string) => ({ key: secret, surface: "phone", ip: AWAY });

type Habit = { id: string; title: string; properties: Record<string, unknown> };
type Routine = { habit: Habit; for: Array<{ id: string; title: string }>; days: string[]; due_today: boolean; done_today: boolean };
type Screen = { summary: string; due_count: number; sections: Array<{ id: string; trailing?: string; items: Array<{ id: string; title: string; subtitle: string; done: boolean }> }> };

function clockedApp(iso: string) {
  const clock = { now: new Date(iso) };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-routines-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

async function person(app: App, title: string, tier = "household") {
  const made = await call(app, "/api/v1/person", { method: "POST", ...owner(app), body: { title, kind: "family", tier } });
  expect(made.status).toBe(201);
  return (made.json as { id: string }).id;
}

async function pairMember(app: App, personId: string, role: string) {
  const made = await call(app, "/api/v1/members/pairing", { method: "POST", ...owner(app), body: { person_id: personId, role } });
  expect(made.status).toBe(201);
  const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example phone" } });
  expect(paired.status).toBe(201);
  return (paired.json as { secret: string }).secret;
}

async function routine(app: App, title: string, personId: string, days?: string[]) {
  const made = await call(app, "/api/v1/routines", { method: "POST", ...owner(app), body: { title, person_id: personId, ...(days ? { days } : {}) } });
  expect(made.status).toBe(201);
  return made.json as Routine;
}

const home = async (app: App, secret: string) => (await call(app, "/api/v1/screens/home", as(secret))).json as Screen;
const section = (screen: Screen, id: string) => screen.sections.find((item) => item.id === id);

test("the days of a routine: every day, weekdays, some days, and a bad value", () => {
  expect(routineDays(["Wed", "mon", "monday"])).toEqual(["mon", "wed"]);
  expect(routineDays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).toEqual([]);
  expect(cadenceLabel([])).toBe("Every day");
  expect(cadenceLabel(["mon", "tue", "wed", "thu", "fri"])).toBe("Weekdays");
  expect(cadenceLabel(["sat", "sun"])).toBe("Weekends");
  expect(cadenceLabel(["mon", "wed"])).toBe("Mon, Wed");
  expect(dueOn([], "Sun")).toBe(true);
  expect(dueOn(["mon", "wed"], "Wed")).toBe(true);
  expect(dueOn(["mon", "wed"], "Thu")).toBe(false);
  expect(() => routineDays(["someday"], true)).toThrow();
  expect(() => routineDays("mon", true)).toThrow();
});

test("a child sees and ticks today's routines on Home, takes a tick back, and cannot tick another child's", async () => {
  // 18:00 in Perth on Wednesday 11 November.
  const { app } = clockedApp("2026-11-11T10:00:00.000Z");
  try {
    const kid = await person(app, "Example Kid");
    const other = await person(app, "Example Other Kid");
    const cat = await routine(app, "Feed the cat", kid, ["mon", "wed"]);
    expect(cat.days).toEqual(["mon", "wed"]);
    expect(cat.habit.properties.cadence).toBe("Mon, Wed");
    expect(cat.due_today).toBe(true);
    const bag = await routine(app, "Pack the school bag", kid, ["tue"]);
    expect(bag.due_today).toBe(false);
    const plants = await routine(app, "Water the plants", other);
    expect(plants.habit.properties.cadence).toBe("Every day");

    // The owner's Today keeps the owner's own habits. The children's routines are the household's.
    const today = (await call(app, "/api/v1/screens/today", owner(app))).json as Screen;
    expect(JSON.stringify(today)).not.toContain("Feed the cat");

    const kidKey = await pairMember(app, kid, "child");
    let screen = await home(app, kidKey);
    expect(section(screen, "routines")!.items.map((item) => item.title)).toEqual(["Feed the cat"]);
    expect(section(screen, "routines")!.trailing).toBe("1 left");
    expect(screen.due_count).toBe(1);

    const ticked = await call(app, `/api/v1/habits/${cat.habit.id}/check-in`, { method: "POST", ...as(kidKey) });
    expect(ticked.status).toBe(200);
    expect((ticked.json as Habit).properties).toMatchObject({ last_check_in: "2026-11-11", checked_by: "Example Kid" });
    screen = await home(app, kidKey);
    expect(section(screen, "routines")!.items[0]!.done).toBe(true);
    expect(section(screen, "routines")!.items[0]!.subtitle).toBe("Done 18:00");
    expect(section(screen, "routines")!.trailing).toBe("All done");
    expect(screen.due_count).toBe(0);

    // A tick by mistake comes back off. A second tick on the same day changes nothing.
    expect((await call(app, `/api/v1/habits/${cat.habit.id}/check-in`, { method: "DELETE", ...as(kidKey) })).status).toBe(200);
    expect(section(await home(app, kidKey), "routines")!.items[0]!.done).toBe(false);
    await call(app, `/api/v1/habits/${cat.habit.id}/check-in`, { method: "POST", ...as(kidKey) });
    await call(app, `/api/v1/habits/${cat.habit.id}/check-in`, { method: "POST", ...as(kidKey) });
    expect(section(await home(app, kidKey), "routines")!.items[0]!.done).toBe(true);

    // Another child's routine is at Household, so the child reads it, but cannot tick it or take its tick back.
    const refused = await call(app, `/api/v1/habits/${plants.habit.id}/check-in`, { method: "POST", ...as(kidKey) });
    expect(refused.status).toBe(403);
    expect((await call(app, `/api/v1/habits/${plants.habit.id}/check-in`, { method: "DELETE", ...as(kidKey) })).status).toBe(403);
    // A child does not make routines.
    expect((await call(app, "/api/v1/routines", { method: "POST", ...as(kidKey), body: { title: "Example no bedtime", person_id: kid } })).status).toBe(403);

    // A partner sees every child's routine with the name, and ticks for a child.
    const partner = await pairMember(app, await person(app, "Example Partner"), "partner");
    const theirs = await home(app, partner);
    expect(section(theirs, "routines")!.items.map((item) => item.subtitle)).toEqual(["Example Kid · Done 18:00 by Example Kid", "Example Other Kid"]);
    expect((await call(app, `/api/v1/habits/${plants.habit.id}/check-in`, { method: "POST", ...as(partner) })).status).toBe(200);
    const list = (await call(app, "/api/v1/routines", owner(app))).json as { routines: Routine[] };
    expect(list.routines.find((entry) => entry.habit.id === plants.habit.id)).toMatchObject({ done_today: true, habit: { properties: { checked_by: "Example Partner" } } });
  } finally {
    app.close();
  }
});

test("a routine needs a person at Household, real days, and the owner", async () => {
  const { app } = clockedApp("2026-11-11T10:00:00.000Z");
  try {
    const quiet = await person(app, "Example Private Kid", "private");
    const private_ = await call(app, "/api/v1/routines", { method: "POST", ...owner(app), body: { title: "Feed the cat", person_id: quiet } });
    expect(private_.status).toBe(422);
    const kid = await person(app, "Example Kid");
    expect((await call(app, "/api/v1/routines", { method: "POST", ...owner(app), body: { title: "Feed the cat", person_id: kid, days: ["someday"] } })).status).toBe(422);
    expect((await call(app, "/api/v1/routines", { method: "POST", ...owner(app), body: { title: " ", person_id: kid } })).status).toBe(422);
  } finally {
    app.close();
  }
});

test("the fridge shows what is left of each child's routines, and 'all done'", async () => {
  // 07:30 in Perth on Thursday 12 November: the morning screen.
  const { app, clock } = clockedApp("2026-11-11T23:30:00.000Z");
  try {
    const setup = () => app.fetch(new Request("https://hmn.local/api/setup", { headers: { ID: FRIDGE, Model: "og_4clr" } }), FRIDGE_IP).then((r) => r.json() as Promise<{ api_key: string | null; friendly_id: string }>);
    const first = await setup();
    expect((await call(app, `/api/v1/trmnl/devices/${first.friendly_id}/claim`, { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1", body: { name: "Fridge", ceiling: "household" } })).status).toBe(200);
    const key = (await setup()).api_key!;
    const fridge = (id: "morning" | "evening") => app.hmn.fridgeScreen(displayAccess(app.hmn, key, FRIDGE_IP).access, id);

    const kid = await person(app, "Example Kid");
    const cat = await routine(app, "Feed the cat", kid);
    await routine(app, "Pack the school bag", kid, ["mon", "tue", "wed", "thu", "fri"]);
    await routine(app, "Example Sunday routine", kid, ["sun"]);
    let rows = fridge("morning").panes.find((item) => item.id === "routines")!.items;
    expect(rows).toEqual([{ time: "Example Kid", text: "Feed the cat, Pack the school bag", mark: "left" }]);

    const kidKey = await pairMember(app, kid, "child");
    await call(app, `/api/v1/habits/${cat.habit.id}/check-in`, { method: "POST", ...as(kidKey) });
    rows = fridge("morning").panes.find((item) => item.id === "routines")!.items;
    expect(rows).toEqual([{ time: "Example Kid", text: "Pack the school bag", mark: "left" }]);

    // 18:00: the evening screen. The bag is packed.
    clock.now = new Date("2026-11-12T10:00:00.000Z");
    const bag = ((await call(app, "/api/v1/routines", owner(app))).json as { routines: Routine[] }).routines.find((entry) => entry.habit.title === "Pack the school bag")!;
    await call(app, `/api/v1/habits/${bag.habit.id}/check-in`, { method: "POST", ...as(kidKey) });
    rows = fridge("evening").panes.find((item) => item.id === "routines")!.items;
    expect(rows).toEqual([{ time: "Example Kid", text: "all done" }]);
  } finally {
    app.close();
  }
});
