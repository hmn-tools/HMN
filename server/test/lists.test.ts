// Lists and shared family tasks: a list is a project of the kind `list`, an item is a task of the kind `item`,
// part of its list. A step is an item that is part of a task. The record keeps who completed a task, and when.
// docs/ONTOLOGY.md, sections 2.4 and 2.5. All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

type View = { id: string; title: string; status: string; kind: string; tier: string; properties: Record<string, unknown> };

async function make(app: App, type: string, body: Record<string, unknown>) {
  const made = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(made.status).toBe(201);
  return made.json as View;
}

async function add(app: App, parentId: string, title: string) {
  const made = await call(app, "/api/v1/items", { method: "POST", ...owner(app), body: { parent_id: parentId, title } });
  expect(made.status).toBe(201);
  return made.json as View;
}

async function patch(app: App, id: string, body: Record<string, unknown>) {
  const changed = await call(app, `/api/v1/task/${id}`, { method: "PATCH", ...owner(app), body });
  expect(changed.status).toBe(200);
  return changed.json as View;
}

test("a list keeps its items: open first, then done, and Again brings one back", async () => {
  const app = testApp();
  try {
    const list = await make(app, "project", { title: "Example groceries", kind: "list", status: "active", tier: "household" });
    const milk = await add(app, list.id, "Example milk");
    const eggs = await add(app, list.id, "Example eggs");
    // An item takes the tier of its list.
    expect(milk).toMatchObject({ kind: "item", status: "open", tier: "household" });

    const ticked = await patch(app, milk.id, { status: "done" });
    expect(ticked.properties).toMatchObject({ done_by: "owner" });
    expect(typeof ticked.properties.done_at).toBe("string");

    const lists = (await call(app, "/api/v1/lists", owner(app))).json as { lists: Array<{ list: View; open: number; items: View[] }> };
    const groceries = lists.lists.find((entry) => entry.list.id === list.id)!;
    expect(groceries.open).toBe(1);
    expect(groceries.items.map((item) => item.id)).toEqual([eggs.id, milk.id]);

    // Again: the item opens, and the record of who completed it goes.
    const again = await patch(app, milk.id, { status: "open" });
    expect(again.properties.done_by).toBeUndefined();
    expect(again.properties.done_at).toBeUndefined();

    // An item is not a task of the day: it is not in the list of tasks, on Today, or in the review.
    const tasks = (await call(app, "/api/v1/task", owner(app))).json as View[] | { items?: View[] };
    expect(JSON.stringify(tasks)).not.toContain("Example milk");
    await patch(app, eggs.id, { status: "done" });
    for (const screen of ["today", "week", "quiet"]) {
      const read = await call(app, `/api/v1/screens/${screen}`, owner(app));
      expect(read.status).toBe(200);
      expect(JSON.stringify(read.json)).not.toContain("Example eggs");
      expect(JSON.stringify(read.json)).not.toContain("Example milk");
    }
  } finally {
    app.close();
  }
});

test("the server writes who completed a task, and a client cannot write another name", async () => {
  const app = testApp();
  try {
    const task = await make(app, "task", { title: "Example renew a passport", kind: "task", status: "open", tier: "household" });
    const done = await patch(app, task.id, { status: "done", properties: { done_by: "Example Sam", done_at: "2020-01-01T00:00:00.000Z" } });
    expect(done.properties.done_by).toBe("owner");
    expect(done.properties.done_at).not.toBe("2020-01-01T00:00:00.000Z");
    // A later change to a done task keeps the record.
    const renamed = await patch(app, task.id, { title: "Example renew the passport", properties: {} });
    expect(renamed.properties).toMatchObject({ done_by: "owner", done_at: done.properties.done_at });
  } finally {
    app.close();
  }
});

test("a family task is for several people, and its steps are items of the task", async () => {
  const app = testApp();
  try {
    const sam = await make(app, "person", { title: "Example Sam", kind: "family", tier: "household" });
    const alex = await make(app, "person", { title: "Example Alex", kind: "family", tier: "household" });
    const task = await make(app, "task", { title: "Example renew a passport", kind: "task", status: "open", tier: "household" });
    for (const person of [sam, alex]) {
      const link = await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_type: "task", from_id: task.id, to_type: "person", to_id: person.id, rel: "for" } });
      expect(link.status).toBe(201);
    }
    const photo = await add(app, task.id, "Example photo");
    await add(app, task.id, "Example form");
    await patch(app, photo.id, { status: "done" });

    const steps = (await call(app, `/api/v1/items?parent_id=${task.id}`, owner(app))).json as { parent: View; items: View[] };
    expect(steps.parent.id).toBe(task.id);
    expect(steps.items.map((item) => [item.title, item.status])).toEqual([
      ["Example form", "open"],
      ["Example photo", "done"],
    ]);
    // A step does not close its task.
    expect(((await call(app, `/api/v1/task/${task.id}`, owner(app))).json as View).status).toBe("open");
    // The task is still on the list of tasks. Its steps are not.
    const tasks = JSON.stringify((await call(app, "/api/v1/task", owner(app))).json);
    expect(tasks).toContain("Example renew a passport");
    expect(tasks).not.toContain("Example photo");

    // An item holds no items, and a note is not a list.
    expect((await call(app, "/api/v1/items", { method: "POST", ...owner(app), body: { parent_id: photo.id, title: "Example nested" } })).status).toBe(404);
    const note = await make(app, "note", { title: "Example note", body: "Fictional text." });
    expect((await call(app, "/api/v1/items", { method: "POST", ...owner(app), body: { parent_id: note.id, title: "Example" } })).status).toBe(404);
  } finally {
    app.close();
  }
});

test("a reader below the tier of a list sees neither the list nor its items", async () => {
  const app = testApp();
  try {
    const gifts = await make(app, "project", { title: "Example gifts for Sam", kind: "list", status: "active", tier: "private" });
    const item = await add(app, gifts.id, "Example book");
    expect(item.tier).toBe("private");
    const view = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "fridge", scope: "read", ceiling: "household" } });
    expect(view.status).toBe(201);
    const token = (view.json as { token: string }).token;
    const read = await call(app, "/api/v1/lists", { key: token, surface: "api" });
    expect(read.status).toBe(200);
    const lists = JSON.stringify(read.json);
    expect(lists).not.toContain("Example gifts");
    expect(lists).not.toContain("Example book");
    expect((await call(app, `/api/v1/items?parent_id=${gifts.id}`, { key: token, surface: "api" })).status).toBe(404);
    // A key that reads cannot add an item.
    expect((await call(app, "/api/v1/items", { method: "POST", key: token, surface: "api", body: { parent_id: gifts.id, title: "Example" } })).status).toBe(403);
  } finally {
    app.close();
  }
});
