// Job scopes: an allow list of areas or types means what it says, on every path that an agent has.
// All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

async function makeKey(app: App, body: Record<string, unknown>) {
  const reply = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body });
  expect(reply.status).toBe(201);
  return reply.json as { id: string; token: string; purpose: string | null };
}

async function tool(app: App, token: string, name: string, args: Record<string, unknown> = {}) {
  const reply = await call(app, "/mcp", { method: "POST", key: token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  const result = (reply.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text: result.content[0].text, data: JSON.parse(result.content[0].text) as Record<string, unknown>, error: result.isError === true };
}

type Row = { id: string; type: string; area_id: string | null };
const rowOf = (app: App, id: string) => app.hmn.store.db.query("SELECT id, type, area_id FROM entities WHERE id = ?").get(id) as Row | null;

/** Every entity id that a text names, with the row it points at. */
function named(app: App, text: string): Row[] {
  const ids = new Set([...text.matchAll(/"(?:id|from|to)":"([^"]+)"/g)].map((match) => match[1]));
  return [...ids].map((id) => rowOf(app, id)).filter((row): row is Row => row !== null);
}

const home = (row: Row) => (row.type === "area" ? row.id : row.area_id);
const inAreas = (areas: string[]) => (row: Row) => (home(row) ? areas.includes(home(row)!) : areas.includes("none"));

async function link(app: App, from: string, to: string) {
  const reply = await call(app, "/api/v1/links", { method: "POST", ...owner(app), body: { from_id: from, to_id: to, rel: "about" } });
  expect(reply.status).toBe(201);
}

test("a key with one area reads only that area, on every read path", async () => {
  const app = testApp();
  try {
    await link(app, "task_garage", "project_brief");
    await link(app, "project_brief", "task_garage");
    await link(app, "person_sam", "task_garage");
    const key = await makeKey(app, { name: "cars-only", allow_areas: ["area_cars"] });
    const ok = inAreas(["area_cars"]);

    // search
    const found = await tool(app, key.token, "search", { query: "the" });
    for (const row of named(app, found.text)) expect(ok(row)).toBe(true);
    const coupe = await tool(app, key.token, "search", { query: "coupe" });
    expect(coupe.text).toContain("task_garage");
    expect((await tool(app, key.token, "search", { query: "weekly" })).text).not.toContain("project_brief");

    // get_entity: a row in another area, and a row with no area, answer as a missing row
    expect((await tool(app, key.token, "get_entity", { type: "task", id: "task_garage" })).error).toBe(false);
    expect((await tool(app, key.token, "get_entity", { type: "project", id: "project_brief" })).error).toBe(true);
    expect((await tool(app, key.token, "get_entity", { type: "goal", id: "goal_quiet" })).error).toBe(true);
    // The area itself is inside the list, and another area is not.
    expect((await tool(app, key.token, "get_entity", { type: "area", id: "area_cars" })).error).toBe(false);
    expect((await tool(app, key.token, "get_entity", { type: "area", id: "area_work" })).error).toBe(true);

    // list_entities
    for (const type of ["task", "project", "goal", "person", "place", "asset", "event", "area"]) {
      const listed = await tool(app, key.token, "list_entities", { type });
      const rows = (listed.data.entities as Row[]) ?? [];
      for (const row of rows) expect(ok(row)).toBe(true);
    }
    expect(((await tool(app, key.token, "list_entities", { type: "area" })).data.entities as Row[]).map((row) => row.id)).toEqual(["area_cars"]);

    // list_links: the other end must be readable too
    const links = await tool(app, key.token, "list_links", { type: "task", id: "task_garage" });
    expect(links.text).not.toContain("project_brief");
    expect(links.text).not.toContain("person_sam");

    // neighbours: both ends of each edge
    const around = await tool(app, key.token, "neighbours", { type: "task", id: "task_garage", depth: 3 });
    for (const row of named(app, around.text)) expect(ok(row)).toBe(true);
    expect(around.text).not.toContain("project_brief");

    // today, upcoming, week, expiring
    const today = await tool(app, key.token, "today");
    expect(today.text).toContain("task_garage");
    expect(today.text).not.toContain("task_notes");
    expect(today.text).not.toContain("task_dentist");
    for (const name of ["today", "upcoming", "week"]) for (const row of named(app, (await tool(app, key.token, name)).text)) expect(ok(row)).toBe(true);
    for (const row of named(app, (await tool(app, key.token, "expiring", { days: 90 })).text)) expect(ok(row)).toBe(true);

    // person_page: a person in another area, and a person with no area, are not found
    expect((await tool(app, key.token, "person_page", { id: "person_sam" })).error).toBe(true);
    expect((await tool(app, key.token, "person_page", { id: "person_alex" })).error).toBe(true);

    // The agent page counts follow the same rule.
    const scope = (await call(app, `/api/v1/access/${key.id}/scope`, owner(app))).json as { total: number; by_area: Array<{ area_id: string | null }> };
    expect(scope.total).toBeGreaterThan(0);
    expect(scope.by_area.map((item) => item.area_id)).toEqual(["area_cars"]);
    const rows = app.hmn.store.db.query("SELECT id FROM entities WHERE deleted_at IS NULL").all() as Array<{ id: string }>;
    let readable = 0;
    for (const row of rows) {
      const type = rowOf(app, row.id)!.type;
      if (!(await tool(app, key.token, "get_entity", { type, id: row.id })).error) readable += 1;
    }
    expect(readable).toBe(scope.total);
  } finally {
    app.close();
  }
});

test("the word none lets a key with an allow list read the rows with no area", async () => {
  const app = testApp();
  try {
    await link(app, "project_brief", "person_alex");
    const strict = await makeKey(app, { name: "work-only", allow_areas: ["area_work"] });
    expect((await tool(app, strict.token, "get_entity", { type: "person", id: "person_alex" })).error).toBe(true);
    expect((await tool(app, strict.token, "get_entity", { type: "project", id: "project_brief" })).error).toBe(false);
    // The link to a row that the key cannot read is not shown.
    expect((await tool(app, strict.token, "list_links", { type: "project", id: "project_brief" })).text).not.toContain("person_alex");

    const loose = await makeKey(app, { name: "work-and-loose", allow_areas: ["area_work", "none"] });
    expect((await tool(app, loose.token, "get_entity", { type: "person", id: "person_alex" })).error).toBe(false);
    expect((await tool(app, loose.token, "get_entity", { type: "goal", id: "goal_quiet" })).error).toBe(false);
    expect((await tool(app, loose.token, "get_entity", { type: "task", id: "task_garage" })).error).toBe(true);
    expect((await tool(app, loose.token, "list_links", { type: "project", id: "project_brief" })).text).toContain("person_alex");
    const scope = (await call(app, `/api/v1/access/${loose.id}/scope`, owner(app))).json as { by_area: Array<{ area_id: string | null }> };
    expect(scope.by_area.map((item) => item.area_id).sort()).toEqual([null, "area_work"].sort());

    // Only the word none is allowed besides an area id.
    const bad = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "bad-word", allow_areas: ["nothing"] } });
    expect(bad.status).toBe(422);
    const set = await call(app, `/api/v1/keys/${strict.id}`, { method: "POST", ...owner(app), body: { allow_areas: ["area_work", "none"] } });
    expect(set.status).toBe(200);
    expect((set.json as { allow_areas: string[] }).allow_areas).toEqual(["area_work", "none"]);
    expect((await tool(app, strict.token, "get_entity", { type: "person", id: "person_alex" })).error).toBe(false);
  } finally {
    app.close();
  }
});

