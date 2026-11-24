import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp, type App } from "../src/app";
import { call, testApp } from "./helpers";

type Result = { external_id: string | null; type: string | null; status: string; error?: string; proposal_id?: string };
type Reply = { source: string; source_id: string | null; counts: Record<string, number>; next: string | null; results: Result[] };

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

async function run(app: App, records: unknown[], extra: Record<string, unknown> = {}) {
  const reply = await call(app, "/api/v1/import", { method: "POST", ...owner(app), body: { source: "notion", title: "Example Notion", records, ...extra } });
  expect(reply.status).toBe(200);
  return reply.json as Reply;
}

/** Approve every pending proposal of the import with one decision. */
async function approveAll(app: App) {
  const listed = await call(app, "/api/v1/proposals?status=pending&source=import:notion", owner(app));
  const ids = (listed.json as { proposals: Array<{ id: string }> }).proposals.map((item) => item.id);
  if (ids.length === 0) return 0;
  const batch = await call(app, "/api/v1/proposals/batch", { method: "POST", ...owner(app), body: { decision: "approve", source: "import:notion", ids } });
  expect(batch.json).toMatchObject({ decided: ids.length, failed: 0 });
  return ids.length;
}

function entity(app: App, externalId: string) {
  return app.hmn.store.db.query("SELECT id, type, title, status, kind, area_id, tier, origin, origin_ref, source_id, deleted_at FROM entities WHERE external_id = ? AND deleted_at IS NULL").get(externalId) as {
    id: string;
    type: string;
    title: string;
    status: string | null;
    kind: string | null;
    area_id: string | null;
    tier: string | null;
    origin: string;
    origin_ref: string | null;
    source_id: string | null;
    deleted_at: string | null;
  } | null;
}

// Fictional records, in the order a person would not sort them: a task first, its area last.
const RECORDS = [
  { external_id: "page-task-1", type: "task", title: "Example imported task", due_at: "2026-11-20", area: "page-area-1", links: [{ rel: "about", to: "page-project-1" }] },
  { external_id: "page-note-1", type: "note", title: "Example imported note", body: "A fictional note.", area: "Work" },
  { external_id: "page-family-1", type: "task", title: "Example family errand", area: "Family", links: [{ rel: "about", to: "page-person-1" }] },
  { external_id: "page-project-1", type: "project", title: "Example imported project", area: "page-area-1", links: [{ rel: "serves", to: "page-goal-1" }] },
  { external_id: "page-goal-1", type: "goal", title: "Example imported goal", area: "Example garden" },
  { external_id: "page-person-1", type: "person", title: "Example Person", kind: "family", area: "Family" },
  { external_id: "page-area-1", type: "area", title: "Example garden", kind: "home" },
];

test("an import becomes proposals in passes, a batch approves each pass, and a second import makes no copy", async () => {
  const app = testApp();
  try {
    // A dry run writes nothing.
    const dry = await run(app, RECORDS, { dry_run: true });
    expect(dry.source_id).toBeNull();
    expect(dry.counts).toEqual({ would_propose: 3, waiting: 4 });
    expect((app.hmn.store.db.query("SELECT COUNT(*) AS n FROM proposals WHERE source = 'import:notion'").get() as { n: number }).n).toBe(0);

    // Pass 1: the area, the person in an area that exists, and the note. The others wait for a target.
    const first = await run(app, RECORDS);
    expect(first.source).toBe("import:notion");
    expect(first.counts).toEqual({ proposed: 3, waiting: 4 });
    expect(first.next).toContain("run the same import again");
    const status = (reply: Reply) => Object.fromEntries(reply.results.map((item) => [item.external_id, item.error ? `${item.status}:${item.error}` : item.status]));
    expect(status(first)).toEqual({
      "page-area-1": "proposed",
      "page-person-1": "proposed",
      "page-note-1": "proposed",
      "page-goal-1": "waiting:area",
      "page-project-1": "waiting:area",
      "page-task-1": "waiting:area",
      "page-family-1": "waiting:links",
    });
    expect(entity(app, "page-area-1")).toBeNull();
    // Nothing is auto-accepted from an import, also with a rule that asks for it.
    expect((await call(app, "/api/v1/policy", { method: "PUT", ...owner(app), body: { source: "import:notion", mode: "auto" } })).status).toBe(422);

    // The same import before a decision: no second proposal.
    expect((await run(app, RECORDS)).counts).toEqual({ pending: 3, waiting: 4 });
    expect(await approveAll(app)).toBe(3);

    // Pass 2 and pass 3 follow the links.
    const second = await run(app, RECORDS);
    expect(second.counts).toEqual({ exists: 3, proposed: 2, waiting: 2 });
    expect(await approveAll(app)).toBe(2);
    const third = await run(app, RECORDS);
    expect(third.counts).toEqual({ exists: 5, proposed: 1, waiting: 1 });
    expect(await approveAll(app)).toBe(1);
    const fourth = await run(app, RECORDS);
    expect(fourth.counts).toEqual({ exists: 6, proposed: 1 });
    expect(fourth.next).toBeNull();
    expect(await approveAll(app)).toBe(1);
    expect((await run(app, RECORDS)).counts).toEqual({ exists: 7 });

    // What landed.
    const area = entity(app, "page-area-1")!;
    const task = entity(app, "page-task-1")!;
    const project = entity(app, "page-project-1")!;
    expect(area).toMatchObject({ type: "area", kind: "home", origin: "import", origin_ref: "notion", source_id: first.source_id });
    expect(task).toMatchObject({ status: "open", kind: "task", area_id: area.id, origin: "import" });
    expect(entity(app, "page-note-1")).toMatchObject({ area_id: "area_work", status: "open" });
    const link = app.hmn.store.db.query("SELECT rel, to_id FROM links WHERE from_id = ? AND deleted_at IS NULL").get(task.id) as { rel: string; to_id: string };
    expect(link).toEqual({ rel: "about", to_id: project.id });
    const source = await call(app, `/api/v1/source/${first.source_id}`, owner(app));
    expect(source.json).toMatchObject({ title: "Example Notion", kind: "notion" });

    // The family errand is Private from the first moment. A Personal reader never gets it.
    const errand = entity(app, "page-family-1")!;
    expect(errand.area_id).toBe("area_family");
    const widget = await call(app, "/api/v1/search?q=family%20errand", { key: app.secrets!.owner, surface: "widget" });
    expect(widget.text).not.toContain("Example family errand");
    const agent = await call(app, "/api/v1/proposals?status=all", { key: app.secrets!.agent, surface: "mcp" });
    expect(agent.text).not.toContain("Example family errand");
  } finally {
    app.close();
  }
}, 60_000);

