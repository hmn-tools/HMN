// Writes that keep the record whole: an area with items stays, filed text is not lost, a capture becomes what the
// owner says in one tap, and a date that HMN cannot read is refused. All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

async function capture(app: App, text: string) {
  const made = await call(app, "/api/v1/inbox", { method: "POST", ...owner(app), body: { text, tier: "personal" } });
  expect(made.status).toBe(201);
  return (made.json as { id: string }).id;
}

test("an area with items cannot be removed, so its items keep their tier", async () => {
  const app = testApp();
  try {
    const refused = await call(app, "/api/v1/area/area_health", { method: "DELETE", ...owner(app) });
    expect(refused.status).toBe(409);
    expect(refused.text).toContain("Move or remove");
    // An empty area can go.
    const empty = await call(app, "/api/v1/area", { method: "POST", ...owner(app), body: { title: "Example empty area", kind: "other" } });
    expect((await call(app, `/api/v1/area/${(empty.json as { id: string }).id}`, { method: "DELETE", ...owner(app) })).status).toBe(200);
  } finally {
    app.close();
  }
});

test("filing a capture to a record keeps its text as a note about that record", async () => {
  const app = testApp();
  try {
    const id = await capture(app, "Example: likes lemon cake for birthdays");
    const filed = await call(app, `/api/v1/inbox/${id}/process`, { method: "POST", ...owner(app), body: { action: "file", entity_id: "person_sam" } });
    expect(filed.status).toBe(200);
    const page = (await call(app, "/api/v1/person/person_sam/page", owner(app))).json as { notes: Array<{ entity: { title: string; body: string } }> };
    expect(page.notes.map((row) => row.entity.title)).toContain("Example: likes lemon cake for birthdays");
  } finally {
    app.close();
  }
});

test("a capture becomes a task, a note, or a person in one step, with no tag", async () => {
  const app = testApp();
  try {
    const asNote = await capture(app, "Example idea for the garden");
    const note = await call(app, `/api/v1/inbox/${asNote}/process`, { method: "POST", ...owner(app), body: { action: "accept", route: "note" } });
    expect(note.status).toBe(200);
    const notes = (await call(app, "/api/v1/note", owner(app))).json as { entities: Array<{ title: string }> };
    expect(notes.entities.map((row) => row.title)).toContain("Example idea for the garden");

    const asTask = await capture(app, "Example call the plumber");
    expect((await call(app, `/api/v1/inbox/${asTask}/process`, { method: "POST", ...owner(app), body: { action: "accept", route: "task" } })).status).toBe(200);
    const tasks = (await call(app, "/api/v1/task", owner(app))).json as { entities: Array<{ title: string }> };
    expect(tasks.entities.map((row) => row.title)).toContain("Example call the plumber");

    const odd = await capture(app, "Example something");
    expect((await call(app, `/api/v1/inbox/${odd}/process`, { method: "POST", ...owner(app), body: { action: "accept", route: "spaceship" } })).status).toBe(422);
  } finally {
    app.close();
  }
});

test("a date that HMN cannot read is refused, and an empty one is no date", async () => {
  const app = testApp();
  try {
    const bad = await call(app, "/api/v1/task/task_notes", { method: "PATCH", ...owner(app), body: { due_at: "next friday" } });
    expect(bad.status).toBe(422);
    expect(bad.text).toContain("2026-12-01");
    expect((await call(app, "/api/v1/screens/today", owner(app))).status).toBe(200);
    const cleared = await call(app, "/api/v1/task/task_notes", { method: "PATCH", ...owner(app), body: { due_at: "" } });
    expect(cleared.status).toBe(200);
    expect((cleared.json as { due_at: string | null }).due_at).toBeNull();
  } finally {
    app.close();
  }
});

