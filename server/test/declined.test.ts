import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp, type App } from "../src/app";
import { runDue, runWorker } from "../src/workers/run";
import { call } from "./helpers";

type Clock = { now: Date };

/** 2026-11-11 12:39 in Perth. The clock moves, so a test can pass a birthday. */
function clockedApp(): { app: App; clock: Clock } {
  const clock: Clock = { now: new Date("2026-11-11T04:39:00.000Z") };
  const app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "hmn-declined-")),
    kek: randomBytes(32),
    now: () => clock.now,
    timeZone: "Australia/Perth",
  });
  return { app, clock };
}

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

async function decide(app: App, id: string, decision: "approve" | "reject") {
  const result = await call(app, `/api/v1/proposals/${id}/${decision}`, { method: "POST", ...owner(app) });
  expect(result.status).toBe(200);
}

function statusOf(app: App, id: string): string {
  return (app.hmn.store.db.query("SELECT status FROM proposals WHERE id = ?").get(id) as { status: string }).status;
}

function titles(run: { proposals: Array<{ title?: string }> }): string[] {
  return run.proposals.map((item) => item.title ?? "");
}

test("a declined People proposal does not return, and an approved one is not proposed twice", async () => {
  const { app, clock } = clockedApp();
  try {
    await call(app, "/api/v1/person/person_yves", { method: "PATCH", ...owner(app), body: { properties: { birthday: "11-20" } } });
    await call(app, "/api/v1/person", {
      method: "POST",
      ...owner(app),
      body: { title: "Noah", kind: "other", area_id: "area_work", properties: { anniversary: "11-18", last_contact: "2026-08-01" } },
    });

    const first = await runWorker(app.hmn, "people");
    expect(titles(first).sort()).toEqual(["Remember Noah", "Wish Yves well", "Write to Noah"]);
    const wish = first.proposals.find((item) => item.title === "Wish Yves well")!;
    const remember = first.proposals.find((item) => item.title === "Remember Noah")!;
    const write = first.proposals.find((item) => item.title === "Write to Noah")!;

    await decide(app, wish.id, "reject");
    await decide(app, remember.id, "approve");

    // Same day: the declined one, the approved one, and the pending one all stay away.
    const second = await runWorker(app.hmn, "people");
    expect(second.proposals).toHaveLength(0);
    expect(second.skipped).toBe(3);

    // The next day, and the day after: the daily run does not bring them back.
    clock.now = new Date("2026-11-12T04:39:00.000Z");
    expect((await runWorker(app.hmn, "people")).proposals).toHaveLength(0);
    clock.now = new Date("2026-11-13T04:39:00.000Z");
    expect((await runWorker(app.hmn, "people")).proposals).toHaveLength(0);
    expect(statusOf(app, wish.id)).toBe("rejected");

    // A decline of "Write to Noah" holds until the last contact date changes.
    await decide(app, write.id, "reject");
    expect((await runWorker(app.hmn, "people")).proposals).toHaveLength(0);
    const noah = app.hmn.store.db.query("SELECT id FROM entities WHERE type = 'person' AND title = 'Noah'").get() as { id: string };
    await call(app, `/api/v1/person/${noah.id}`, { method: "PATCH", ...owner(app), body: { properties: { last_contact: "2026-09-01" } } });
    expect(titles(await runWorker(app.hmn, "people"))).toEqual(["Write to Noah"]);

    // Next year the birthday is a new item.
    clock.now = new Date("2027-11-11T04:39:00.000Z");
    expect(titles(await runWorker(app.hmn, "people"))).toContain("Wish Yves well");
  } finally {
    app.close();
  }
});

