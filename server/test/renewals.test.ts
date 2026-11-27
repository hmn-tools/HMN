// "Expiring soon": a field of the type `expiry` puts its row on Today, Upcoming, and the weekly review. The lock
// screen and the display never get it. All data is fictional.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { call } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
type Item = { id: string; title: string; subtitle: string; type?: string };
type Screen = { sections: Array<{ id: string; label: string; trailing?: string; items: Item[] }> };

// 08:30 on Tuesday 24 November in Perth.
function clockedApp() {
  const now = new Date("2026-11-24T00:30:00.000Z");
  return createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-renew-")), kek: randomBytes(32), now: () => now, timeZone: "Australia/Perth" });
}

async function make(app: App, type: string, body: Record<string, unknown>) {
  const made = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as { id: string };
}

const asset = (app: App, title: string, expires: string | null, extra: Record<string, unknown> = {}) =>
  make(app, "asset", { title, kind: "document", ...extra, properties: expires ? { expires } : {} });
const screen = async (app: App, id: string, key?: string, surface?: string) =>
  (await call(app, `/api/v1/screens/${id}`, key ? { key, surface: surface ?? "display" } : owner(app))).json as Screen;
const renewals = (s: Screen) => s.sections.find((section) => section.id === "renewals");

test("an expiry in 12 days shows on Today, and one that ended 3 days ago says so", async () => {
  const app = clockedApp();
  try {
    const soon = await asset(app, "Example passport", "2026-12-06");
    await asset(app, "Example licence", "2026-11-21");
    const today = await screen(app, "today");
    const section = renewals(today)!;
    expect(section.label).toBe("Expiring soon");
    // The one that ended is the older date, so it comes first.
    expect(section.items.map((item) => item.title)).toEqual(["Example licence", "Example passport"]);
    expect(section.items[0]!.subtitle).toBe("Renewal or expiry · ended 3 days ago");
    expect(section.items[1]).toMatchObject({ id: soon.id, subtitle: "Renewal or expiry · ends in 12 days", type: "asset" });
    // It sits after Overdue and Due today, and before the family dates.
    const ids = today.sections.map((item) => item.id);
    for (const before of ["overdue", "due"]) if (ids.includes(before)) expect(ids.indexOf(before)).toBeLessThan(ids.indexOf("renewals"));
    if (ids.includes("family")) expect(ids.indexOf("renewals")).toBeLessThan(ids.indexOf("family"));
  } finally {
    app.close();
  }
});

test("today and tomorrow have their own words, and a far date is left out of Today", async () => {
  const app = clockedApp();
  try {
    await asset(app, "Example today", "2026-11-24");
    await asset(app, "Example tomorrow", "2026-11-25");
    await asset(app, "Example far", "2027-02-22");
    await asset(app, "Example ancient", "2026-09-01");
    const items = renewals(await screen(app, "today"))!.items;
    expect(items.map((item) => item.subtitle)).toEqual(["Renewal or expiry · ends today", "Renewal or expiry · ends tomorrow"]);
    expect(items.map((item) => item.title)).not.toContain("Example far");
  } finally {
    app.close();
  }
});

test("Upcoming shows an expiry in 45 days, and Today does not", async () => {
  const app = clockedApp();
  try {
    await asset(app, "Example registration", "2027-01-08");
    await asset(app, "Example past", "2026-11-20");
    const upcoming = renewals(await screen(app, "upcoming"))!;
    expect(upcoming.items.map((item) => item.title)).toEqual(["Example registration"]);
    expect(upcoming.items[0]!.subtitle).toBe("Renewal or expiry · ends in 45 days");
    expect(renewals(await screen(app, "today"))?.items.map((item) => item.title) ?? []).not.toContain("Example registration");
  } finally {
    app.close();
  }
});

