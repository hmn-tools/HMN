import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { handleExternal } from "../src/external/http";
import { parseIcs } from "../src/plugins/calendar";
import { call, NOW, testApp } from "./helpers";

// The test clock is 2026-11-11 12:39 in Perth. The week in these tests starts on Monday 16 November.
const ZONE = "TZID=Australia/Perth";

function vcal(...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
}

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

async function addCalendar(app: App, body: Record<string, unknown>) {
  const made = await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Example calendar", ...body } });
  expect(made.status).toBe(201);
  return (made.json as { id: string }).id;
}

async function tick(app: App, sourceId: string, ics: string) {
  const result = await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { source_id: sourceId, ics } });
  expect(result.status).toBe(200);
}

const WEEK = [
  ["UID:dentist", "SUMMARY:Example dentist", `DTSTART;${ZONE}:20261116T090000`, `DTEND;${ZONE}:20261116T100000`],
  // It overlaps the first event.
  ["UID:review", "SUMMARY:Example review", `DTSTART;${ZONE}:20261116T093000`, `DTEND;${ZONE}:20261116T110000`],
  // It starts at the instant at which the second event ends.
  ["UID:lunch", "SUMMARY:Example lunch", `DTSTART;${ZONE}:20261116T110000`, "DURATION:PT1H"],
  // The owner marked this one as free.
  ["UID:hold", "SUMMARY:Example hold", `DTSTART;${ZONE}:20261116T140000`, `DTEND;${ZONE}:20261116T150000`, "TRANSP:TRANSPARENT"],
  // A day with no time is free, unless the calendar says that it is busy.
  ["UID:birthday", "SUMMARY:Example birthday", "DTSTART;VALUE=DATE:20261117"],
  ["UID:leave", "SUMMARY:Example leave", "DTSTART;VALUE=DATE:20261118", "DTEND;VALUE=DATE:20261119", "TRANSP:OPAQUE"],
  // A time with no end has no length, so it is not a busy time.
  ["UID:reminder", "SUMMARY:Example reminder", `DTSTART;${ZONE}:20261119T150000`],
];