test("a pending proposal expires after its date, and the graph does not change", async () => {
  const { app, clock } = clockedApp();
  try {
    await call(app, "/api/v1/person/person_yves", { method: "PATCH", ...owner(app), body: { properties: { birthday: "11-20" } } });
    const run = await runWorker(app.hmn, "people");
    const wish = run.proposals.find((item) => item.title === "Wish Yves well")!;
    const row = app.hmn.store.db.query("SELECT expires_on, source_key FROM proposals WHERE id = ?").get(wish.id) as { expires_on: string; source_key: string };
    expect(row.expires_on).toBe("2026-11-20");
    expect(row.source_key).toBe("person_yves:birthday:2026-11-20");

    const count = () => (app.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities").get() as { n: number }).n;
    const links = () => (app.hmn.store.db.query("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n;
    const before = { entities: count(), links: links() };

    // On the birthday in Perth the proposal is still in the queue.
    clock.now = new Date("2026-11-20T15:00:00.000Z");
    await runDue(app.hmn);
    expect(statusOf(app, wish.id)).toBe("pending");

    // The day after, the minute loop removes it.
    clock.now = new Date("2026-11-20T16:30:00.000Z");
    await runDue(app.hmn);
    expect(statusOf(app, wish.id)).toBe("expired");
    const decided = app.hmn.store.db.query("SELECT decided_by FROM proposals WHERE id = ?").get(wish.id) as { decided_by: string };
    expect(decided.decided_by).toBe("system");
    expect({ entities: count(), links: links() }).toEqual(before);

    const pending = await call(app, "/api/v1/proposals?status=pending", owner(app));
    expect(pending.text).not.toContain(wish.id);
    const audit = app.hmn.store.db.query("SELECT actor FROM audit_log WHERE action = 'expire' AND entity_id = ?").get(wish.id) as { actor: string } | null;
    expect(audit?.actor).toBe("system");

    // An expired proposal cannot be approved, and the worker does not file it again.
    const late = await call(app, `/api/v1/proposals/${wish.id}/approve`, { method: "POST", ...owner(app) });
    expect(late.status).toBe(409);
    expect(titles(await runWorker(app.hmn, "people"))).not.toContain("Wish Yves well");
  } finally {
    app.close();
  }
});

test("Morning and Week file one note, not a second one while the first is pending or was declined that day", async () => {
  const { app, clock } = clockedApp();
  try {
    const first = await runWorker(app.hmn, "morning");
    expect(first.proposals).toHaveLength(1);
    expect((await runWorker(app.hmn, "morning")).proposals).toHaveLength(0);

    // Declined today: no second brief today.
    await decide(app, first.proposals[0]!.id, "reject");
    expect((await runWorker(app.hmn, "morning")).proposals).toHaveLength(0);

    // The next day has its own brief. It is left pending.
    clock.now = new Date("2026-11-12T00:10:00.000Z");
    const second = await runWorker(app.hmn, "morning");
    expect(second.proposals).toHaveLength(1);

    // A day later the old brief has expired, and the new day has one brief.
    clock.now = new Date("2026-11-13T00:10:00.000Z");
    const third = await runWorker(app.hmn, "morning");
    expect(statusOf(app, second.proposals[0]!.id)).toBe("expired");
    expect(third.proposals).toHaveLength(1);

    // An approved brief does not stop a new one on the same day.
    await decide(app, third.proposals[0]!.id, "approve");
    expect((await runWorker(app.hmn, "morning")).proposals).toHaveLength(1);

    // Week: one pending review stops a second one on a later day of the same week.
    const week = await runWorker(app.hmn, "weekly");
    expect(week.proposals).toHaveLength(1);
    clock.now = new Date("2026-11-15T00:10:00.000Z");
    expect((await runWorker(app.hmn, "weekly")).proposals).toHaveLength(0);
    clock.now = new Date("2026-11-21T00:10:00.000Z");
    const nextWeek = await runWorker(app.hmn, "weekly");
    expect(statusOf(app, week.proposals[0]!.id)).toBe("expired");
    expect(nextWeek.proposals).toHaveLength(1);
  } finally {
    app.close();
  }
});

test("Triage and Goals remember a decision", async () => {
  const { app } = clockedApp();
  try {
    await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Call the dentist", status: "open" } });
    const triage = await runWorker(app.hmn, "triage");
    const callTask = triage.proposals.find((item) => item.title === "Call the dentist")!;
    expect(callTask).toBeTruthy();
    await decide(app, callTask.id, "approve");
    // The note is still open. An approved triage draft is not filed again each hour.
    expect(titles(await runWorker(app.hmn, "triage"))).not.toContain("Call the dentist");

    await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Buy a lamp", status: "open" } });
    const again = await runWorker(app.hmn, "triage");
    const lamp = again.proposals.find((item) => item.title === "Buy a lamp")!;
    await decide(app, lamp.id, "reject");
    expect(titles(await runWorker(app.hmn, "triage"))).not.toContain("Buy a lamp");

    await call(app, "/api/v1/goal", { method: "POST", ...owner(app), body: { title: "Learn the harbour", status: "active" } });
    const goals = await runWorker(app.hmn, "goals");
    const step = goals.proposals.find((item) => item.title === "Next step for Learn the harbour")!;
    expect(step).toBeTruthy();
    await decide(app, step.id, "reject");
    expect(titles(await runWorker(app.hmn, "goals"))).not.toContain("Next step for Learn the harbour");
  } finally {
    app.close();
  }
});

test("an outside request cannot set a source key or an expiry date", async () => {
  const { app } = clockedApp();
  try {
    const made = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      body: {
        op: "create",
        entity: { type: "task", title: "Send the brief", status: "open", kind: "task", area_id: "area_work" },
        reason: "A test.",
        source_key: "morning:2026-11-11",
        expires_on: "2020-01-01",
      },
    });
    expect(made.status).toBe(201);
    const id = (made.json as { id: string }).id;
    const row = app.hmn.store.db.query("SELECT source_key, expires_on FROM proposals WHERE id = ?").get(id) as { source_key: string | null; expires_on: string | null };
    expect(row.source_key).toBeNull();
    expect(row.expires_on).toBeNull();
    await runDue(app.hmn);
    expect(statusOf(app, id)).toBe("pending");
  } finally {
    app.close();
  }
});