test("a car's insurance, from the fields of its kind, shows", async () => {
  const app = clockedApp();
  try {
    await make(app, "asset", { title: "Example coupe", kind: "car", properties: { insurance_expires: "2026-12-10" } });
    const row = renewals(await screen(app, "today"))!.items.find((item) => item.title === "Example coupe")!;
    expect(row.subtitle).toBe("Insurance ends · ends in 16 days");
  } finally {
    app.close();
  }
});

test("the weekly review lists the next 7 days and the past, after Slipped", async () => {
  const app = clockedApp();
  try {
    await make(app, "task", { title: "Example late task", kind: "task", status: "open", due_at: "2026-11-20" });
    await asset(app, "Example this week", "2026-11-28");
    await asset(app, "Example next month", "2026-12-20");
    await asset(app, "Example lapsed", "2026-11-10");
    const week = await screen(app, "week");
    expect(renewals(week)!.items.map((item) => item.title)).toEqual(["Example lapsed", "Example this week"]);
    const ids = week.sections.map((item) => item.id);
    expect(ids.indexOf("renewals")).toBe(ids.indexOf("slipped") + 1);
  } finally {
    app.close();
  }
});

test("Today shows four and counts the rest", async () => {
  const app = clockedApp();
  try {
    for (let i = 1; i <= 6; i++) await asset(app, `Example item ${i}`, `2026-12-0${i}`);
    expect(renewals(await screen(app, "today"))!.trailing).toBe("4 of 6");
  } finally {
    app.close();
  }
});

test("one row with two expiry fields shows twice", async () => {
  const app = clockedApp();
  try {
    await make(app, "asset", { title: "Example van", kind: "car", properties: { expires: "2026-12-01", insurance_expires: "2026-12-02" } });
    const items = renewals(await screen(app, "today"))!.items.filter((item) => item.title === "Example van");
    expect(items.map((item) => item.subtitle)).toEqual(["Renewal or expiry · ends in 7 days", "Insurance ends · ends in 8 days"]);
  } finally {
    app.close();
  }
});

test("the lock screen and the display never get the section", async () => {
  const app = clockedApp();
  try {
    // A public row would pass the ceiling of the display. The surface keeps the section off.
    await asset(app, "Example public permit", "2026-11-26", { tier: "public" });
    expect(renewals(await screen(app, "today"))).toBeDefined();
    const lock = (await call(app, "/api/v1/screens/lock", owner(app))).json as Record<string, unknown>;
    expect(JSON.stringify(lock)).not.toContain("Example public permit");
    for (const id of ["today", "upcoming", "week"]) {
      const shown = await screen(app, id, app.secrets!.display, "display");
      expect(renewals(shown)).toBeUndefined();
      expect(JSON.stringify(shown)).not.toContain("Example public permit");
    }
  } finally {
    app.close();
  }
});

test("a bad stored value does not break the screen", async () => {
  const app = clockedApp();
  try {
    const bad = await asset(app, "Example bad", "2026-12-01");
    await asset(app, "Example good", "2026-12-02");
    app.hmn.store.db.query("UPDATE entities SET properties = json_set(properties, '$.expires', 'next friday') WHERE id = ?").run(bad.id);
    const today = await call(app, "/api/v1/screens/today", owner(app));
    expect(today.status).toBe(200);
    expect(renewals(today.json as Screen)!.items.map((item) => item.title)).toEqual(["Example good"]);
    app.hmn.store.db.query("UPDATE entities SET properties = json_set(properties, '$.expires', 42) WHERE id = ?").run(bad.id);
    expect((await call(app, "/api/v1/screens/week", owner(app))).status).toBe(200);
  } finally {
    app.close();
  }
});

test("a day with only an expiry is not called clear", async () => {
  const { summaryLine } = await import("../src/screens");
  expect(summaryLine(0, 0, 0, "phone", 0, 0, 1)).toBe("Nothing due, and one thing ending soon.");
  expect(summaryLine(0, 0, 0, "phone", 0, 0, 0)).toBe("The day is clear.");
});
