import { afterAll, beforeAll, expect, test } from "bun:test";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";
import { stripFixture } from "../src/plugins/sport";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-family
SUMMARY:School run
DTSTART;VALUE=DATE:20261118
ATTENDEE;CN=Luca:mailto:luca@example.test
END:VEVENT
BEGIN:VEVENT
UID:evt-other
SUMMARY:Coffee with Pat Example
DTSTART:20261119T010000Z
ATTENDEE;CN=Pat Example:mailto:pat@example.test
END:VEVENT
END:VCALENDAR`;

test("calendar ICS maps family dates and does not invent people", async () => {
  await call(app, "/api/v1/source", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    // This calendar waits for review. A calendar is accepted with no review by default.
    body: { title: "Example calendar", kind: "calendar", properties: { approval: "review" } },
  });
  const tick = await call(app, "/api/v1/plugins/calendar/tick", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    ip: "127.0.0.1",
    body: { ics },
  });
  const proposals = (tick.json as { proposals: Array<{ id: string }> }).proposals;
  expect(proposals).toHaveLength(2);
  for (const proposal of proposals) {
    const approved = await call(app, `/api/v1/proposals/${proposal.id}/approve`, {
      method: "POST",
      key: app.secrets!.owner,
      surface: "phone",
    });
    expect(approved.status).toBe(200);
  }
  const phone = await call(app, "/api/v1/search?q=School%20run", { key: app.secrets!.owner, surface: "phone" });
  expect(phone.text).toContain("2026-11-18");
  const widget = await call(app, "/api/v1/search?q=School%20run", { key: app.secrets!.owner, surface: "widget" });
  expect(widget.text).not.toContain("School run");
  const people = await call(app, "/api/v1/search?q=Pat%20Example", { key: app.secrets!.owner, surface: "phone" });
  const persons = (people.json as { results: Array<{ type: string }> }).results.filter((item) => item.type === "person");
  expect(persons).toEqual([]);
  const coffee = await call(app, "/api/v1/search?q=Coffee%20with%20Pat", { key: app.secrets!.owner, surface: "phone" });
  expect(coffee.text).toContain("Coffee with Pat Example");
  expect(coffee.text).not.toContain("score");
});

test("sport and motorsport fixtures drop scores and the past", async () => {
  const stripped = stripFixture({ id: "x", title: "Race", start: "2026-11-20T00:00:00.000Z", score: "2-1", result: "P3", winner: "A" });
  expect(stripped).not.toHaveProperty("score");
  expect(stripped).not.toHaveProperty("result");
  expect(JSON.stringify(stripped)).not.toContain("2-1");
  const tick = await call(app, "/api/v1/plugins/sport/tick", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    ip: "127.0.0.1",
    body: {
      fixtures: [
        { id: "fx-1", title: "Example FC upcoming", start: "2026-11-20T12:00:00.000Z", competition: "League", score: "2-1", winner: "Example FC" },
        { id: "fx-old", title: "Example FC played", start: "2026-10-01T12:00:00.000Z", score: "1-0" },
        { id: "fx-motor", title: "Sample Racing practice", start: "2026-11-21T01:00:00.000Z", category: "motorsport", result: "P3" },
      ],
    },
  });
  expect(tick.text).not.toContain("2-1");
  expect(tick.text).not.toContain("P3");
  expect(tick.text).not.toContain("Example FC played");
  const proposals = (tick.json as { proposals: Array<{ id: string }> }).proposals;
  expect(proposals).toHaveLength(2);
  for (const proposal of proposals) {
    expect((await call(app, `/api/v1/proposals/${proposal.id}/approve`, { method: "POST", key: app.secrets!.owner, surface: "phone" })).status).toBe(200);
  }
  const listed = await call(app, "/api/v1/event", { key: app.secrets!.display, surface: "display" });
  expect(listed.text).toContain("Example FC upcoming");
  expect(listed.text).toContain("Sample Racing practice");
  expect(listed.text).not.toContain("2-1");
  expect(listed.text).not.toContain("P3");
  expect(listed.text).not.toContain("winner");
  const status = await call(app, "/api/v1/plugins", { key: app.secrets!.display });
  expect(status.text).not.toContain("HMN_CALDAV_PASSWORD");
  expect(status.text).toContain("calendar");
  expect(status.text).not.toContain("notion");

  const id = "proposal_spoiler";
  const payload = JSON.stringify({
    op: "create",
    entity: { type: "event", title: "Sneaky result", kind: "fixture", status: "upcoming", area_id: "area_sport", due_at: "2026-12-01T00:00:00.000Z", properties: { score: "9-0", no_results: true } },
  });
  app.store.db.query(
    `INSERT INTO proposals (id, agent_name, key_id, op, entity_type, entity_id, payload, reason, read_set, tier, status, created_at, decided_at, decided_by)
     VALUES (?, 'sport', 'key_owner', 'create', 'event', NULL, ?, 'bad', NULL, 'public', 'pending', ?, NULL, NULL)`,
  ).run(id, payload, "2026-11-11T04:39:00.000Z");
  const rejected = await call(app, `/api/v1/proposals/${id}/approve`, { method: "POST", key: app.secrets!.owner, surface: "phone" });
  expect(rejected.status).toBe(422);
  expect(rejected.text).not.toContain("9-0");
});