test("a declined or removed record stays away for 90 days", async () => {
  const clock = { now: new Date("2026-11-11T04:39:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-import-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  try {
    const records = [
      { external_id: "keep", type: "note", title: "Example note to keep" },
      { external_id: "decline", type: "note", title: "Example note to decline" },
    ];
    // The test key expires before 90 days pass, so this test uses one access object and calls the server class.
    const access = app.hmn.accessFor(app.secrets!.owner, "127.0.0.1", "phone", null);
    const direct = (list: unknown[]) => app.hmn.importRecords(access, { source: "notion", records: list }) as Reply;
    const first = direct(records);
    const declined = first.results.find((item) => item.external_id === "decline")!;
    const kept = first.results.find((item) => item.external_id === "keep")!;
    app.hmn.reject(access, declined.proposal_id!);
    app.hmn.approve(access, kept.proposal_id!);
    expect(direct(records).counts).toEqual({ exists: 1, declined: 1 });

    // The owner removes the imported note. In the 90 days the import does not bring it back.
    const note = entity(app, "keep")!;
    app.hmn.remove(access, "note", note.id);
    clock.now = new Date("2027-02-01T04:39:00.000Z");
    expect(direct(records).counts).toEqual({ removed: 1, declined: 1 });

    // After 90 days the ids are no longer kept.
    clock.now = new Date("2027-02-12T04:39:00.000Z");
    expect(direct(records).counts).toEqual({ proposed: 2 });
  } finally {
    app.close();
  }
});

test("a bad record is reported and the other records continue, and only a write key can import", async () => {
  const app = testApp();
  try {
    const reply = await run(app, [
      { external_id: "ok", type: "task", title: "Example good task" },
      { external_id: "ok", type: "task", title: "Example copy of the id" },
      { type: "task", title: "Example with no id" },
      { external_id: "no-title", type: "task", title: "  " },
      { external_id: "bad-type", type: "spaceship", title: "Example" },
      { external_id: "a-source", type: "source", title: "Example" },
      { external_id: "bad-status", type: "task", title: "Example", status: "blocked" },
      { external_id: "bad-date", type: "task", title: "Example", due_at: "next Tuesday" },
      { external_id: "bad-tier", type: "task", title: "Example", tier: "secret" },
      { external_id: "bad-area", type: "task", title: "Example", area: "No such area" },
      { external_id: "bad-link", type: "task", title: "Example", links: [{ rel: "about", to: "nothing" }] },
      // A family item cannot be made Public by the import.
      { external_id: "too-open", type: "task", title: "Example", area: "Family", tier: "public" },
      { external_id: "spoiler", type: "event", title: "Example fixture", kind: "fixture", area: "Sport", properties: { score: "2-1" } },
    ]);
    const errors = Object.fromEntries(reply.results.filter((item) => item.status === "invalid").map((item) => [item.external_id ?? "(none)", item.error]));
    expect(errors).toEqual({
      "(none)": "external_id",
      ok: "duplicate",
      "no-title": "title",
      "bad-type": "type",
      "a-source": "type",
      "bad-status": "status_or_kind",
      "bad-date": "due_at",
      "bad-tier": "tier",
      "bad-area": "unknown_area",
      "bad-link": "unknown_link",
      "too-open": "tier_floor",
      spoiler: "no_scores",
    });
    expect(reply.counts).toEqual({ proposed: 1, invalid: 12 });

    const agent = await call(app, "/api/v1/import", { method: "POST", key: app.secrets!.agent, surface: "mcp", body: { source: "notion", records: [{ external_id: "x", type: "task", title: "Example" }] } });
    expect(agent.status).toBe(403);
    expect((await call(app, "/api/v1/import", { method: "POST", ...owner(app), body: { source: "Not A Slug", records: [{}] } })).status).toBe(422);
    expect((await call(app, "/api/v1/import", { method: "POST", ...owner(app), body: { source: "notion", records: [] } })).status).toBe(422);

    // The Notion plugin is gone.
    const tick = await call(app, "/api/v1/plugins/notion/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { pages: [] } });
    expect(tick.status).toBe(404);
    expect((await call(app, "/api/v1/plugins", owner(app))).text).not.toContain("notion");
  } finally {
    app.close();
  }
});
