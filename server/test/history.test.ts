import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

function walk(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) text += walk(path);
    else text += readFileSync(path, "utf8");
  }
  return text;
}

test("an edit supersedes the previous version and a purge is the only hard delete", async () => {
  const created = await call(app, "/api/v1/task", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { title: "Alpha note", status: "open", kind: "task", area_id: "area_work" },
  });
  expect(created.status).toBe(201);
  const id = (created.json as { id: string }).id;
  const edited = await call(app, `/api/v1/task/${id}`, {
    method: "PATCH",
    key: app.secrets!.owner,
    surface: "phone",
    body: { title: "Beta note" },
  });
  expect((edited.json as { title: string }).title).toBe("Beta note");
  const history = await call(app, `/api/v1/task/${id}/history`, { key: app.secrets!.owner, surface: "phone" });
  expect(history.status).toBe(200);
  const versions = (history.json as { versions: Array<{ id: string; title?: string; supersedes_id: string | null; tombstone: boolean }> }).versions;
  expect(versions).toHaveLength(2);
  expect(versions[0]?.title).toBe("Alpha note");
  expect(versions[1]?.title).toBe("Beta note");
  expect(versions[1]?.supersedes_id).toBe(versions[0]?.id);
  const stored = app.store.db.query("SELECT title FROM entity_versions WHERE id = ?").get(versions[0]!.id) as { title: string };
  expect(stored.title).toBe("Alpha note");
  const removed = await call(app, `/api/v1/task/${id}`, { method: "DELETE", key: app.secrets!.owner, surface: "phone" });
  expect(removed.status).toBe(200);
  const gone = await call(app, `/api/v1/task/${id}`, { key: app.secrets!.owner, surface: "phone" });
  expect(gone.status).toBe(404);
  const after = await call(app, `/api/v1/task/${id}/history`, { key: app.secrets!.owner, surface: "phone" });
  const tombstones = (after.json as { versions: Array<{ tombstone: boolean }> }).versions;
  expect(tombstones.some((version) => version.tombstone)).toBe(true);
  const still = app.store.db.query("SELECT title FROM entity_versions WHERE id = ?").get(versions[0]!.id) as { title: string };
  expect(still.title).toBe("Alpha note");
  const purged = await call(app, `/api/v1/task/${id}/purge`, { method: "POST", key: app.secrets!.owner, surface: "phone" });
  expect(purged.status).toBe(200);
  const left = app.store.db.query("SELECT COUNT(*) AS n FROM entity_versions WHERE entity_id = ?").get(id) as { n: number };
  expect(left.n).toBe(0);
  expect(app.store.db.query("SELECT id FROM entities WHERE id = ?").get(id)).toBeNull();
  const audit = await call(app, "/api/v1/audit", { key: app.secrets!.owner, surface: "phone" });
  expect(audit.text).toContain("purge");
  expect(audit.text).not.toContain("Alpha note");
  expect(audit.text).not.toContain("Beta note");
  const verify = await call(app, "/api/v1/audit/verify", { key: app.secrets!.owner, surface: "phone" });
  expect(verify.status).toBe(200);
});

test("the plain-file mirror is incremental and hides private and sealed content", async () => {
  const root = join(app.store.dataDir, "mirror");
  const all = walk(root);
  expect(all).toContain("Lakeside Grand Prix");
  expect(all).toContain("Send weekly notes");
  for (const secret of ["Yves", "Luca", "Sam", "passport", "Example clinic note", "Book Luca"]) {
    expect(all.includes(secret), secret).toBe(false);
  }
  const stub = readFileSync(join(root, "entities", "person", "person_yves.md"), "utf8");
  expect(stub).toContain("id: person_yves");
  expect(stub).toContain("tier: private");
  expect(stub).not.toContain("title:");
  const race = join(root, "entities", "event", "event_race.md");
  const before = statSync(race).mtimeMs;
  const made = await call(app, "/api/v1/task", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { title: "Visible cereal", status: "open", kind: "task", area_id: "area_work" },
  });
  const cereal = (made.json as { id: string }).id;
  expect(statSync(race).mtimeMs).toBe(before);
  expect(readFileSync(join(root, "entities", "task", `${cereal}.md`), "utf8")).toContain("Visible cereal");
  const raised = await call(app, `/api/v1/task/${cereal}`, {
    method: "PATCH",
    key: app.secrets!.owner,
    surface: "phone",
    body: { tier: "private" },
  });
  expect((raised.json as { tier: string }).tier).toBe("private");
  const hidden = walk(join(root, "entities", "task")) + walk(join(root, "timelines"));
  expect(hidden).not.toContain("Visible cereal");
  expect(readFileSync(join(root, "entities", "task", `${cereal}.md`), "utf8")).toContain("tier: private");
  const widget = await call(app, `/api/v1/person/person_yves/history`, { key: app.secrets!.owner, surface: "widget" });
  expect(widget.status).toBe(404);
  expect(widget.text).not.toContain("Yves");
});

test("Send to HMN lands in the inbox and cannot drop below Personal", async () => {
  const before = await call(app, "/api/v1/task", { key: app.secrets!.owner, surface: "phone" });
  const lowered = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Buy oat milk #public", source: "shortcut", tier: "public" },
  });
  expect(lowered.status).toBe(201);
  expect((lowered.json as { tier: string; source: string }).tier).toBe("personal");
  expect((lowered.json as { source: string }).source).toBe("shortcut");
  const display = await call(app, "/api/v1/inbox", { key: app.secrets!.display, surface: "display" });
  expect(display.text).not.toContain("Buy oat milk");
  const raised = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Call the school office", source: "shortcut", tag: "todo", tier: "private" },
  });
  expect((raised.json as { tier: string; tags: string[] }).tier).toBe("private");
  expect((raised.json as { tags: string[] }).tags).toContain("todo");
  const widget = await call(app, "/api/v1/inbox", { key: app.secrets!.owner, surface: "widget" });
  expect(widget.text).not.toContain("school office");
  const dumped = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { source: "shortcut", url: "https://example.com/bins", json: { from: "reminders", title: "Take the bins out" } },
  });
  expect(dumped.status).toBe(201);
  expect((dumped.json as { tier: string; url: string; body: string }).tier).toBe("personal");
  expect((dumped.json as { url: string }).url).toBe("https://example.com/bins");
  expect((dumped.json as { body: string }).body).toContain("Take the bins out");
  expect((dumped.json as { body: string }).body).toContain("reminders");
  const after = await call(app, "/api/v1/task", { key: app.secrets!.owner, surface: "phone" });
  expect((after.json as { entities: unknown[] }).entities.length).toBe((before.json as { entities: unknown[] }).entities.length);
});

test("a rewritten version breaks the audit chain", async () => {
  app.store.db.query("UPDATE entity_versions SET title = 'tampered title' WHERE entity_id = 'task_notes'").run();
  const broken = await call(app, "/api/v1/audit/verify", { key: app.secrets!.owner, surface: "phone" });
  expect(broken.status).toBe(409);
});
