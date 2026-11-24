import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { App } from "../src/app";
import { calendarDrafts, isCalendar, parseIcs } from "../src/plugins/calendar";
import { call, NOW, testApp } from "./helpers";

// The test clock is 2026-11-11 12:39 in Perth.
const options = { now: NOW, timeZone: "Australia/Perth" };

function vcal(...events: string[][]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
}

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

async function tick(app: App, sourceId: string, ics: string) {
  const result = await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { source_id: sourceId, ics } });
  expect(result.status).toBe(200);
  return (result.json as { proposals: Array<{ id: string; op: string; external_id: string; status: string }> }).proposals;
}

async function addCalendar(app: App, body: Record<string, unknown> = {}) {
  const made = await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Example calendar", ...body } });
  expect(made.status).toBe(201);
  return (made.json as { id: string }).id;
}

function event(app: App, externalId: string) {
  return app.hmn.store.db.query("SELECT id, title, due_at, status, tier, area_id, deleted_at FROM entities WHERE external_id = ?").get(externalId) as {
    id: string;
    title: string;
    due_at: string;
    status: string;
    tier: string | null;
    area_id: string | null;
    deleted_at: string | null;
  } | null;
}

async function todayTitles(app: App, surface = "phone") {
  const today = await call(app, "/api/v1/screens/today", { key: app.secrets!.owner, surface });
  const sections = (today.json as { sections: Array<{ id: string; items: Array<{ title: string }> }> }).sections;
  return sections.find((section) => section.id === "calendar")?.items.map((item) => item.title) ?? [];
}

test("a time is read in its zone, and a time with no zone is read in the owner's zone", () => {
  const events = parseIcs(
    vcal(
      ["UID:london", "SUMMARY:London", "DTSTART;TZID=Europe/London:20261120T090000"],
      ["UID:newyork", "SUMMARY:New York", "DTSTART;TZID=America/New_York:20261120T090000"],
      ["UID:floating", "SUMMARY:Floating", "DTSTART:20261120T090000"],
      ["UID:utc", "SUMMARY:UTC", "DTSTART:20261120T090000Z"],
      ["UID:allday", "SUMMARY:All day", "DTSTART;VALUE=DATE:20261120"],
      ["UID:windows", "SUMMARY:Unknown zone", "DTSTART;TZID=Not A Zone:20261120T090000"],
    ),
    options,
  );
  const due = Object.fromEntries(events.map((item) => [item.uid, item.due]));
  expect(due.london).toBe("2026-11-20T09:00:00.000Z");
  expect(due.newyork).toBe("2026-11-20T14:00:00.000Z");
  expect(due.floating).toBe("2026-11-20T01:00:00.000Z");
  expect(due.utc).toBe("2026-11-20T09:00:00.000Z");
  expect(due.allday).toBe("2026-11-20");
  // A zone name that the runtime does not know is read as the owner's zone.
  expect(due.windows).toBe("2026-11-20T01:00:00.000Z");
  // Summer time in London is one hour ahead of UTC.
  const summer = parseIcs(vcal(["UID:s", "SUMMARY:Summer", "DTSTART;TZID=Europe/London:20260720T090000"]), { now: new Date("2026-07-01T00:00:00Z"), timeZone: "Australia/Perth" });
  expect(summer[0]?.due).toBe("2026-07-20T08:00:00.000Z");
});