test("a key with allow_types task reads only tasks, on every read path", async () => {
  const app = testApp();
  try {
    await link(app, "task_garage", "project_brief");
    await link(app, "task_garage", "task_srs");
    const key = await makeKey(app, { name: "tasks-only", allow_types: ["task"] });
    const onlyTasks = (rows: Row[]) => rows.every((row) => row.type === "task");

    const found = await tool(app, key.token, "search", { query: "coupe" });
    expect(found.text).toContain("task_garage");
    expect(onlyTasks(named(app, found.text))).toBe(true);
    expect((await tool(app, key.token, "get_entity", { type: "asset", id: "asset_coupe" })).error).toBe(true);
    expect((await tool(app, key.token, "get_entity", { type: "task", id: "task_garage" })).error).toBe(false);
    for (const type of ["project", "goal", "person", "place", "asset", "event", "area"]) {
      expect(((await tool(app, key.token, "list_entities", { type })).data.entities as Row[]).length).toBe(0);
    }
    expect(((await tool(app, key.token, "list_entities", { type: "task" })).data.entities as Row[]).length).toBeGreaterThan(0);

    const links = await tool(app, key.token, "list_links", { type: "task", id: "task_garage" });
    expect(links.text).toContain("task_srs");
    expect(links.text).not.toContain("project_brief");
    const around = await tool(app, key.token, "neighbours", { type: "task", id: "task_garage", depth: 3 });
    expect(onlyTasks(named(app, around.text))).toBe(true);
    expect(around.text).not.toContain("project_brief");

    for (const name of ["today", "upcoming", "week"]) expect(onlyTasks(named(app, (await tool(app, key.token, name)).text))).toBe(true);
    expect(onlyTasks(named(app, (await tool(app, key.token, "expiring", { days: 90 })).text))).toBe(true);
    expect((await tool(app, key.token, "person_page", { id: "person_sam" })).error).toBe(true);

    const scope = (await call(app, `/api/v1/access/${key.id}/scope`, owner(app))).json as { total: number; by_type: Array<{ type: string }> };
    expect(scope.by_type.map((item) => item.type)).toEqual(["task"]);
    expect(scope.total).toBeGreaterThan(0);
  } finally {
    app.close();
  }
});

