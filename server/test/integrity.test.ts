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