test("editing a proposed change edits its change, and a bad date is refused there too", async () => {
  const app = testApp();
  try {
    const proposed = await call(app, "/api/v1/proposals", { method: "POST", key: app.secrets!.agent, surface: "mcp", body: { op: "update", id: "task_notes", patch: { due_at: "2026-11-20" }, reason: "A test." } });
    expect(proposed.status).toBe(201);
    const id = (proposed.json as { id: string }).id;
    expect((await call(app, `/api/v1/proposals/${id}`, { method: "PATCH", ...owner(app), body: { due_at: "soon" } })).status).toBe(422);
    const edited = await call(app, `/api/v1/proposals/${id}`, { method: "PATCH", ...owner(app), body: { due_at: "2026-11-25" } });
    expect(edited.status).toBe(200);
    expect((edited.json as { payload: { patch: { due_at: string }; entity?: unknown } }).payload.patch.due_at).toBe("2026-11-25");
  } finally {
    app.close();
  }
});

test("an archived row leaves lists and search, and it stays readable", async () => {
  const app = testApp();
  try {
    const made = await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example old boiler manual", status: "open", kind: "reference" } });
    const id = (made.json as { id: string }).id;
    expect((await call(app, `/api/v1/note/${id}`, { method: "PATCH", ...owner(app), body: { status: "archived" } })).status).toBe(200);
    const titles = async (path: string) => ((await call(app, path, owner(app))).json as { entities?: Array<{ title: string }>; results?: Array<{ title: string }> });
    expect((await titles("/api/v1/note")).entities!.map((row) => row.title)).not.toContain("Example old boiler manual");
    expect((await titles("/api/v1/note?archived=1")).entities!.map((row) => row.title)).toContain("Example old boiler manual");
    expect((await titles("/api/v1/search?q=boiler")).results!.map((row) => row.title)).not.toContain("Example old boiler manual");
    expect((await call(app, `/api/v1/note/${id}`, owner(app))).status).toBe(200);
    // A person can be archived too, and leaves People.
    expect((await call(app, "/api/v1/person/person_sam", { method: "PATCH", ...owner(app), body: { status: "archived" } })).status).toBe(200);
    const people = (await call(app, "/api/v1/people", owner(app))).json as { people: Array<{ person: { id: string } }> };
    expect(people.people.map((row) => row.person.id)).not.toContain("person_sam");
  } finally {
    app.close();
  }
});

test("the schema names the statuses, the note kinds, the relations, and the fields", async () => {
  const app = testApp();
  try {
    const schema = (await call(app, "/api/v1/schema", owner(app))).json as {
      statuses: Record<string, string[]>;
      kinds: Array<{ type: string; kind: string; title: string }>;
      relations: Array<{ rel: string; out: string }>;
      fields: Record<string, Array<{ key: string; type: string }>>;
    };
    expect(schema.statuses.event).toEqual(["upcoming", "past", "cancelled"]);
    expect(schema.statuses.note).toContain("archived");
    expect(schema.kinds.filter((row) => row.type === "note").map((row) => row.kind)).toEqual(expect.arrayContaining(["note", "reference", "decision", "fact", "reading", "review", "capture"]));
    expect(schema.relations.find((row) => row.rel === "for")?.out).toBe("For");
    expect(schema.fields.person!.map((field) => field.key)).toContain("birthday");
  } finally {
    app.close();
  }
});

test("a field change keeps the other properties", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/person/person_sam", { method: "PATCH", ...owner(app), body: { properties_patch: { birthday: "1990-04-02", secret_handshake: "kept" } } });
    const changed = await call(app, "/api/v1/person/person_sam", { method: "PATCH", ...owner(app), body: { properties_patch: { nickname: "Example Sammy", secret_handshake: null } } });
    expect(changed.status).toBe(200);
    expect((changed.json as { properties: Record<string, unknown> }).properties).toMatchObject({ birthday: "1990-04-02", nickname: "Example Sammy" });
    expect((changed.json as { properties: Record<string, unknown> }).properties.secret_handshake).toBeUndefined();
  } finally {
    app.close();
  }
});

test("a link must have a known relation, join two rows, and is not made twice", async () => {
  const app = testApp();
  try {
    const link = (rel: string, from = "task_notes", to = "person_sam") =>
      call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_type: "task", from_id: from, to_type: "person", to_id: to, rel } });
    expect((await link("banana")).status).toBe(422);
    expect((await link("about", "task_notes", "task_notes")).status).toBe(422);
    const first = await link("for");
    const second = await link("for");
    expect(first.status).toBe(201);
    expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
  } finally {
    app.close();
  }
});