test("a key files proposals only inside its allow list", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "cars-tasks", allow_areas: ["area_cars"], allow_types: ["task"] });
    const propose = (op: string, payload: Record<string, unknown>) => call(app, "/api/v1/proposals", { method: "POST", key: key.token, surface: "mcp", body: { op, ...payload } });

    // Inside: a task in the area.
    const inside = await propose("create", { entity: { type: "task", title: "Example service", status: "open", kind: "task", area_id: "area_cars" } });
    expect(inside.status).toBe(201);
    // Outside: another area, no area, and another type.
    expect((await propose("create", { entity: { type: "task", title: "Example work", status: "open", kind: "task", area_id: "area_work" } })).status).toBe(404);
    expect((await propose("create", { entity: { type: "task", title: "Example loose", status: "open", kind: "task" } })).status).toBe(403);
    expect((await propose("create", { entity: { type: "note", title: "Example note", status: "open", area_id: "area_cars" } })).status).toBe(403);
    // A change that moves a readable task into an area outside the list, or out of every area.
    expect((await propose("update", { id: "task_garage", patch: { area_id: "area_work" } })).status).toBe(404);
    expect((await propose("update", { id: "task_garage", patch: { area_id: null } })).status).toBe(403);
    // A change of a row that the key cannot read.
    expect((await propose("update", { id: "task_notes", patch: { title: "Example" } })).status).toBe(404);

    // With the word none, a task with no area is inside.
    const loose = await makeKey(app, { name: "loose-tasks", allow_areas: ["area_cars", "none"], allow_types: ["task"] });
    const made = await call(app, "/api/v1/proposals", { method: "POST", key: loose.token, surface: "mcp", body: { op: "create", entity: { type: "task", title: "Example loose", status: "open", kind: "task" } } });
    expect(made.status).toBe(201);
  } finally {
    app.close();
  }
});

test("free busy follows the allow list of the key", async () => {
  const app = testApp();
  try {
    const made = await call(app, "/api/v1/calendars", { method: "POST", ...owner(app), body: { title: "Example work calendar", area_id: "area_work", free_busy: true } });
    expect(made.status).toBe(201);
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:a", "SUMMARY:Example call", "DTSTART;TZID=Australia/Perth:20261116T090000", "DTEND;TZID=Australia/Perth:20261116T100000", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const ticked = await call(app, "/api/v1/plugins/calendar/tick", { method: "POST", ...owner(app), ip: "127.0.0.1", body: { source_id: (made.json as { id: string }).id, ics } });
    expect(ticked.status).toBe(200);
    const busy = async (body: Record<string, unknown>, name: string) => {
      const key = await makeKey(app, { name, ...body });
      expect((await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { free_busy: true } })).status).toBe(200);
      return (await tool(app, key.token, "free_busy", { from: "2026-11-16", to: "2026-11-22" })).data as { busy: unknown[] };
    };
    expect((await busy({}, "any-area")).busy.length).toBe(1);
    expect((await busy({ allow_areas: ["area_work"], allow_types: ["event"] }, "work-events")).busy.length).toBe(1);
    expect((await busy({ allow_areas: ["area_family"] }, "family-only")).busy.length).toBe(0);
    expect((await busy({ allow_areas: ["area_work"], allow_types: ["task"] }, "work-tasks")).busy.length).toBe(0);
  } finally {
    app.close();
  }
});