test("a repeating event becomes one event for each date, with its exceptions", () => {
  const events = parseIcs(
    vcal(
      // Mondays and Wednesdays from 2 November. One Wednesday is removed, and one Monday is moved.
      ["UID:standup", "SUMMARY:Standup", "DTSTART;TZID=Australia/Perth:20261102T093000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261125T160000Z", "EXDATE;TZID=Australia/Perth:20261118T093000"],
      ["UID:standup", "SUMMARY:Standup, moved", "DTSTART;TZID=Australia/Perth:20261117T140000", "RECURRENCE-ID;TZID=Australia/Perth:20261116T093000"],
      ["UID:daily", "SUMMARY:Every second day", "DTSTART;VALUE=DATE:20261110", "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4"],
      ["UID:board", "SUMMARY:Second Tuesday", "DTSTART;VALUE=DATE:20261013", "RRULE:FREQ=MONTHLY;BYDAY=2TU"],
      ["UID:birthday", "SUMMARY:A birthday", "DTSTART;VALUE=DATE:20201120", "RRULE:FREQ=YEARLY"],
      ["UID:odd", "SUMMARY:A rule this parser does not read", "DTSTART;VALUE=DATE:20261120", "RRULE:FREQ=YEARLY;BYWEEKNO=47;BYDAY=FR"],
      ["UID:gone", "SUMMARY:Cancelled", "DTSTART;VALUE=DATE:20261120", "STATUS:CANCELLED"],
      ["UID:old", "SUMMARY:Long ago", "DTSTART;VALUE=DATE:20200101"],
      ["UID:alarm", "SUMMARY:Has an alarm\\, and a comma", "DTSTART;VALUE=DATE:20261121", "BEGIN:VALARM", "DESCRIPTION:This is an event reminder", "END:VALARM"],
    ),
    options,
  );
  const of = (prefix: string) => events.filter((item) => item.uid.startsWith(prefix)).map((item) => `${item.uid.split("#")[1] ?? ""} ${item.due} ${item.title}`);
  expect(of("standup")).toEqual([
    "20261102 2026-11-02T01:30:00.000Z Standup",
    "20261104 2026-11-04T01:30:00.000Z Standup",
    "20261109 2026-11-09T01:30:00.000Z Standup",
    "20261111 2026-11-11T01:30:00.000Z Standup",
    "20261123 2026-11-23T01:30:00.000Z Standup",
    "20261125 2026-11-25T01:30:00.000Z Standup",
    "20261116 2026-11-17T06:00:00.000Z Standup, moved",
  ]);
  expect(of("daily").map((line) => line.split(" ")[1])).toEqual(["2026-11-10", "2026-11-12", "2026-11-14", "2026-11-16"]);
  // The window starts 30 days back and ends 90 days ahead.
  expect(of("board").map((line) => line.split(" ")[1])).toEqual(["2026-10-13", "2026-11-10", "2026-12-08", "2027-01-12", "2027-02-09"]);
  expect(of("birthday").map((line) => line.split(" ")[1])).toEqual(["2026-11-20"]);
  expect(events.filter((item) => item.uid === "odd")).toHaveLength(1);
  expect(events.some((item) => item.uid === "gone" || item.uid === "old")).toBe(false);
  const alarm = events.find((item) => item.uid === "alarm")!;
  expect(alarm.title).toBe("Has an alarm, and a comma");
  expect(alarm.description).toBeNull();
});

test("an error page is not a calendar, and without a mirror nothing is changed or removed", () => {
  expect(isCalendar("<html><body>Sign in</body></html>")).toBe(false);
  expect(isCalendar("")).toBe(false);
  expect(isCalendar(vcal())).toBe(true);
  const existing = [{ id: "event_1", external_id: "a", title: "Old title", due_at: "2026-11-20", body: null, status: "upcoming" }];
  const events = parseIcs(vcal(["UID:a", "SUMMARY:New title", "DTSTART;VALUE=DATE:20261120"]), options);
  expect(calendarDrafts(events, [], "source_1", existing)).toEqual([]);
  expect(calendarDrafts([], [], "source_1", existing, { today: "2026-11-11", complete: true })).toEqual([]);
  // With a mirror, an incomplete list still does not remove an event.
  expect(calendarDrafts([], [], "source_1", existing, { today: "2026-11-11", mirror: true, complete: false })).toEqual([]);
  expect(calendarDrafts([], [], "source_1", existing, { today: "2026-11-11", mirror: true, complete: true })).toHaveLength(1);
});

