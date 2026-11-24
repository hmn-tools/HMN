// The yearly review: one card for a calendar year, made from the record, and one note that the owner writes.
// No charts, no streaks, no comparison with another year. docs/STRATEGY.md, role 7. All data is fictional.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { call } from "./helpers";

const AWAY = "10.7.7.8";
const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone", ip: AWAY });

type Review = {
  year: number;
  greeting: string;
  summary: string;
  closing: string;
  years: number[];
  note: { id: string; body: string | null; tier: string } | null;
  sections: Array<{ id: string; label: string; trailing?: string; items: Array<{ id: string; title: string; subtitle: string; done: boolean }> }>;
};

function clockedApp(iso: string) {
  const clock = { now: new Date(iso) };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-year-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

async function make(app: App, type: string, body: Record<string, unknown>) {
  const made = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as { id: string };
}

async function link(app: App, fromType: string, fromId: string, rel: string, toId: string) {
  expect((await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_type: fromType, from_id: fromId, rel, to_type: "person", to_id: toId } })).status).toBe(201);
}

const review = async (app: App, year?: number) => (await call(app, `/api/v1/review/year${year ? `?year=${year}` : ""}`, owner(app))).json as Review;
const section = (screen: Review, id: string) => screen.sections.find((item) => item.id === id);

// The owner key of a test app lasts 90 days, so the dates of this test stay inside that.
test("the yearly review has the goals, the finished projects, the months, the people, and what is still open", async () => {
  const { app, clock } = clockedApp("2026-08-20T02:00:00.000Z");
  try {
    const passport = await make(app, "task", { title: "Example renew the passport", kind: "task", status: "open", tier: "personal" });
    await link(app, "task", passport.id, "for", "person_sam");
    expect((await call(app, `/api/v1/task/${passport.id}`, { method: "PATCH", ...owner(app), body: { status: "done" } })).status).toBe(200);
    const recital = await make(app, "event", { title: "Example recital", kind: "family", status: "upcoming", tier: "private", due_at: "2026-08-22T08:00:00.000Z" });
    await link(app, "event", recital.id, "with", "person_yves");

    clock.now = new Date("2026-09-15T02:00:00.000Z");
    const garden = await make(app, "project", { title: "Example new garden bed", status: "active", tier: "personal" });
    expect((await call(app, `/api/v1/project/${garden.id}`, { method: "PATCH", ...owner(app), body: { status: "done" } })).status).toBe(200);
    await make(app, "goal", { title: "Example run ten kilometres", status: "done", tier: "personal" });

    clock.now = new Date("2026-10-01T02:00:00.000Z");
    const gate = await make(app, "task", { title: "Example fix the side gate", kind: "task", status: "open", tier: "personal" });

    clock.now = new Date("2026-11-11T04:39:00.000Z");
    const year = await review(app);
    expect(year.year).toBe(2026);
    expect(year.greeting).toBe("Your 2026 so far.");
    expect(year.closing).toBe("Write down what the year was for. Keep what matters.");
    expect(year.summary).toContain("1 project finished");
    expect(year.summary).toContain("1 goal reached");
    expect(section(year, "goals")!.items.find((item) => item.title === "Example run ten kilometres")).toMatchObject({ subtitle: "Reached", done: true });
    expect(section(year, "finished")!.items).toEqual([{ id: garden.id, title: "Example new garden bed", subtitle: "Done in September", glyph: "checkbox", done: true }] as never);
    const august = section(year, "months")!.items.find((item) => item.title === "August")!;
    expect(august.subtitle).toContain("1 family date");
    const people = section(year, "people")!.items;
    expect(people.find((item) => item.id === "person_sam")!.subtitle).toBe("1 task");
    // The recital, and the school concert of the demonstration data.
    expect(people.find((item) => item.id === "person_yves")!.subtitle).toBe("2 dates");
    // The owner is not one of the people of the owner's year.
    expect(people.map((item) => item.id)).not.toContain("person_alex");
    expect(section(year, "open")!.label).toBe("Still open");
    expect(JSON.stringify(section(year, "open"))).toContain(gate.id);
    // No chart, no streak, no comparison.
    expect(JSON.stringify(year)).not.toMatch(/streak|last year|% /i);
    expect(year.years).toEqual([2026]);
  } finally {
    app.close();
  }
});

test("a year with no record answers with an empty card, and a year to come is refused", async () => {
  const { app } = clockedApp("2026-11-11T04:39:00.000Z");
  try {
    const old = await review(app, 2025);
    expect(old.greeting).toBe("Your 2025.");
    expect(old.sections).toEqual([]);
    expect(old.summary).toBe("Nothing done.");
    expect((await call(app, "/api/v1/review/year?year=2027", owner(app))).status).toBe(422);
    expect((await call(app, "/api/v1/review/year?year=abc", owner(app))).status).toBe(422);
  } finally {
    app.close();
  }
});

test("the owner writes one Private note for a year, and a member can neither read nor write it", async () => {
  const { app } = clockedApp("2026-11-11T04:39:00.000Z");
  try {
    const first = await call(app, "/api/v1/review/year/2026/note", { method: "PUT", ...owner(app), body: { body: "Example: the year of the garden." } });
    expect(first.status).toBe(200);
    const id = (first.json as { id: string; tier: string }).id;
    expect((first.json as { tier: string }).tier).toBe("private");
    const second = await call(app, "/api/v1/review/year/2026/note", { method: "PUT", ...owner(app), body: { body: "Example: the year of the garden, and the gate." } });
    expect((second.json as { id: string }).id).toBe(id);
    const year = await review(app);
    expect(year.note).toMatchObject({ id, body: "Example: the year of the garden, and the gate." });
    // The note of the year is not one of the notes it counts.
    expect(year.summary).not.toContain("note");

    const kid = await make(app, "person", { title: "Example Kid", kind: "child", tier: "household" });
    const made = await call(app, "/api/v1/members/pairing", { method: "POST", ...owner(app), body: { person_id: kid.id, role: "child" } });
    const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example phone" } });
    const child = { key: (paired.json as { secret: string }).secret, surface: "phone", ip: AWAY };
    expect(((await call(app, "/api/v1/review/year", child)).json as Review).note).toBeNull();
    expect((await call(app, "/api/v1/review/year/2026/note", { method: "PUT", ...child, body: { body: "Example: mine now." } })).status).toBe(403);
    expect((await call(app, "/api/v1/review/year/2025/note", { method: "PUT", ...owner(app), body: { body: "Example." } })).status).toBe(200);
    expect((await call(app, "/api/v1/review/year/2027/note", { method: "PUT", ...owner(app), body: { body: "Example." } })).status).toBe(422);
  } finally {
    app.close();
  }
});
