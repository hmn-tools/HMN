import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp, type App } from "../src/app";
import { runWorker } from "../src/workers/run";
import { call, NOW, testApp } from "./helpers";

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

function emptyApp(dataDir = mkdtempSync(join(tmpdir(), "hmn-empty-")), kek = randomBytes(32)) {
  return { app: createApp({ dataDir, kek, now: () => NOW, timeZone: "Australia/Perth", seed: "empty" }), dataDir, kek };
}

async function make(app: App, type: string, body: Record<string, unknown>) {
  const reply = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(reply.status).toBe(201);
  return (reply.json as { id: string }).id;
}

async function sections(app: App, surface: string, key = app.secrets!.owner) {
  const today = await call(app, "/api/v1/screens/today", { key, surface });
  return today.json as { greeting: string; summary: string; sections: Array<{ id: string; label: string; items: Array<{ title: string; subtitle: string }> }> };
}

test("a first run can start empty, and it stays empty on the next start", async () => {
  const first = emptyApp();
  try {
    const count = (table: string) => (first.app.hmn.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("entities")).toBe(0);
    expect(count("links")).toBe(0);
    expect(count("proposals")).toBe(0);
    expect(count("credentials")).toBe(3);
    const today = await sections(first.app, "phone");
    expect(today.summary).toBe("The day is clear.");
    expect(today.sections).toEqual([]);
    // The demonstration's own kinds are not in an empty graph.
    const kinds = await call(first.app, "/api/v1/kinds", owner(first.app));
    const names = (kinds.json as { kinds: Array<{ type: string; kind: string }> }).kinds.map((row) => `${row.type}:${row.kind}`);
    for (const absent of ["person:spouse", "person:child", "area:side_project", "area:cars", "place:garage", "place:school", "asset:car"]) expect(names).not.toContain(absent);
    for (const present of ["person:self", "person:family", "event:family", "event:fixture", "area:other"]) expect(names).toContain(present);
  } finally {
    first.app.close();
  }
  // The second start finds no entity. It must not write the demonstration.
  const second = createApp({ dataDir: first.dataDir, kek: first.kek, now: () => NOW, timeZone: "Australia/Perth" });
  try {
    expect(second.secrets).toBeNull();
    expect((second.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities").get() as { n: number }).n).toBe(0);
  } finally {
    second.close();
  }
});

test("a new owner sets other areas and kinds, and the rules follow the roles", async () => {
  const { app } = emptyApp();
  try {
    const kind = (body: Record<string, unknown>) => call(app, "/api/v1/kinds", { method: "PUT", ...owner(app), body });
    // The owner's own words. None of them is in the code.
    expect((await kind({ type: "person", kind: "partner", title: "Partner", role: "family" })).status).toBe(200);
    expect((await kind({ type: "person", kind: "parent", role: "family" })).status).toBe(200);
    expect((await kind({ type: "area", kind: "household", title: "Household", role: "family" })).status).toBe(200);
    expect((await kind({ type: "area", kind: "wellbeing", title: "Wellbeing", role: "health" })).status).toBe(200);
    expect((await kind({ type: "area", kind: "studio", title: "Studio", role: "work" })).status).toBe(200);
    expect((await kind({ type: "area", kind: "club", title: "Club", role: "sport" })).status).toBe(200);
    expect((await kind({ type: "event", kind: "match", title: "Match", role: "fixture" })).status).toBe(200);
    expect((await kind({ type: "event", kind: "gathering", title: "Gathering", role: "family" })).status).toBe(200);

    // A kind that is not a row is refused. After it is added, it is accepted.
    const early = await call(app, "/api/v1/place", { method: "POST", ...owner(app), body: { title: "Example allotment", kind: "allotment" } });
    expect(early.status).toBe(422);
    expect((await kind({ type: "place", kind: "allotment" })).status).toBe(200);
    await make(app, "place", { title: "Example allotment", kind: "allotment" });

    const home = await make(app, "area", { title: "Our house", kind: "household", properties: { child_tier: "private" } });
    const body = await make(app, "area", { title: "Body", kind: "wellbeing", properties: { child_tier: "personal" } });
    const studio = await make(app, "area", { title: "Pottery", kind: "studio" });
    const club = await make(app, "area", { title: "Rowing club", kind: "club", properties: { child_tier: "public" } });
    await make(app, "person", { title: "Robin", kind: "self" });
    await make(app, "person", { title: "Sam", kind: "partner", area_id: home });

    // Today reads roles: the greeting, a family date of the owner's own kind, and a fixture of the owner's own kind.
    await make(app, "event", { title: "Example dinner", kind: "gathering", status: "upcoming", due_at: "2026-11-12", area_id: home });
    await make(app, "event", { title: "Example regatta", kind: "match", status: "upcoming", due_at: "2026-11-12T02:00:00.000Z", area_id: club, properties: { no_results: true } });
    const phone = await sections(app, "phone");
    expect(phone.greeting).toBe("Good afternoon, Robin.");
    expect(phone.sections.find((section) => section.id === "family")?.items.map((item) => item.title)).toEqual(["Example dinner"]);
    const watch = phone.sections.find((section) => section.id === "watch")!;
    expect(watch.items[0]).toMatchObject({ title: "Example regatta" });
    expect(watch.items[0]!.subtitle).not.toContain("no results");
    // The shared display gets the fixture and not the family date.
    const display = await call(app, "/api/display/today.html", { key: app.secrets!.display });
    expect(display.text).toContain("Example regatta");
    expect(display.text).not.toContain("Example dinner");

    // The no-results rule follows the role, for a kind that the code does not know.
    const spoiled = await call(app, "/api/v1/event", { method: "POST", ...owner(app), body: { title: "Example final", kind: "match", status: "upcoming", due_at: "2026-11-20T02:00:00.000Z", area_id: club, properties: { score: "3-1" } } });
    expect(spoiled.status).toBe(422);
    expect((spoiled.json as { error: { code: string } }).error.code).toBe("no_scores");

    // The agent key cannot read the owner's health area, by its role. The area's tier alone does not hide it.
    await make(app, "note", { title: "Example sleep note", status: "open", area_id: body });
    await make(app, "task", { title: "Fire the kiln", status: "open", kind: "task", area_id: studio });
    const agent = { key: app.secrets!.agent, surface: "mcp" };
    expect((await call(app, "/api/v1/search?q=sleep", owner(app))).text).toContain("Example sleep note");
    expect((await call(app, "/api/v1/search?q=sleep", agent)).text).not.toContain("Example sleep note");
    expect((await call(app, `/api/v1/area/${body}`, agent)).status).toBe(404);
    expect((await call(app, "/api/v1/search?q=kiln", agent)).text).toContain("Fire the kiln");

    // The work screen takes its label from the owner's area.
    const work = await call(app, "/api/v1/screens/commitments", owner(app));
    expect((work.json as { summary: string; sections: Array<{ label: string }> }).sections[0]!.label).toBe("Pottery");
    expect((work.json as { summary: string }).summary).toBe("One open task in Pottery.");

    // A calendar event with the partner goes to the owner's family area, and it is Private there.
    const calendar = await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Example calendar", area_id: studio } });
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:k-1", "SUMMARY:Example anniversary", "DTSTART;VALUE=DATE:20261113", "ATTENDEE;CN=Sam:mailto:sam@example.test", "END:VEVENT", "BEGIN:VEVENT", "UID:k-2", "SUMMARY:Example glaze order", "DTSTART;VALUE=DATE:20261111", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const tick = await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { source_id: (calendar.json as { id: string }).id, ics } });
    expect(tick.status).toBe(200);
    const row = (id: string) => app.hmn.store.db.query("SELECT area_id, tier, kind FROM entities WHERE external_id = ?").get(id) as { area_id: string | null; tier: string | null; kind: string };
    // An approval stores the tier of the proposal. The family area is Private, and the studio area is Personal.
    expect(row("k-1")).toEqual({ area_id: home, tier: "private", kind: "family" });
    expect(row("k-2")).toEqual({ area_id: studio, tier: "personal", kind: "appointment" });
    expect((await call(app, "/api/v1/search?q=anniversary", { key: app.secrets!.owner, surface: "widget" })).text).not.toContain("Example anniversary");

    // The Fixtures worker files its note in the owner's sport area, and the People worker skips the owner.
    await call(app, `/api/v1/person/${(app.hmn.store.db.query("SELECT id FROM entities WHERE title = 'Robin'").get() as { id: string }).id}`, { method: "PATCH", ...owner(app), body: { properties: { birthday: "11-15" } } });
    const fixtures = await runWorker(app.hmn, "fixtures");
    const note = app.hmn.store.db.query("SELECT payload FROM proposals WHERE id = ?").get(fixtures.proposals[0]!.id) as { payload: string };
    expect(JSON.parse(note.payload).entity.area_id).toBe(club);
    expect(note.payload).toContain("Example regatta");
    expect((await runWorker(app.hmn, "people")).proposals).toEqual([]);
  } finally {
    app.close();
  }
});

test("with no area for the family role, a family date is still Private", async () => {
  const { app } = emptyApp();
  try {
    await make(app, "person", { title: "Sam", kind: "family" });
    const calendar = await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Example calendar", event_tier: "public" } });
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:n-1", "SUMMARY:Example family lunch", "DTSTART;VALUE=DATE:20261113", "ATTENDEE;CN=Sam:mailto:sam@example.test", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { source_id: (calendar.json as { id: string }).id, ics } });
    const lunch = app.hmn.store.db.query("SELECT area_id, tier FROM entities WHERE external_id = 'n-1'").get() as { area_id: string | null; tier: string };
    expect(lunch).toEqual({ area_id: null, tier: "private" });
  } finally {
    app.close();
  }
});

test("a kind can get a new title, a built-in kind stays, and a kind in use is not removed", async () => {
  const app = testApp();
  try {
    const kind = (body: Record<string, unknown>) => call(app, "/api/v1/kinds", { method: "PUT", ...owner(app), body });
    const listed = (await call(app, "/api/v1/kinds", owner(app))).json as { kinds: Array<{ type: string; kind: string; title: string; role: string | null; core: boolean; in_use: number }>; roles: Record<string, string[]> };
    // The demonstration keeps its kinds, and they have roles.
    expect(listed.kinds.find((row) => row.type === "person" && row.kind === "child")).toMatchObject({ role: "family", core: false });
    expect(listed.kinds.find((row) => row.type === "area" && row.kind === "side_project")).toMatchObject({ role: "work" });
    expect(listed.kinds.find((row) => row.type === "person" && row.kind === "child")!.in_use).toBeGreaterThan(0);
    expect(listed.roles.event).toEqual(["family", "fixture"]);

    expect((await kind({ type: "person", kind: "child", title: "Kid" })).json).toMatchObject({ title: "Kid", role: "family" });
    expect((await kind({ type: "event", kind: "fixture", title: "Game" })).json).toMatchObject({ title: "Game", role: "fixture", core: true });
    expect((await kind({ type: "event", kind: "fixture", role: null })).status).toBe(409);
    expect((await kind({ type: "person", kind: "Friend" })).status).toBe(422);
    expect((await kind({ type: "person", kind: "friend", role: "fixture" })).status).toBe(422);
    expect((await kind({ type: "task", kind: "chore" })).status).toBe(422);
    expect((await kind({ type: "person", kind: "friend" })).status).toBe(200);

    expect((await call(app, "/api/v1/kinds/person/child", { method: "DELETE", ...owner(app) })).status).toBe(409);
    expect((await call(app, "/api/v1/kinds/person/self", { method: "DELETE", ...owner(app) })).status).toBe(409);
    expect((await call(app, "/api/v1/kinds/person/friend", { method: "DELETE", ...owner(app) })).status).toBe(200);
    expect((await call(app, "/api/v1/kinds/person/friend", { method: "DELETE", ...owner(app) })).status).toBe(404);

    // An agent key and the display cannot read or change the kinds.
    expect((await call(app, "/api/v1/kinds", { key: app.secrets!.agent, surface: "mcp" })).status).toBe(403);
    expect((await call(app, "/api/v1/kinds", { method: "PUT", key: app.secrets!.agent, surface: "mcp", body: { type: "person", kind: "spy", role: "self" } })).status).toBe(403);
    expect((await call(app, "/api/v1/kinds", { key: app.secrets!.display })).status).toBe(403);
  } finally {
    app.close();
  }
});

test("the rules name no kind of one life, and the copy names no gender", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".ts")) files.push(join(dir, entry.name));
    }
  };
  walk(root);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const name = file.slice(root.length);
    // The demonstration and the list of its kinds are the two places for these words.
    if (name !== "seed.ts" && name !== "kinds.ts") {
      expect({ name, found: text.match(/"(spouse|child|garage|side_project|school|area_(work|side|family|home|health|money|sport|cars))"/)?.[0] ?? null }).toEqual({ name, found: null });
    }
    // Text for the owner does not say he or she.
    const strings = text.match(/"[^"\n]*"|`[^`]*`/g) ?? [];
    for (const literal of strings) {
      expect({ name, found: literal.match(/\b(he|she|his|her|him|himself|herself)\b/i)?.[0] ?? null, literal: literal.slice(0, 60) }).toMatchObject({ found: null });
    }
  }
});

