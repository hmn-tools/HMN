import { expect, test } from "bun:test";
import { ruleFor, type PolicyRule } from "../src/approval";
import type { App } from "../src/app";
import { workerAccess } from "../src/workers/context";
import { runWorker } from "../src/workers/run";
import { call, testApp } from "./helpers";

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

async function setRule(app: App, body: Record<string, unknown>) {
  return call(app, "/api/v1/policy", { method: "PUT", ...owner(app), body });
}

function row(app: App, id: string) {
  return app.hmn.store.db.query("SELECT status, decided_by, entity_id, applied, source FROM proposals WHERE id = ?").get(id) as {
    status: string;
    decided_by: string | null;
    entity_id: string | null;
    applied: string | null;
    source: string | null;
  };
}

function entity(app: App, id: string) {
  return app.hmn.store.db.query("SELECT title, origin, origin_ref, deleted_at, tier, confirmed_at FROM entities WHERE id = ?").get(id) as {
    title: string;
    origin: string;
    origin_ref: string | null;
    deleted_at: string | null;
    tier: string | null;
    confirmed_at: string | null;
  };
}

function versions(app: App, id: string) {
  return app.hmn.store.db.query("SELECT origin, origin_ref, tombstone, title FROM entity_versions WHERE entity_id = ? ORDER BY rowid ASC").all(id) as Array<{
    origin: string;
    origin_ref: string | null;
    tombstone: number;
    title: string;
  }>;
}

async function addPeople(app: App) {
  await call(app, "/api/v1/person/person_yves", { method: "PATCH", ...owner(app), body: { properties: { birthday: "11-20" } } });
  await call(app, "/api/v1/person", {
    method: "POST",
    ...owner(app),
    body: { title: "Noah", kind: "other", area_id: "area_work", properties: { anniversary: "11-18" } },
  });
}

test("the most specific rule wins, and a tie goes to the stricter mode", () => {
  const rule = (id: string, source: string, op: string, entity_type: string, tier: string, mode: PolicyRule["mode"]): PolicyRule => ({ id, source, op, entity_type, tier, mode, updated_at: "" });
  const rules = [
    rule("a", "worker:people", "*", "*", "*", "auto"),
    rule("b", "worker:people", "create", "task", "private", "review"),
    rule("c", "*", "create", "*", "*", "deny"),
  ];
  expect(ruleFor(rules, { source: "worker:people", op: "create", entityType: "task", tier: "private" })?.id).toBe("b");
  // One named field each for "a" and "c": the stricter mode wins.
  expect(ruleFor(rules, { source: "worker:people", op: "create", entityType: "task", tier: "personal" })?.id).toBe("c");
  expect(ruleFor(rules, { source: "worker:people", op: "link", entityType: null, tier: "personal" })?.id).toBe("a");
  expect(ruleFor(rules, { source: "worker:goals", op: "link", entityType: null, tier: "personal" })).toBeNull();
});