async function busy(app: App, key: string, from: string, to: string) {
  const reply = await call(app, `/api/v1/free-busy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { key, surface: "phone" });
  return { status: reply.status, text: reply.text, json: reply.json as { from: string; to: string; busy: Array<{ start: string; end: string }> } };
}

test("the parser reads the end of an event and whether the event is busy", () => {
  const events = parseIcs(vcal(...WEEK), { now: NOW, timeZone: "Australia/Perth" });
  const by = Object.fromEntries(events.map((item) => [item.uid, item]));
  expect(by.dentist).toMatchObject({ due: "2026-11-16T01:00:00.000Z", end: "2026-11-16T02:00:00.000Z", busy: true });
  expect(by.lunch).toMatchObject({ due: "2026-11-16T03:00:00.000Z", end: "2026-11-16T04:00:00.000Z", busy: true });
  expect(by.hold).toMatchObject({ end: "2026-11-16T07:00:00.000Z", busy: false });
  // The end of a day with no time is the next day. It is not in the event.
  expect(by.birthday).toMatchObject({ due: "2026-11-17", end: "2026-11-18", busy: false });
  expect(by.leave).toMatchObject({ due: "2026-11-18", end: "2026-11-19", busy: true });
  expect(by.reminder).toMatchObject({ due: "2026-11-19T07:00:00.000Z", end: null });
});

test("busy times are joined intervals with no title, only from a calendar that the owner switched on", async () => {
  const app = testApp();
  try {
    // The shared calendar is Private. The owner chose to give its busy times, and no other fact about it.
    const shared = await addCalendar(app, { title: "Example shared calendar", event_tier: "private", free_busy: true });
    const closed = await addCalendar(app, { title: "Example closed calendar" });
    await tick(app, shared, vcal(...WEEK));
    await tick(app, closed, vcal(["UID:secret", "SUMMARY:Example secret", `DTSTART;${ZONE}:20261120T090000`, `DTEND;${ZONE}:20261120T100000`]));
    const listed = await call(app, "/api/v1/calendars", owner(app));
    const flags = Object.fromEntries((listed.json as { calendars: Array<{ id: string; free_busy: boolean }> }).calendars.map((item) => [item.id, item.free_busy]));
    expect(flags[shared]).toBe(true);
    expect(flags[closed]).toBe(false);

    const week = await busy(app, app.secrets!.owner, "2026-11-16", "2026-11-22");
    expect(week.status).toBe(200);
    // A date is a day in the owner's zone.
    expect(week.json.from).toBe("2026-11-15T16:00:00.000Z");
    expect(week.json.to).toBe("2026-11-22T16:00:00.000Z");
    // Three events are one interval. The answer does not show how many events there are.
    expect(week.json.busy).toEqual([
      { start: "2026-11-16T01:00:00.000Z", end: "2026-11-16T04:00:00.000Z" },
      { start: "2026-11-17T16:00:00.000Z", end: "2026-11-18T16:00:00.000Z" },
    ]);
    expect(Object.keys(week.json.busy[0]!).sort()).toEqual(["end", "start"]);
    expect(week.text).not.toContain("Example");
    expect(week.text).not.toContain("entity_");
    expect(week.text).not.toContain(shared);

    // An interval is cut at the ends of the range.
    const part = await busy(app, app.secrets!.owner, "2026-11-16T02:00:00Z", "2026-11-16T03:30:00Z");
    expect(part.json.busy).toEqual([{ start: "2026-11-16T02:00:00.000Z", end: "2026-11-16T03:30:00.000Z" }]);

    // An event that left the calendar is cancelled, and it is not a busy time.
    await tick(app, shared, vcal(...WEEK.filter((lines) => lines[0] !== "UID:lunch")));
    const later = await busy(app, app.secrets!.owner, "2026-11-16", "2026-11-16");
    expect(later.json.busy).toEqual([{ start: "2026-11-16T01:00:00.000Z", end: "2026-11-16T03:00:00.000Z" }]);

    // The owner switches the calendar off. Its times leave the answer.
    await call(app, `/api/v1/calendars/${shared}`, { method: "POST", ...owner(app), body: { free_busy: false } });
    expect((await busy(app, app.secrets!.owner, "2026-11-16", "2026-11-22")).json.busy).toEqual([]);

    expect((await busy(app, app.secrets!.owner, "2026-11-16", "2027-02-01")).status).toBe(422);
    expect((await busy(app, app.secrets!.owner, "2026-11-22", "2026-11-16")).status).toBe(422);
    expect((await busy(app, app.secrets!.owner, "next week", "2026-11-16")).status).toBe(422);
  } finally {
    app.close();
  }
});

test("an agent key reads busy times only after the owner turns that on for the key", async () => {
  const app = testApp();
  try {
    const shared = await addCalendar(app, { event_tier: "private", free_busy: true });
    await tick(app, shared, vcal(...WEEK));
    const made = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "planner" } });
    const key = made.json as { id: string; token: string };
    const tools = async () => {
      const reply = await call(app, "/mcp", { method: "POST", key: key.token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      return (reply.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((item) => item.name);
    };
    const ask = () => call(app, "/mcp", { method: "POST", key: key.token, body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "free_busy", arguments: { from: "2026-11-16", to: "2026-11-22" } } } });

    expect(await tools()).not.toContain("free_busy");
    const refused = await ask();
    expect(refused.text).toContain("cannot read busy times");
    expect(refused.text).not.toContain("2026-11-16T01:00:00.000Z");
    expect((await busy(app, key.token, "2026-11-16", "2026-11-22")).status).toBe(403);

    const changed = await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { free_busy: true } });
    expect(changed.status).toBe(200);
    expect(await tools()).toContain("free_busy");
    const allowed = await ask();
    expect(allowed.text).toContain("2026-11-16T01:00:00.000Z");
    expect(allowed.text).not.toContain("Example");
    // The key is Personal, and the calendar is Private. The key still cannot read the events.
    const search = await call(app, "/mcp", { method: "POST", key: key.token, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "dentist" } } } });
    expect(search.text).not.toContain("Example dentist");
    // The read is in the list of what the key read.
    const reads = app.hmn.store.db.query("SELECT action FROM client_reads WHERE principal_id = ?").all(key.id) as Array<{ action: string }>;
    expect(reads.map((row) => row.action)).toContain("free_busy");
  } finally {
    app.close();
  }
});

async function external(app: App, options: { token: string; session?: string; body: unknown }) {
  const headers = new Headers({ authorization: `Bearer ${options.token}`, "content-type": "application/json" });
  if (options.session) headers.set("mcp-session-id", options.session);
  const response = await handleExternal(app.hmn, new Request("https://hmn.local/external/mcp", { method: "POST", headers, body: JSON.stringify(options.body) }), "203.0.113.8");
  return { status: response.status, text: await response.text(), session: response.headers.get("mcp-session-id") };
}

async function guestSession(app: App, body: Record<string, unknown>) {
  const minted = await call(app, "/api/v1/external/clients", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1", body });
  expect(minted.status).toBe(201);
  const client = minted.json as { id: string; token: string; ceiling: string; guest: boolean; free_busy: boolean };
  const init = await external(app, { token: client.token, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  expect(init.status).toBe(200);
  let id = 1;
  const rpc = (method: string, params?: unknown) => external(app, { token: client.token, session: init.session!, body: { jsonrpc: "2.0", id: (id += 1), method, params } });
  const tool = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args });
  return { client, rpc, tool };
}

test("a friend's agent gets the owner's free time with no titles, proposes a meeting, and the owner approves it", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const shared = await addCalendar(app, { free_busy: true });
    await tick(app, shared, vcal(...WEEK));

    // A guest is Public. A request for a higher ceiling changes nothing.
    const { client, rpc, tool } = await guestSession(app, { name: "Example friend", guest: true, free_busy: true, ceiling: "personal" });
    expect(client).toMatchObject({ ceiling: "public", guest: true, free_busy: true });

    const tools = (await rpc("tools/list")).text;
    for (const name of ["free_busy", "propose_create", "proposal_status", "capture_inbox"]) expect(tools).toContain(`"name":"${name}"`);
    for (const name of ["propose_update", "propose_delete", "propose_link", "list_proposals"]) expect(tools).not.toContain(`"name":"${name}"`);

    const times = await tool("free_busy", { from: "2026-11-16", to: "2026-11-22" });
    expect(times.text).toContain("2026-11-16T01:00:00.000Z");
    expect(times.text).toContain("2026-11-16T04:00:00.000Z");
    expect(times.text).not.toContain("Example dentist");
    expect(times.text).not.toContain("Example review");
    // The guest cannot read the events. The calendar is Personal, and the guest is Public.
    expect((await tool("search", { query: "dentist" })).text).not.toContain("Example dentist");
    expect((await tool("list_entities", { type: "event" })).text).not.toContain("Example dentist");

    // The guest proposes a meeting in a free hour. Each field that is not the title, the time, or the text is dropped.
    const proposed = await tool("propose_create", {
      entity: {
        type: "event",
        title: "Coffee with an example friend",
        body: "At the example cafe.",
        due_at: "2026-11-17T06:00:00Z",
        kind: "fixture",
        status: "past",
        tier: "public",
        area_id: "area_work",
        properties: { end_at: "2026-11-17T07:00:00Z", mirror: true, busy: true },
      },
      links: [{ to_id: "person_self", type: "with" }],
      reason: "A free hour on Tuesday.",
    });
    expect(proposed.text).toContain("pending");
    const row = app.hmn.store.db.query("SELECT id, tier, status, source FROM proposals WHERE key_id = ?").get(client.id) as { id: string; tier: string; status: string; source: string };
    expect(row).toMatchObject({ tier: "personal", status: "pending", source: `key:${client.id}` });
    expect((await tool("proposal_status", { id: row.id })).text).toContain("pending");

    // The owner sees it in the review list on the phone, and approves it.
    const queue = await call(app, "/api/v1/proposals", owner(app));
    expect(queue.text).toContain("Coffee with an example friend");
    const approved = await call(app, `/api/v1/proposals/${row.id}/approve`, { method: "POST", ...owner(app) });
    expect(approved.status).toBe(200);
    // The Activity list and the rules list give the name of the key, so that the phone does not show its id.
    const decided = ((await call(app, "/api/v1/activity", owner(app))).json as { activity: Array<Record<string, unknown>> }).activity.find((item) => item.id === row.id)!;
    expect(decided).toMatchObject({ source: `key:${client.id}`, source_guest: true });
    expect(typeof decided.source_name).toBe("string");
    expect(String(decided.source_name)).not.toContain("external:");
    expect(String(decided.source_name)).not.toContain(client.id);
    const known = ((await call(app, "/api/v1/policy", owner(app))).json as { sources: Array<Record<string, unknown>> }).sources;
    expect(known.find((item) => item.source === `key:${client.id}`)).toMatchObject({ source_name: decided.source_name, source_guest: true });
    expect(known.find((item) => item.source === "worker:morning")).toMatchObject({ source_name: null, source_guest: false });
    const made = app.hmn.store.db.query("SELECT id, kind, status, area_id, due_at, properties FROM entities WHERE title = ?").get("Coffee with an example friend") as {
      id: string;
      kind: string;
      status: string;
      area_id: string | null;
      due_at: string;
      properties: string;
    };
    expect(made).toMatchObject({ kind: "appointment", status: "upcoming", area_id: null, due_at: "2026-11-17T06:00:00Z" });
    expect(JSON.parse(made.properties)).toEqual({ end_at: "2026-11-17T07:00:00Z" });
    const links = app.hmn.store.db.query("SELECT COUNT(*) AS n FROM links WHERE from_id = ? OR to_id = ?").get(made.id, made.id) as { n: number };
    expect(links.n).toBe(0);

    // The guest learns that the owner said yes. It does not get the event, which is Personal.
    const status = await tool("proposal_status", { id: row.id });
    expect(status.text).toContain("approved");
    expect(status.text).not.toContain(made.id);
    expect((await tool("get_entity", { id: made.id })).text).not.toContain("Coffee");

    // A guest proposes an event, and no other thing.
    const task = await tool("propose_create", { entity: { type: "task", title: "Example errand", status: "open", kind: "task" } });
    expect(task.text).toContain("A guest can propose an event");
    expect((await tool("propose_update", { id: made.id, patch: { title: "Changed" } })).status).toBe(400);
    expect((await tool("list_proposals", {})).status).toBe(400);
    const tasks = app.hmn.store.db.query("SELECT COUNT(*) AS n FROM proposals WHERE key_id = ?").get(client.id) as { n: number };
    expect(tasks.n).toBe(1);

    // A guest can leave a short message in the inbox.
    const note = await tool("capture_inbox", { text: "x".repeat(5000) });
    expect(note.status).toBe(200);
    const inbox = app.hmn.store.db.query("SELECT body, origin FROM inbox_items ORDER BY captured_at DESC LIMIT 1").get() as { body: string; origin: string };
    expect(inbox.origin).toBe("agent");
    expect(inbox.body.length).toBeLessThanOrEqual(2000);

    // The owner sees that the key is a guest, and can stop its busy times.
    const keys = await call(app, "/api/v1/keys", owner(app));
    expect(keys.text).toContain('"guest":true');
    const off = await call(app, `/api/v1/keys/${client.id}`, { method: "POST", ...owner(app), body: { free_busy: false } });
    expect(off.status).toBe(200);
    expect((await tool("free_busy", { from: "2026-11-16", to: "2026-11-22" })).text).toContain("cannot read busy times");
  } finally {
    app.close();
  }
});

test("a guest with no permission for busy times does not see the tool", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const shared = await addCalendar(app, { free_busy: true });
    await tick(app, shared, vcal(...WEEK));
    const { client, rpc, tool } = await guestSession(app, { name: "Example stranger", guest: true });
    expect(client).toMatchObject({ ceiling: "public", guest: true, free_busy: false });
    expect((await rpc("tools/list")).text).not.toContain('"name":"free_busy"');
    const refused = await tool("free_busy", { from: "2026-11-16", to: "2026-11-22" });
    expect(refused.text).toContain("cannot read busy times");
    expect(refused.text).not.toContain("2026-11-16T01:00:00.000Z");
  } finally {
    app.close();
  }
});