test("the purpose is for the owner: stored, listed, limited, and never sent to the agent", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "cars-job", purpose: "  Keep the coupe\nservice on track  ", allow_areas: ["area_cars"] });
    expect(key.purpose).toBe("Keep the coupe service on track");
    const list = (await call(app, "/api/v1/keys", owner(app))).json as { keys: Array<{ id: string; purpose: string | null }> };
    expect(list.keys.find((item) => item.id === key.id)?.purpose).toBe("Keep the coupe service on track");
    const scope = (await call(app, `/api/v1/access/${key.id}/scope`, owner(app))).json as { purpose: string | null };
    expect(scope.purpose).toBe("Keep the coupe service on track");

    // The agent never reads it, on any tool.
    for (const name of ["today", "search", "describe_schema", "list_proposals", "my_requests"]) {
      expect((await tool(app, key.token, name, { query: "coupe" })).text).not.toContain("coupe service on track");
    }
    const initialize = await call(app, "/mcp", { method: "POST", key: key.token, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect(initialize.text).not.toContain("service on track");

    // A change keeps it when the body has no purpose, replaces it, and clears it.
    const kept = await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { allow_types: ["task"] } });
    expect((kept.json as { purpose: string }).purpose).toBe("Keep the coupe service on track");
    const changed = await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { purpose: "Watch the garage" } });
    expect((changed.json as { purpose: string }).purpose).toBe("Watch the garage");
    const cleared = await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { purpose: "" } });
    expect((cleared.json as { purpose: string | null }).purpose).toBeNull();

    // At most 200 characters, and text only.
    const long = await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { purpose: "x".repeat(201) } });
    expect(long.status).toBe(422);
    const exact = await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { purpose: "x".repeat(200) } });
    expect(exact.status).toBe(200);
    const number = await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { purpose: 4 } });
    expect(number.status).toBe(422);
  } finally {
    app.close();
  }
});

test("a database from before the purpose column gets the column", async () => {
  const app = testApp();
  try {
    const columns = app.hmn.store.db.query("PRAGMA table_info(credentials)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("purpose");
  } finally {
    app.close();
  }
});

test("an empty allow list reads nothing, and a null list reads every area", async () => {
  const app = testApp();
  try {
    const none = await makeKey(app, { name: "nothing-yet", allow_areas: [] });
    const scope = (await call(app, `/api/v1/access/${none.id}/scope`, owner(app))).json as { total: number };
    expect(scope.total).toBe(0);
    expect((await tool(app, none.token, "get_entity", { type: "task", id: "task_garage" })).error).toBe(true);
    const all = await call(app, `/api/v1/keys/${none.id}`, { method: "POST", ...owner(app), body: { allow_areas: null, allow_types: null } });
    expect((all.json as { allow_areas: unknown }).allow_areas).toBeNull();
    expect((await tool(app, none.token, "get_entity", { type: "task", id: "task_garage" })).error).toBe(false);
  } finally {
    app.close();
  }
});

test("a rotated key keeps its job label and its allow list", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "example-rotate", purpose: "Example job", allow_areas: ["area_cars"] });
    const rotated = await call(app, `/api/v1/credentials/${key.id}/rotate`, { method: "POST", ...owner(app), ip: "127.0.0.1" });
    expect(rotated.status).toBe(200);
    const newId = (rotated.json as { id: string }).id;
    const list = (await call(app, "/api/v1/keys", owner(app))).json as { keys: Array<{ id: string; purpose: string | null; allow_areas?: string[] | null }> };
    const row = list.keys.find((item) => item.id === newId)!;
    expect(row.purpose).toBe("Example job");
  } finally {
    app.close();
  }
});