test("a class set to auto writes with the same provenance as an approval, and the owner can undo it", async () => {
  const manual = testApp();
  const auto = testApp();
  try {
    await addPeople(manual);
    await addPeople(auto);

    // By hand, for the comparison.
    const manualRun = await runWorker(manual.hmn, "people");
    const manualNoah = manualRun.proposals.find((item) => item.title === "Remember Noah")!;
    expect(manualNoah.status).toBe("pending");
    await call(manual, `/api/v1/proposals/${manualNoah.id}/approve`, { method: "POST", ...owner(manual) });
    const byHand = entity(manual, row(manual, manualNoah.id).entity_id!);

    const made = await setRule(auto, { source: "worker:people", op: "create", entity_type: "task", mode: "auto" });
    expect(made.status).toBe(200);
    const tasksBefore = (auto.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE type = 'task'").get() as { n: number }).n;
    const run = await runWorker(auto.hmn, "people");
    expect(run.approved).toBe(false);
    const noah = run.proposals.find((item) => item.title === "Remember Noah")!;
    const yves = run.proposals.find((item) => item.title === "Wish Yves well")!;
    expect(noah.status).toBe("approved");
    expect(yves.status).toBe("approved");
    expect(yves.tier).toBe("private");
    expect((auto.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE type = 'task'").get() as { n: number }).n).toBe(tasksBefore + 2);

    const decided = row(auto, noah.id);
    expect(decided.decided_by).toBe("policy");
    expect(decided.source).toBe("worker:people");
    const written = entity(auto, decided.entity_id!);
    expect(written.title).toBe("Remember Noah");
    expect({ origin: written.origin, origin_ref: written.origin_ref }).toEqual({ origin: byHand.origin, origin_ref: byHand.origin_ref });
    expect(Boolean(written.confirmed_at)).toBe(Boolean(byHand.confirmed_at));
    expect(versions(auto, decided.entity_id!)).toHaveLength(1);
    expect(versions(auto, decided.entity_id!)[0]?.origin_ref).toBe("People");
    const links = auto.hmn.store.db.query("SELECT rel, to_type, deleted_at FROM links WHERE from_id = ?").all(decided.entity_id!) as Array<{ rel: string; to_type: string; deleted_at: string | null }>;
    expect(links).toEqual([{ rel: "about", to_type: "person", deleted_at: null }]);
    const audit = auto.hmn.store.db.query("SELECT actor FROM audit_log WHERE action = 'auto_approve' AND entity_id = ?").get(noah.id) as { actor: string } | null;
    expect(audit?.actor).toBe("policy");
    // The family task stays Private. The widget does not get it.
    const widget = await call(auto, "/api/v1/search?q=Wish%20Yves", { key: auto.secrets!.owner, surface: "widget" });
    expect(widget.text).not.toContain("Wish Yves well");

    // The Activity list shows it, and it can be undone.
    const activity = await call(auto, "/api/v1/activity", owner(auto));
    const item = (activity.json as { activity: Array<{ id: string; decided_by: string; can_undo: boolean; title: string; source: string }> }).activity.find((entry) => entry.id === noah.id)!;
    expect(item).toMatchObject({ decided_by: "policy", can_undo: true, title: "Remember Noah", source: "worker:people" });

    const undone = await call(auto, `/api/v1/proposals/${noah.id}/undo`, { method: "POST", ...owner(auto) });
    expect(undone.status).toBe(200);
    expect(row(auto, noah.id).status).toBe("undone");
    expect(entity(auto, decided.entity_id!).deleted_at).not.toBeNull();
    const after = auto.hmn.store.db.query("SELECT deleted_at FROM links WHERE from_id = ?").all(decided.entity_id!) as Array<{ deleted_at: string | null }>;
    expect(after.every((link) => link.deleted_at !== null)).toBe(true);
    // History keeps the write and the removal.
    expect(versions(auto, decided.entity_id!).map((version) => version.tombstone)).toEqual([0, 1]);
    expect((await call(auto, `/api/v1/proposals/${noah.id}/undo`, { method: "POST", ...owner(auto) })).status).toBe(409);

    // An undone item does not come back until the owner clears it.
    expect((await runWorker(auto.hmn, "people")).proposals).toHaveLength(0);
    const cleared = await call(auto, `/api/v1/proposals/${noah.id}/clear`, { method: "POST", ...owner(auto) });
    expect(cleared.status).toBe(200);
    const again = await runWorker(auto.hmn, "people");
    expect(again.proposals.map((entry) => entry.title)).toEqual(["Remember Noah"]);
    expect(again.proposals[0]?.status).toBe("approved");
  } finally {
    manual.close();
    auto.close();
  }
});

test("a delete, a tier change, Sealed data, and an outside client always wait for the owner", async () => {
  const app = testApp();
  try {
    // The rule itself is refused where it can be.
    expect((await setRule(app, { source: "worker:people", op: "delete", mode: "auto" })).status).toBe(422);
    expect((await setRule(app, { source: "worker:people", tier: "sealed", mode: "auto" })).status).toBe(422);
    expect((await setRule(app, { source: "key:key_agent", mode: "auto" })).status).toBe(422);
    expect((await setRule(app, { mode: "auto" })).status).toBe(422);
    expect((await setRule(app, { source: "worker:people", mode: "sometimes" })).status).toBe(422);

    // The widest rule the server accepts for one worker.
    expect((await setRule(app, { source: "worker:people", mode: "auto" })).status).toBe(200);
    const people = workerAccess({ id: "people", name: "People", tier: "private" });
    const task = await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Keep me", status: "open", kind: "task", area_id: "area_work" } });
    const taskId = (task.json as { id: string }).id;

    // A delete from the same source still waits.
    const del = app.hmn.createProposal(people, { op: "delete", payload: { op: "delete", id: taskId }, reason: "A test." }, "People");
    expect(row(app, del.id).status).toBe("pending");
    expect(entity(app, taskId).deleted_at).toBeNull();

    // A patch that sets the tier waits. A patch that sets the area waits.
    const lower = app.hmn.createProposal(people, { op: "update", payload: { op: "update", id: taskId, patch: { tier: "public" } }, reason: "A test." }, "People");
    expect(row(app, lower.id).status).toBe("pending");
    const move = app.hmn.createProposal(people, { op: "update", payload: { op: "update", id: taskId, patch: { area_id: "area_sport" } }, reason: "A test." }, "People");
    expect(row(app, move.id).status).toBe("pending");
    expect(entity(app, taskId).tier).toBeNull();
    // A patch to an area waits, because the area holds the tier of its items.
    const area = app.hmn.createProposal(people, { op: "update", payload: { op: "update", id: "area_work", patch: { properties: {} } }, reason: "A test." }, "People");
    expect(row(app, area.id).status).toBe("pending");

    // A rule by entity type matches an update, by the type of its target. Review for tasks is more specific than auto for the worker.
    expect((await setRule(app, { source: "worker:people", op: "update", entity_type: "task", mode: "review" })).status).toBe(200);
    const held = app.hmn.createProposal(people, { op: "update", payload: { op: "update", id: taskId, patch: { title: "Held for review" } }, reason: "A test." }, "People");
    expect(row(app, held.id).status).toBe("pending");
    const rules = (await call(app, "/api/v1/policy", owner(app))).json as { rules: PolicyRule[] };
    const taskRule = rules.rules.find((rule) => rule.entity_type === "task")!;
    expect((await call(app, `/api/v1/policy/${taskRule.id}`, { method: "DELETE", ...owner(app) })).status).toBe(200);

    // A plain patch is applied, and undo brings the old title back as a new version.
    const rename = app.hmn.createProposal(people, { op: "update", payload: { op: "update", id: taskId, patch: { title: "Keep me, renamed" } }, reason: "A test." }, "People");
    expect(row(app, rename.id)).toMatchObject({ status: "approved", decided_by: "policy" });
    expect(entity(app, taskId).title).toBe("Keep me, renamed");
    expect((await call(app, `/api/v1/proposals/${rename.id}/undo`, { method: "POST", ...owner(app) })).status).toBe(200);
    expect(entity(app, taskId).title).toBe("Keep me");
    expect(versions(app, taskId).map((version) => version.title)).toEqual(["Keep me", "Keep me, renamed", "Keep me"]);
    expect(versions(app, taskId)[2]?.origin_ref).toBe("undo");

    // After a later edit by the owner, undo refuses and changes nothing.
    const second = app.hmn.createProposal(people, { op: "update", payload: { op: "update", id: taskId, patch: { title: "Second rename" } }, reason: "A test." }, "People");
    await call(app, `/api/v1/task/${taskId}`, { method: "PATCH", ...owner(app), body: { title: "The owner's title" } });
    const refused = await call(app, `/api/v1/proposals/${second.id}/undo`, { method: "POST", ...owner(app) });
    expect(refused.status).toBe(409);
    expect(entity(app, taskId).title).toBe("The owner's title");
    expect(row(app, second.id).status).toBe("approved");

    // An outside client is never auto-accepted, also when it uses a plugin's name.
    expect((await setRule(app, { source: "plugin:calendar", mode: "auto" })).status).toBe(200);
    const outside = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      agent: "calendar",
      body: { op: "create", entity: { type: "task", title: "From outside", status: "open", kind: "task", area_id: "area_work" }, reason: "A test." },
    });
    expect(outside.status).toBe(201);
    const outsideId = (outside.json as { id: string; source: string }).id;
    expect(row(app, outsideId).status).toBe("pending");
    expect(row(app, outsideId).source).toBe("key:key_agent");

    // An agent key cannot read or change the policy, the Activity list, or a batch.
    const agent = { key: app.secrets!.agent, surface: "mcp" };
    expect((await call(app, "/api/v1/policy", agent)).status).toBe(403);
    expect((await call(app, "/api/v1/policy", { method: "PUT", ...agent, body: { source: "worker:people", mode: "auto" } })).status).toBe(403);
    expect((await call(app, "/api/v1/activity", agent)).status).toBe(403);
    expect((await call(app, "/api/v1/proposals/batch", { method: "POST", ...agent, body: { decision: "approve", source: "key:key_agent", ids: [outsideId] } })).status).toBe(403);
    expect((await call(app, `/api/v1/proposals/${rename.id}/undo`, { method: "POST", ...agent })).status).toBe(403);
    expect(row(app, outsideId).status).toBe("pending");
  } finally {
    app.close();
  }
});

test("a calendar tick with an auto rule writes events as a plugin, and a deny rule drops them", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/source", { method: "POST", ...owner(app), body: { title: "Example calendar", kind: "calendar" } });
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:auto-1", "SUMMARY:Example planning block", "DTSTART;VALUE=DATE:20261120", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    expect((await setRule(app, { source: "plugin:calendar", op: "create", entity_type: "event", mode: "auto" })).status).toBe(200);
    const tick = await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { ics } });
    const proposals = (tick.json as { proposals: Array<{ id: string }> }).proposals;
    expect(proposals).toHaveLength(1);
    const decided = row(app, proposals[0]!.id);
    expect(decided).toMatchObject({ status: "approved", decided_by: "policy", source: "plugin:calendar" });
    expect(entity(app, decided.entity_id!)).toMatchObject({ title: "Example planning block", origin: "plugin", origin_ref: "calendar" });
    const pending = await call(app, "/api/v1/proposals?status=pending&source=plugin:calendar", owner(app));
    expect((pending.json as { proposals: unknown[] }).proposals).toHaveLength(0);

    // Deny: the tick still answers, and it files nothing.
    expect((await setRule(app, { source: "plugin:calendar", op: "create", entity_type: "event", mode: "deny" })).status).toBe(200);
    // The calendar still has the first event, and it has one new event.
    const other = ics.replace("END:VEVENT", ["END:VEVENT", "BEGIN:VEVENT", "UID:auto-2", "SUMMARY:Example second block", "DTSTART;VALUE=DATE:20261121", "END:VEVENT"].join("\r\n"));
    const denied = await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { ics: other } });
    expect(denied.status).toBe(200);
    expect((denied.json as { proposals: unknown[] }).proposals).toHaveLength(0);
    expect((await call(app, "/api/v1/search?q=second%20block", owner(app))).text).not.toContain("second block");

    // A deny rule for an outside key refuses the request.
    expect((await setRule(app, { source: "key:key_agent", mode: "deny" })).status).toBe(200);
    const refused = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      body: { op: "create", entity: { type: "task", title: "Refused", status: "open", kind: "task", area_id: "area_work" }, reason: "A test." },
    });
    expect(refused.status).toBe(403);

    // Remove the rule, and the default is review again.
    const list = await call(app, "/api/v1/policy", owner(app));
    const rules = (list.json as { default_mode: string; rules: PolicyRule[] }).rules;
    expect((list.json as { default_mode: string }).default_mode).toBe("review");
    expect(rules).toHaveLength(2);
    const keyRule = rules.find((rule) => rule.source === "key:key_agent")!;
    expect((await call(app, `/api/v1/policy/${keyRule.id}`, { method: "DELETE", ...owner(app) })).status).toBe(200);
    const accepted = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      body: { op: "create", entity: { type: "task", title: "Accepted for review", status: "open", kind: "task", area_id: "area_work" }, reason: "A test." },
    });
    expect(accepted.status).toBe(201);
    expect((accepted.json as { status: string }).status).toBe("pending");
  } finally {
    app.close();
  }
});

