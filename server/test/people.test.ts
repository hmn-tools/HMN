// The person page: the hub of a relationship. The People list gives each person one line, the relation and the
// next date. An organisation is a person of the kind `organisation`. docs/ONTOLOGY.md, sections 2.2 and 5.2.
// All data is fictional.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { ensureKindTables } from "../src/kinds";
import { dayLabel, personLine } from "../src/people";
import { call, testApp } from "./helpers";

const AWAY = "10.7.7.8";
const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

type Row = { entity: { id: string; title: string; type: string } };
type Page = { line: string; kind_title: string | null; organisation: boolean; next: Row[]; tasks: Row[]; done: Row[]; notes: Row[]; things: Row[]; people: Row[]; routines: unknown[] };
type People = { people: Array<{ person: { id: string; title: string }; line: string; organisation: boolean }> };

async function make(app: App, type: string, body: Record<string, unknown>) {
  const made = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as { id: string };
}

async function link(app: App, fromType: string, fromId: string, rel: string, toType: string, toId: string) {
  expect((await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_type: fromType, from_id: fromId, rel, to_type: toType, to_id: toId } })).status).toBe(201);
}

test("the line of a person: the relation, and the next date", () => {
  // Wednesday 11 November, 12:39 in Perth.
  const now = new Date("2026-11-11T04:39:00.000Z");
  expect(dayLabel("2026-11-11T09:00:00.000Z", now, "Australia/Perth")).toBe("today");
  expect(dayLabel("2026-11-12", now, "Australia/Perth")).toBe("tomorrow");
  expect(dayLabel("2026-11-13T08:30:00.000Z", now, "Australia/Perth")).toBe("Fri 13/11");
  expect(personLine("Spouse", null, now, "Australia/Perth")).toBe("Spouse");
  expect(personLine(null, null, now, "Australia/Perth")).toBe("");
});

test("a person page has the next dates, the open tasks, the notes, and the things", async () => {
  const app = testApp();
  try {
    // The seed note about Yves is Sealed, so it is absent without the vault. A Personal note shows.
    const note = await make(app, "note", { title: "Example sizes for Yves", status: "open", tier: "personal" });
    await link(app, "note", note.id, "about", "person", "person_yves");
    const page = (await call(app, "/api/v1/person/person_yves/page", owner(app))).json as Page;
    expect(page.kind_title).toBe("Child");
    expect(page.notes.map((row) => row.entity.id)).not.toContain("note_trip");
    expect(page.next.map((row) => row.entity.id)).toContain("event_concert");
    expect(page.notes.map((row) => row.entity.id)).toEqual([note.id]);
    expect(page.line.startsWith("Child · ")).toBe(true);
    expect(page.line.endsWith("Fri 13/11")).toBe(true);
    expect((page.next.find((row) => row.entity.id === "event_concert") as unknown as { when: string }).when).toBe("Fri 13/11 · 16:30");

    const luca = (await call(app, "/api/v1/person/person_luca/page", owner(app))).json as Page;
    expect(luca.tasks.map((row) => row.entity.id)).toContain("task_dentist");
    const alex = (await call(app, "/api/v1/person/person_alex/page", owner(app))).json as Page;
    expect(alex.things.map((row) => row.entity.id)).toContain("asset_coupe");

    // A task done in the last 14 days shows as done, and leaves the open tasks.
    expect((await call(app, "/api/v1/task/task_dentist", { method: "PATCH", ...owner(app), body: { status: "done" } })).status).toBe(200);
    const after = (await call(app, "/api/v1/person/person_luca/page", owner(app))).json as Page;
    expect(after.tasks.map((row) => row.entity.id)).not.toContain("task_dentist");
    expect(after.done.map((row) => row.entity.id)).toContain("task_dentist");

    expect((await call(app, "/api/v1/person/person_nobody/page", owner(app))).status).toBe(404);
  } finally {
    app.close();
  }
});

test("an organisation is a person of its own kind, and the People list puts it last", async () => {
  const app = testApp();
  try {
    const school = await make(app, "person", { title: "Example Riverside School", kind: "organisation" });
    const evening = await make(app, "event", { title: "Example parents' evening", kind: "appointment", status: "upcoming", due_at: "2026-11-13T10:00:00.000Z" });
    await link(app, "event", evening.id, "with", "person", school.id);
    await link(app, "person", "person_yves", "with", "person", school.id);

    const page = (await call(app, `/api/v1/person/${school.id}/page`, owner(app))).json as Page;
    expect(page.organisation).toBe(true);
    expect(page.kind_title).toBe("Organisation");
    expect(page.line).toBe("Organisation · Example parents' evening · Fri 13/11");
    expect(page.people.map((row) => row.entity.id)).toEqual(["person_yves"]);

    const people = (await call(app, "/api/v1/people", owner(app))).json as People;
    expect(people.people.at(-1)).toMatchObject({ person: { id: school.id }, organisation: true });
    expect(people.people.find((entry) => entry.person.id === "person_sam")!.line.startsWith("Spouse")).toBe(true);
  } finally {
    app.close();
  }
});

test("a member reads only the people the member can see", async () => {
  const app = testApp();
  try {
    const kid = await make(app, "person", { title: "Example Kid", kind: "child", tier: "household" });
    const made = await call(app, "/api/v1/members/pairing", { method: "POST", ...owner(app), ip: AWAY, body: { person_id: kid.id, role: "child" } });
    const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example phone" } });
    const child = { key: (paired.json as { secret: string }).secret, surface: "phone", ip: AWAY };
    // Yves is Private in the Family area. A child reads Household only.
    expect((await call(app, "/api/v1/person/person_yves/page", child)).status).toBe(404);
    expect((await call(app, `/api/v1/person/${kid.id}/page`, child)).status).toBe(200);
    const people = (await call(app, "/api/v1/people", child)).json as People;
    expect(people.people.map((entry) => entry.person.title)).toEqual(["Example Kid"]);
  } finally {
    app.close();
  }
});

test("a graph from before gets the kind organisation once, and the kind is a row", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE entities (id TEXT, type TEXT, kind TEXT)");
  ensureKindTables(db);
  const has = () => Boolean(db.query("SELECT 1 FROM kinds WHERE type = 'person' AND kind = 'organisation'").get());
  expect(has()).toBe(true);
  // An older graph: the kinds exist, the new kind and its marker do not.
  db.query("DELETE FROM kinds WHERE kind = 'organisation'").run();
  db.query("DELETE FROM meta WHERE key = 'kinds_organisation'").run();
  ensureKindTables(db);
  expect(has()).toBe(true);
  const role = db.query("SELECT role FROM kinds WHERE type = 'person' AND kind = 'organisation'").get() as { role: string };
  expect(role.role).toBe("organisation");
  // The marker stays, so a second start adds nothing.
  db.query("DELETE FROM kinds WHERE kind = 'organisation'").run();
  ensureKindTables(db);
  expect(has()).toBe(false);
  db.close();
});