test("a calendar with 40 events appears with no approvals, a changed event updates in place, and a removed event leaves Today", async () => {
  const app = testApp();
  try {
    const sourceId = await addCalendar(app, { area_id: "area_work" });
    const lines: string[][] = [];
    for (let i = 1; i <= 38; i++) {
      const day = String(11 + (i % 18)).padStart(2, "0");
      lines.push([`UID:e-${i}`, `SUMMARY:Example event ${i}`, `DTSTART;TZID=Australia/Perth:202611${day}T${String(8 + (i % 10)).padStart(2, "0")}0000`]);
    }
    lines.push(["UID:today-review", "SUMMARY:Example review today", "DTSTART;TZID=Australia/Perth:20261111T150000"]);
    lines.push(["UID:past", "SUMMARY:Example event last week", "DTSTART;VALUE=DATE:20261104"]);
    const first = await tick(app, sourceId, vcal(...lines));
    expect(first).toHaveLength(40);
    expect(first.every((item) => item.op === "create" && item.status === "approved")).toBe(true);
    const pending = await call(app, "/api/v1/proposals?status=pending&source=plugin:calendar", owner(app));
    expect((pending.json as { proposals: unknown[] }).proposals).toHaveLength(0);
    const count = () => (app.hmn.store.db.query("SELECT COUNT(*) AS n FROM entities WHERE source_id = ? AND type = 'event' AND deleted_at IS NULL").get(sourceId) as { n: number }).n;
    expect(count()).toBe(40);
    const review = event(app, "today-review")!;
    expect(review).toMatchObject({ title: "Example review today", due_at: "2026-11-11T07:00:00.000Z", status: "upcoming", area_id: "area_work" });
    expect(await todayTitles(app)).toContain("Example review today");
    const row = app.hmn.store.db.query("SELECT origin, origin_ref FROM entities WHERE id = ?").get(review.id) as { origin: string; origin_ref: string };
    expect(row).toEqual({ origin: "plugin", origin_ref: "calendar" });

    // The same calendar again changes nothing.
    expect(await tick(app, sourceId, vcal(...lines))).toHaveLength(0);

    // A new title and a new time: the same row, with a second version.
    const changed = lines.map((item) => (item[0] === "UID:today-review" ? ["UID:today-review", "SUMMARY:Example review, moved", "DTSTART;TZID=Australia/Perth:20261111T163000"] : item));
    const second = await tick(app, sourceId, vcal(...changed));
    expect(second).toEqual([expect.objectContaining({ op: "update", external_id: "today-review", status: "approved" })]);
    expect(event(app, "today-review")).toMatchObject({ id: review.id, title: "Example review, moved", due_at: "2026-11-11T08:30:00.000Z" });
    expect(count()).toBe(40);
    const history = await call(app, `/api/v1/event/${review.id}/history`, owner(app));
    expect((history.json as { versions: Array<{ title: string }> }).versions.map((version) => version.title)).toEqual(["Example review today", "Example review, moved"]);

    // The calendar drops today's review and last week's event. Only the event of today leaves.
    const removed = changed.filter((item) => item[0] !== "UID:today-review" && item[0] !== "UID:past");
    const third = await tick(app, sourceId, vcal(...removed));
    expect(third).toEqual([expect.objectContaining({ op: "update", external_id: "today-review", status: "approved" })]);
    expect(event(app, "today-review")).toMatchObject({ status: "cancelled", deleted_at: null });
    expect(event(app, "past")).toMatchObject({ status: "upcoming", deleted_at: null });
    expect(await todayTitles(app)).not.toContain("Example review, moved");
    const after = await call(app, `/api/v1/event/${review.id}/history`, owner(app));
    expect((after.json as { versions: unknown[] }).versions).toHaveLength(3);

    // The event returns to the calendar, and it returns to Today.
    await tick(app, sourceId, vcal(...changed));
    expect(event(app, "today-review")).toMatchObject({ id: review.id, status: "upcoming" });
    expect(await todayTitles(app)).toContain("Example review, moved");
  } finally {
    app.close();
  }
}, 60_000);

