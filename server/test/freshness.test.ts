// What the screens leave out, and what they put first: an event that is over leaves, a task whose day has passed
// is overdue, and a bad date cannot break a screen. All data is fictional.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { eventOver, readableDue } from "../src/time";
import { call } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
type Screen = { summary: string; due_count: number; next: { title: string } | null; sections: Array<{ id: string; label: string; trailing?: string; items: Array<{ id: string; title: string; subtitle: string }> }> };

function clockedApp(iso: string) {
  const clock = { now: new Date(iso) };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fresh-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

async function make(app: App, type: string, body: Record<string, unknown>) {
  const made = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as { id: string };
}

const screen = async (app: App, id: string) => (await call(app, `/api/v1/screens/${id}`, owner(app))).json as Screen;
const titles = (s: Screen) => s.sections.flatMap((section) => section.items.map((item) => item.title));
const section = (s: Screen, id: string) => s.sections.find((item) => item.id === id);

test("when an event is over", () => {
  const now = new Date("2026-11-22T10:00:00.000Z"); // 18:00 in Perth
  const at = (due: string, extra: Record<string, unknown> = {}) => ({ due_at: due, status: "upcoming", properties: extra });
  // A game that started four hours ago is over. One that started an hour ago is still on.
  expect(eventOver(at("2026-11-22T06:00:00.000Z"), now, "Australia/Perth", true)).toBe(true);
  expect(eventOver(at("2026-11-22T09:00:00.000Z"), now, "Australia/Perth", true)).toBe(false);
  // An all-day event lasts through its day. One of three days lasts through the third.
  expect(eventOver(at("2026-11-22"), now, "Australia/Perth")).toBe(false);
  expect(eventOver(at("2026-11-21"), now, "Australia/Perth")).toBe(true);
  expect(eventOver(at("2026-11-20", { end_at: "2026-11-23" }), now, "Australia/Perth")).toBe(false);
  // A meeting with an end at 19:00 is on at 18:00. A cancelled one never shows.
  expect(eventOver(at("2026-11-22T09:30:00.000Z", { end_at: "2026-11-22T11:00:00.000Z" }), now, "Australia/Perth")).toBe(false);
  expect(eventOver({ ...at("2026-11-23T01:00:00.000Z"), status: "cancelled" }, now, "Australia/Perth")).toBe(true);
  expect(readableDue("2026-11-22")).toBe(true);
  expect(readableDue("2026-11-22T10:00:00.000Z")).toBe(true);
  expect(readableDue("next friday")).toBe(false);
  expect(readableDue("2026-13-45")).toBe(false);
});

test("a game that is over leaves Today, Upcoming, Week, the next event, and the lock screen", async () => {
  // 18:00 in Perth on Sunday 22 November. The demonstration race started at 14:00.
  const { app } = clockedApp("2026-11-22T10:00:00.000Z");
  try {
    const later = await make(app, "event", { title: "Example evening match", kind: "fixture", status: "upcoming", tier: "public", due_at: "2026-11-22T12:30:00.000Z" });
    for (const id of ["today", "upcoming", "week"]) {
      const shown = titles(await screen(app, id));
      expect(shown).not.toContain("Lakeside Grand Prix");
      expect(shown).toContain("Example evening match");
    }
    const today = await screen(app, "today");
    expect(today.next?.title).toBe("Example evening match");
    const lock = (await call(app, "/api/v1/screens/lock", owner(app))).json as { next: { title: string } | null };
    expect(lock.next?.title).toBe("Example evening match");
    void later;
  } finally {
    app.close();
  }
});

test("a task whose day has passed is overdue, first on Today, and counted", async () => {
  const { app } = clockedApp("2026-11-24T00:30:00.000Z"); // 08:30 in Perth on Tuesday 24 November
  try {
    await make(app, "task", { title: "Example renew the permit", kind: "task", status: "open", due_at: "2026-11-21" });
    const today = await screen(app, "today");
    expect(today.sections[0]!.id).toBe("overdue");
    const row = section(today, "overdue")!.items.find((item) => item.title === "Example renew the permit")!;
    expect(row.subtitle).toBe("3 days late");
    expect(today.due_count).toBeGreaterThanOrEqual(section(today, "overdue")!.items.length);
    expect(today.summary).toMatch(/overdue/);
    // The weekly review puts what slipped first, and says how late it is.
    const week = await screen(app, "week");
    expect(week.sections[0]!.id).toBe("slipped");
    expect(section(week, "slipped")!.items.find((item) => item.title === "Example renew the permit")!.subtitle).toBe("3 days late");
  } finally {
    app.close();
  }
});

test("a cancelled date is not coming, and Upcoming stops at two weeks", async () => {
  const { app } = clockedApp("2026-11-11T04:39:00.000Z");
  try {
    await make(app, "event", { title: "Example cancelled recital", kind: "family", status: "cancelled", due_at: "2026-11-14T08:00:00.000Z" });
    await make(app, "event", { title: "Example wedding in March", kind: "family", status: "upcoming", due_at: "2027-03-20" });
    for (const id of ["today", "upcoming", "week"]) {
      const shown = titles(await screen(app, id));
      expect(shown).not.toContain("Example cancelled recital");
      expect(shown).not.toContain("Example wedding in March");
    }
  } finally {
    app.close();
  }
});

test("a habit shows on Today only on its days", async () => {
  // Wednesday 11 November in Perth.
  const { app } = clockedApp("2026-11-11T04:39:00.000Z");
  try {
    await make(app, "habit", { title: "Example Monday stretch", status: "active", properties: { days: ["mon"] } });
    await make(app, "habit", { title: "Example daily walk", status: "active" });
    const shown = titles(await screen(app, "today"));
    expect(shown).toContain("Example daily walk");
    expect(shown).not.toContain("Example Monday stretch");
  } finally {
    app.close();
  }
});