test("a batch of 40 takes one decision, and it stays inside one source", async () => {
  const app = testApp();
  try {
    for (let i = 1; i <= 40; i++) {
      app.hmn.create({ ...app.hmn.accessFor(app.secrets!.owner, "127.0.0.1", "phone", null) }, "note", { title: `Buy item ${i}`, status: "open" });
    }
    const run = await runWorker(app.hmn, "triage");
    const mine = run.proposals.filter((item) => item.title?.startsWith("Buy item "));
    expect(mine).toHaveLength(40);
    const listed = await call(app, "/api/v1/proposals?status=pending&source=worker:triage", owner(app));
    const ids = (listed.json as { proposals: Array<{ id: string; source: string; payload: { entity?: { title?: string } } }> }).proposals
      .filter((item) => item.payload.entity?.title?.startsWith("Buy item "))
      .map((item) => item.id);
    expect(ids).toHaveLength(40);

    // A proposal from another source cannot ride in the batch.
    const morning = await runWorker(app.hmn, "morning");
    const mixed = await call(app, "/api/v1/proposals/batch", { method: "POST", ...owner(app), body: { decision: "approve", source: "worker:triage", ids: [...ids, morning.proposals[0]!.id] } });
    expect(mixed.status).toBe(422);
    expect(row(app, ids[0]!).status).toBe("pending");

    const before = (app.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE type = 'task'").get() as { n: number }).n;
    const batch = await call(app, "/api/v1/proposals/batch", { method: "POST", ...owner(app), body: { decision: "approve", source: "worker:triage", ids } });
    expect(batch.status).toBe(200);
    expect(batch.json).toMatchObject({ decided: 40, failed: 0 });
    expect((app.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE type = 'task'").get() as { n: number }).n).toBe(before + 40);
    expect(row(app, ids[39]!)).toMatchObject({ status: "approved", decided_by: "owner" });
    expect(row(app, morning.proposals[0]!.id).status).toBe("pending");

    // A second batch on the same ids changes nothing and reports each one.
    const repeat = await call(app, "/api/v1/proposals/batch", { method: "POST", ...owner(app), body: { decision: "reject", source: "worker:triage", ids } });
    expect(repeat.json).toMatchObject({ decided: 0, failed: 40 });
    expect(row(app, ids[0]!).status).toBe("approved");

    // Decline in one decision, and see it in the Activity list with a clear action.
    const declined = await call(app, "/api/v1/proposals/batch", { method: "POST", ...owner(app), body: { decision: "reject", source: "worker:morning", ids: [morning.proposals[0]!.id] } });
    expect(declined.json).toMatchObject({ decided: 1, failed: 0, remaining: 0 });
    const activity = await call(app, "/api/v1/activity?limit=5", owner(app));
    const top = (activity.json as { activity: Array<{ id: string; status: string; can_clear: boolean; can_undo: boolean }> }).activity[0]!;
    expect(top).toMatchObject({ id: morning.proposals[0]!.id, status: "rejected", can_clear: true, can_undo: false });
  } finally {
    app.close();
  }
}, 30_000);

test("the owner can undo an approved removal, and not after a later change or a purge", async () => {
  const app = testApp();
  try {
    const agent = { key: app.secrets!.agent, agent: "Example agent" };
    const made = await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Remove me", status: "open", kind: "task", area_id: "area_work" } });
    const taskId = (made.json as { id: string }).id;
    const propose = async () => {
      const reply = await call(app, "/api/v1/proposals", { method: "POST", ...agent, body: { op: "delete", payload: { op: "delete", id: taskId }, reason: "A test." } });
      expect(reply.status).toBe(201);
      return (reply.json as { id: string }).id;
    };

    // A removal waits for the owner. After the approval the row has a mark, and its history has a tombstone.
    const first = await propose();
    expect(row(app, first).status).toBe("pending");
    expect((await call(app, `/api/v1/proposals/${first}/approve`, { method: "POST", ...owner(app) })).status).toBe(200);
    expect(entity(app, taskId).deleted_at).not.toBeNull();
    const activity = await call(app, "/api/v1/activity", owner(app));
    const item = (activity.json as { activity: Array<{ id: string; can_undo: boolean }> }).activity.find((entry) => entry.id === first)!;
    expect(item.can_undo).toBe(true);

    // Undo brings the item back as a new version. The tombstone stays in the history.
    expect((await call(app, `/api/v1/proposals/${first}/undo`, { method: "POST", ...owner(app) })).status).toBe(200);
    expect(entity(app, taskId)).toMatchObject({ title: "Remove me", deleted_at: null });
    expect(versions(app, taskId).map((version) => version.tombstone)).toEqual([0, 1, 0]);
    expect(versions(app, taskId)[2]?.origin_ref).toBe("undo");
    expect(row(app, first).status).toBe("undone");
    expect((await call(app, `/api/v1/task/${taskId}`, owner(app))).status).toBe(200);
    expect((await call(app, `/api/v1/proposals/${first}/undo`, { method: "POST", ...owner(app) })).status).toBe(409);
    // An agent cannot undo.
    const second = await propose();
    await call(app, `/api/v1/proposals/${second}/approve`, { method: "POST", ...owner(app) });
    expect((await call(app, `/api/v1/proposals/${second}/undo`, { method: "POST", ...agent })).status).toBe(403);

    // A record from before the earlier version was stored cannot be undone, and the list says so.
    const applied = JSON.parse(row(app, second).applied!) as Record<string, unknown>;
    app.hmn.store.db.query("UPDATE proposals SET applied = ? WHERE id = ?").run(JSON.stringify({ ...applied, prev_version_id: null }), second);
    const old = (await call(app, "/api/v1/activity", owner(app))).json as { activity: Array<{ id: string; can_undo: boolean }> };
    expect(old.activity.find((entry) => entry.id === second)!.can_undo).toBe(false);
    expect((await call(app, `/api/v1/proposals/${second}/undo`, { method: "POST", ...owner(app) })).status).toBe(409);
    app.hmn.store.db.query("UPDATE proposals SET applied = ? WHERE id = ?").run(JSON.stringify(applied), second);

    // After a purge the row is gone, and so is each proposal that held its text. Nothing is left to undo.
    const purged = await call(app, `/api/v1/task/${taskId}/purge`, { method: "POST", ...owner(app) });
    expect(purged.status).toBe(200);
    expect((await call(app, `/api/v1/proposals/${second}/undo`, { method: "POST", ...owner(app) })).status).toBe(404);
    expect(app.hmn.store.db.query("SELECT id FROM proposals WHERE id = ?").get(second)).toBeNull();
  } finally {
    app.close();
  }
});