test("a mirrored event is read-only in HMN, and the owner can still make it more private", async () => {
  const app = testApp();
  try {
    const sourceId = await addCalendar(app, { area_id: "area_work" });
    const ics = vcal(["UID:dentist", "SUMMARY:Example appointment", "DTSTART;TZID=Australia/Perth:20261111T110000"]);
    await tick(app, sourceId, ics);
    const row = event(app, "dentist")!;

    expect((await call(app, `/api/v1/event/${row.id}`, { method: "PATCH", ...owner(app), body: { title: "My own title" } })).status).toBe(409);
    expect((await call(app, `/api/v1/event/${row.id}`, { method: "DELETE", ...owner(app) })).status).toBe(409);
    const proposed = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: app.secrets!.agent,
      surface: "mcp",
      body: { op: "update", id: row.id, patch: { title: "An agent's title" }, reason: "A test." },
    });
    expect(proposed.status).toBe(409);
    expect(event(app, "dentist")).toMatchObject({ title: "Example appointment", deleted_at: null });

    // A note and a link around the event are the owner's.
    const note = await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Bring the form", status: "open" } });
    const link = await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { rel: "about", from_type: "note", from_id: (note.json as { id: string }).id, to_type: "event", to_id: row.id } });
    expect(link.status).toBe(201);

    // The tier is the one field the owner sets. A later change in the calendar keeps it.
    expect((await call(app, `/api/v1/event/${row.id}`, { method: "PATCH", ...owner(app), body: { tier: "private" } })).status).toBe(200);
    expect(await todayTitles(app, "widget")).not.toContain("Example appointment");
    await tick(app, sourceId, ics.replace("Example appointment", "Example appointment, moved"));
    expect(event(app, "dentist")).toMatchObject({ title: "Example appointment, moved", tier: "private" });
    expect(await todayTitles(app, "widget")).not.toContain("Example appointment, moved");
    expect(await todayTitles(app, "phone")).toContain("Example appointment, moved");
  } finally {
    app.close();
  }
});

test("each calendar has its own tier and its own approval, and a family date stays Private", async () => {
  const app = testApp();
  try {
    const open = await addCalendar(app, { title: "Public holidays", area_id: "area_sport", event_tier: "public" });
    const closed = await addCalendar(app, { title: "Private calendar", area_id: "area_work", event_tier: "private" });
    const held = await addCalendar(app, { title: "A shared calendar", area_id: "area_work", approval: "review" });
    expect((await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { event_tier: "secret" } })).status).toBe(422);
    expect((await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { url: "file:///etc/passwd" } })).status).toBe(422);

    await tick(app, open, vcal(
      ["UID:holiday", "SUMMARY:Example holiday", "DTSTART;VALUE=DATE:20261111"],
      // Yves is a child in the demonstration data. A family date is Private, also from a Public calendar.
      ["UID:family", "SUMMARY:Example school play", "DTSTART;VALUE=DATE:20261111", "ATTENDEE;CN=Yves:mailto:yves@example.com"],
    ));
    await tick(app, closed, vcal(["UID:closed", "SUMMARY:Example private meeting", "DTSTART;TZID=Australia/Perth:20261111T100000"]));
    const waiting = await tick(app, held, vcal(["UID:held", "SUMMARY:Example shared event", "DTSTART;VALUE=DATE:20261111"]));

    expect(event(app, "holiday")).toMatchObject({ tier: "public", area_id: "area_sport" });
    expect(event(app, "family")).toMatchObject({ tier: "private", area_id: "area_family" });
    expect(event(app, "closed")).toMatchObject({ tier: "private", area_id: "area_work" });
    expect(waiting).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(event(app, "held")).toBeNull();

    const display = await call(app, "/api/display/today.html", { key: app.secrets!.display });
    expect(display.text).not.toContain("Example private meeting");
    expect(display.text).not.toContain("Example school play");
    expect(await todayTitles(app, "widget")).toEqual(["Example holiday"]);
    expect((await todayTitles(app, "phone")).sort()).toEqual(["Example holiday", "Example private meeting"]);

    // The owner sets the class to review. No calendar is then accepted without him.
    await call(app, "/api/v1/policy", { method: "PUT", ...owner(app), body: { source: "plugin:calendar", mode: "review" } });
    const next = await tick(app, open, vcal(
      ["UID:holiday", "SUMMARY:Example holiday", "DTSTART;VALUE=DATE:20261111"],
      ["UID:family", "SUMMARY:Example school play", "DTSTART;VALUE=DATE:20261111", "ATTENDEE;CN=Yves:mailto:yves@example.com"],
      ["UID:later", "SUMMARY:Example later holiday", "DTSTART;VALUE=DATE:20261225"],
    ));
    expect(next).toEqual([expect.objectContaining({ external_id: "later", status: "pending" })]);
    const policy = await call(app, "/api/v1/policy", owner(app));
    expect((policy.json as { defaults: Array<{ source: string; mode: string }> }).defaults.every((rule) => rule.source === "plugin:calendar" && rule.mode === "auto")).toBe(true);
  } finally {
    app.close();
  }
});