test("a new area with no tier for its items gets the tier of its role", async () => {
  const { app } = emptyApp();
  try {
    const kind = (body: Record<string, unknown>) => call(app, "/api/v1/kinds", { method: "PUT", ...owner(app), body });
    await kind({ type: "area", kind: "wellbeing", title: "Wellbeing", role: "health" });
    await kind({ type: "area", kind: "savings", title: "Savings", role: "money" });
    await kind({ type: "area", kind: "household", title: "Household", role: "family" });
    await kind({ type: "area", kind: "studio", title: "Studio", role: "work" });
    const area = async (body: Record<string, unknown>) => {
      const reply = await call(app, "/api/v1/area", { method: "POST", ...owner(app), body });
      expect(reply.status).toBe(201);
      return (reply.json as { id: string; properties: { child_tier: string } }).properties.child_tier;
    };
    // A health area is not Personal because the caller left a field out.
    expect(await area({ title: "Example wellbeing", kind: "wellbeing" })).toBe("sealed");
    expect(await area({ title: "Example savings", kind: "savings" })).toBe("sealed");
    expect(await area({ title: "Example household", kind: "household" })).toBe("private");
    expect(await area({ title: "Example studio", kind: "studio" })).toBe("personal");
    expect(await area({ title: "Example other", kind: "other" })).toBe("personal");
    // The owner's own choice stays.
    expect(await area({ title: "Example open wellbeing", kind: "wellbeing", properties: { child_tier: "private" } })).toBe("private");
  } finally {
    app.close();
  }
});