test("the calendar address is sealed, the loop reads it, and a bad reply removes nothing", async () => {
  const app = testApp();
  const realFetch = globalThis.fetch;
  const address = "https://calendar.example.com/private-SECRETTOKEN12345/basic.ics";
  let reply = vcal(["UID:net-1", "SUMMARY:Example fetched event", "DTSTART;VALUE=DATE:20261111"]);
  let status = 200;
  const asked: string[] = [];
  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(reply, { status });
    }) as typeof fetch;
    const sourceId = await addCalendar(app, { url: address.replace("https:", "webcal:"), area_id: "area_work" });

    // The address is not in a response, and it is not in the database file in the clear.
    const list = await call(app, "/api/v1/calendars", owner(app));
    expect(list.text).not.toContain("SECRETTOKEN12345");
    expect((list.json as { calendars: Array<{ has_url: boolean }> }).calendars[0]?.has_url).toBe(true);
    for (const reader of [owner(app), { key: app.secrets!.agent, surface: "mcp" }]) {
      expect((await call(app, `/api/v1/source/${sourceId}`, reader)).text).not.toContain("SECRETTOKEN12345");
    }
    expect(app.store.plainBytes().toString("latin1")).not.toContain("SECRETTOKEN12345");
    expect((await call(app, "/api/v1/calendars", { key: app.secrets!.agent, surface: "mcp" })).status).toBe(403);

    expect(await app.hmn.mirrorCalendars()).toEqual([{ id: sourceId, ok: true }]);
    expect(asked).toEqual([address]);
    expect(event(app, "net-1")).toMatchObject({ title: "Example fetched event", status: "upcoming" });
    // Inside the interval the loop does not read it again.
    expect(await app.hmn.mirrorCalendars()).toEqual([]);

    // A sign-in page, an error status, and an empty reply: the event stays.
    for (const [body, code] of [["<html>Sign in</html>", 200], ["", 200], [reply, 500]] as Array<[string, number]>) {
      reply = body;
      status = code;
      expect(await app.hmn.mirrorCalendars(true)).toEqual([{ id: sourceId, ok: false }]);
      expect(event(app, "net-1")).toMatchObject({ status: "upcoming" });
    }
    const failed = await call(app, "/api/v1/calendars", owner(app));
    expect(failed.text).not.toContain("SECRETTOKEN12345");
    expect((failed.json as { calendars: Array<{ last_sync: { ok: boolean } }> }).calendars[0]?.last_sync.ok).toBe(false);

    // A real, empty calendar is a calendar. The event of today leaves.
    reply = vcal();
    status = 200;
    expect(await app.hmn.mirrorCalendars(true)).toEqual([{ id: sourceId, ok: true }]);
    expect(event(app, "net-1")).toMatchObject({ status: "cancelled", deleted_at: null });

    // A change of the tier keeps the stored address.
    expect((await call(app, `/api/v1/calendars/${sourceId}`, { method: "POST", ...owner(app), body: { event_tier: "private" } })).status).toBe(200);
    asked.length = 0;
    await app.hmn.mirrorCalendars(true);
    expect(asked).toEqual([address]);
  } finally {
    globalThis.fetch = realFetch;
    app.close();
  }
});

test("the Week screen shows the mirrored events of the next seven days, and at most twelve of them", async () => {
  const app = testApp();
  try {
    const sourceId = await addCalendar(app);
    const week = async (surface = "phone") => {
      const reply = await call(app, "/api/v1/screens/week", { key: app.secrets!.owner, surface });
      const sections = (reply.json as { sections: Array<{ id: string; trailing?: string; items: Array<{ title: string; subtitle: string }> }> }).sections;
      return sections.find((section) => section.id === "calendar") ?? null;
    };
    expect(await week()).toBeNull();

    // Three events in the next seven days, one after them, and one last week.
    const few = [
      ["UID:w1", "SUMMARY:Example review", "DTSTART;TZID=Australia/Perth:20261112T100000", "DTEND;TZID=Australia/Perth:20261112T110000"],
      ["UID:w2", "SUMMARY:Example lunch", "DTSTART;TZID=Australia/Perth:20261113T123000"],
      ["UID:w3", "SUMMARY:Example day out", "DTSTART;VALUE=DATE:20261118"],
      ["UID:later", "SUMMARY:Example event in two weeks", "DTSTART;VALUE=DATE:20261125"],
      ["UID:before", "SUMMARY:Example event last week", "DTSTART;VALUE=DATE:20261104"],
    ];
    await tick(app, sourceId, vcal(...few));
    const three = (await week())!;
    expect(three.items.map((item) => item.title)).toEqual(["Example review", "Example lunch", "Example day out"]);
    expect(three.trailing).toBe("next 7 days");
    expect(three.items[0]!.subtitle).toContain("10:00");
    // The events are Personal. The shared display is Public and shows none.
    expect(await week("display")).toBeNull();

    // A full calendar: fourteen events. The screen shows twelve and says how many there are.
    const many = Array.from({ length: 14 }, (_, index) => [
      `UID:m${index}`,
      `SUMMARY:Example slot ${index + 1}`,
      `DTSTART;TZID=Australia/Perth:202611${12 + Math.floor(index / 2)}T${index % 2 === 0 ? "09" : "15"}0000`,
    ]);
    await tick(app, sourceId, vcal(...many));
    const full = (await week())!;
    expect(full.items.length).toBe(12);
    expect(full.trailing).toBe("12 of 14");
    expect(full.items[0]!.title).toBe("Example slot 1");
    // The three events left the calendar. They are cancelled, and they are not on the screen.
    expect(full.items.map((item) => item.title)).not.toContain("Example review");
  } finally {
    app.close();
  }
});

test("a monthly rule reads a list of weekdays and a position in the month", () => {
  const dates = (rule: string, start = "20261102") =>
    parseIcs(vcal(["UID:r", "SUMMARY:Example", `DTSTART;VALUE=DATE:${start}`, `RRULE:${rule}`]), options).map((item) => item.due);
  // The last weekday of each month. 30 November 2026 is a Monday, and 31 December is a Thursday.
  expect(dates("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3")).toEqual(["2026-11-30", "2026-12-31", "2027-01-29"]);
  // The first and the third Monday.
  expect(dates("FREQ=MONTHLY;BYDAY=1MO,3MO;COUNT=4")).toEqual(["2026-11-02", "2026-11-16", "2026-12-07", "2026-12-21"]);
  // The second Tuesday, written as a weekday and a position.
  expect(dates("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;COUNT=2")).toEqual(["2026-11-10", "2026-12-08"]);
  // Each Friday of the month.
  expect(dates("FREQ=MONTHLY;BYDAY=FR;UNTIL=20261130")).toEqual(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
  // The first and the last of the listed days of the month.
  expect(dates("FREQ=MONTHLY;BYMONTHDAY=5,15,25;BYSETPOS=1,-1;COUNT=4")).toEqual(["2026-11-05", "2026-11-25", "2026-12-05", "2026-12-25"]);
  // The last Friday still works.
  expect(dates("FREQ=MONTHLY;BYDAY=-1FR;COUNT=2")).toEqual(["2026-11-27", "2026-12-25"]);
  // A position with no list of days, and a position in a weekly rule, are not read. The event is one row on its first date.
  expect(dates("FREQ=MONTHLY;BYSETPOS=1")).toEqual(["2026-11-02"]);
  expect(dates("FREQ=WEEKLY;BYDAY=MO,WE;BYSETPOS=1")).toEqual(["2026-11-02"]);
});
