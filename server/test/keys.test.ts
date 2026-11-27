import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp, type App } from "../src/app";
import { principalFromRow, resolveCeiling } from "../src/policy";
import type { CredentialRow } from "../src/types";
import { call, testApp } from "./helpers";

function clockedApp() {
  const clock = { now: new Date("2026-11-11T04:39:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-keys-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

async function makeKey(app: App, body: Record<string, unknown>) {
  const reply = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body });
  expect(reply.status).toBe(201);
  return reply.json as { id: string; token: string; ceiling: string; keychain_item: string | null };
}

async function search(app: App, token: string, query: string) {
  const reply = await call(app, "/mcp", { method: "POST", key: token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query } } } });
  return { status: reply.status, text: reply.text };
}

test("two agents have two keys, one reads Private until its end date, and a revoke of one does not touch the other", async () => {
  const { app, clock } = clockedApp();
  try {
    const research = await makeKey(app, { name: "research" });
    const errands = await makeKey(app, { name: "errands" });
    expect(research).toMatchObject({ id: "key_research", ceiling: "personal" });
    expect(research.token).not.toBe(errands.token);
    // "Book Luca's dentist" is about a child, so it is Private. No agent reads it at the start.
    for (const key of [research, errands]) expect((await search(app, key.token, "dentist")).text).not.toContain("dentist");

    // The grant needs the owner's confirmation, and it has an end.
    const grant = (id: string, body: Record<string, unknown>) => call(app, `/api/v1/keys/${id}/private`, { method: "POST", ...owner(app), body });
    expect((await grant(research.id, { days: 30 })).status).toBe(422);
    expect((await grant(research.id, { days: 91, understood: true })).status).toBe(422);
    expect((await grant(research.id, { days: 0, understood: true })).status).toBe(422);
    const given = await grant(research.id, { days: 30, understood: true });
    expect(given.json).toMatchObject({ ceiling: "private", private_until: "2026-12-11T04:39:00.000Z" });

    expect((await search(app, research.token, "dentist")).text).toContain("Book Luca's dentist");
    expect((await search(app, errands.token, "dentist")).text).not.toContain("dentist");
    expect((await search(app, app.secrets!.agent, "dentist")).text).not.toContain("dentist");
    // Private is the limit. The Sealed note and the Health area stay closed.
    const everything = await call(app, "/api/v1/note", { key: research.token, surface: "mcp" });
    expect(everything.text).not.toContain("passport");
    expect(everything.text).not.toContain("clinic");
    expect((await call(app, "/api/v1/area/area_health", { key: research.token, surface: "mcp" })).status).toBe(404);
    // The key cannot open the vault, and the surface that it names changes nothing.
    expect((await call(app, "/api/v1/vault/grants", { method: "POST", key: research.token, surface: "phone" })).status).toBe(403);
    expect((await call(app, "/api/v1/note", { key: research.token, surface: "phone" })).text).not.toContain("passport");
    expect((await call(app, "/api/v1/task", { method: "POST", key: research.token, surface: "phone", body: { title: "A direct write", status: "open", kind: "task" } })).status).toBe(403);

    // Each key has its own read log and its own approval rule.
    const log = async (id: string) => ((await call(app, `/api/v1/access/${id}/reads`, owner(app))).json as { reads: Array<{ action: string; title: string | null }> }).reads;
    expect((await log(research.id)).some((row) => row.title === "Book Luca's dentist")).toBe(true);
    expect((await log(errands.id)).some((row) => row.title === "Book Luca's dentist")).toBe(false);
    await call(app, "/api/v1/policy", { method: "PUT", ...owner(app), body: { source: "key:key_errands", mode: "deny" } });
    const propose = (token: string) => call(app, "/api/v1/proposals", { method: "POST", key: token, surface: "mcp", body: { op: "create", entity: { type: "task", title: "Example task", status: "open", kind: "task", area_id: "area_work" } } });
    expect((await propose(errands.token)).status).toBe(403);
    expect((await propose(research.token)).status).toBe(201);

    // One day before the end the grant is open. After the end the key reads at Personal, and it still works.
    clock.now = new Date("2026-12-10T04:39:00.000Z");
    expect((await search(app, research.token, "dentist")).text).toContain("Book Luca's dentist");
    clock.now = new Date("2026-12-11T04:39:01.000Z");
    const after = await search(app, research.token, "dentist");
    expect(after.status).toBe(200);
    expect(after.text).not.toContain("dentist");
    expect((await search(app, research.token, "weekly notes")).text).toContain("Send weekly notes");
    const listed = (await call(app, "/api/v1/keys", owner(app))).json as { keys: Array<{ id: string; ceiling: string; private_until: string | null; state: string }> };
    expect(listed.keys.find((key) => key.id === research.id)).toMatchObject({ ceiling: "personal", private_until: null, state: "active" });

    // The owner gives it again and then ends it by hand.
    await grant(research.id, { days: 7, understood: true });
    expect((await search(app, research.token, "dentist")).text).toContain("dentist");
    expect((await call(app, `/api/v1/keys/${research.id}/private`, { method: "DELETE", ...owner(app) })).json).toMatchObject({ ceiling: "personal" });
    expect((await search(app, research.token, "dentist")).text).not.toContain("dentist");

    // Revoke one key. The other key and the first key of the install go on.
    await grant(research.id, { days: 7, understood: true });
    expect((await call(app, `/api/v1/access/${research.id}/revoke`, { method: "POST", ...owner(app) })).status).toBe(200);
    expect((await search(app, research.token, "weekly notes")).status).toBe(401);
    expect((await search(app, errands.token, "weekly notes")).text).toContain("Send weekly notes");
    expect((await search(app, app.secrets!.agent, "weekly notes")).text).toContain("Send weekly notes");
    expect((await grant(research.id, { days: 7, understood: true })).status).toBe(409);
    // The name is free again after the revoke.
    expect((await makeKey(app, { name: "research" })).id).not.toBe("key_research");
  } finally {
    app.close();
  }
});

test("the preview shows what Private adds, from the real graph, before the grant", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "research" });
    const preview = (await call(app, `/api/v1/keys/${key.id}/preview`, owner(app))).json as {
      reads_now: number;
      adds: number;
      by_type: Record<string, number>;
      by_area: Array<{ title: string | null; count: number }>;
      examples: Array<{ title: string }>;
      still_closed: string[];
      warnings: string[];
    };
    expect(preview.reads_now).toBe(19);
    expect(preview.adds).toBe(6);
    expect(preview.by_type).toEqual({ person: 3, goal: 1, task: 1, event: 1 });
    expect(preview.by_area.find((row) => row.title === "Family")?.count).toBeGreaterThan(0);
    expect(preview.examples).toHaveLength(5);
    expect(preview.examples.map((item) => item.title)).toContain("Book Luca's dentist");
    expect(preview.still_closed).toEqual(["Sealed rows", "areas with the role health", "areas with the role money"]);
    expect(preview.warnings[0]).toContain("model of this client");
    // The preview gives nothing. The key still reads at Personal, and the preview is not in its read log.
    expect((await search(app, key.token, "dentist")).text).not.toContain("dentist");
    const reads = (await call(app, `/api/v1/access/${key.id}/reads`, owner(app))).json as { reads: Array<{ title: string | null }> };
    expect(reads.reads.some((row) => row.title === "Book Luca's dentist")).toBe(false);
    expect((await call(app, `/api/v1/keys/${key.id}/preview`, { key: key.token, surface: "mcp" })).status).toBe(403);
  } finally {
    app.close();
  }
});

test("Health stays closed by role unless the owner opens it for one key, and limits by type hold", async () => {
  const app = testApp();
  try {
    // A health area that is Private, not Sealed. Only the role keeps an agent out of it.
    await call(app, "/api/v1/kinds", { method: "PUT", ...owner(app), body: { type: "area", kind: "fitness", role: "health" } });
    const area = await call(app, "/api/v1/area", { method: "POST", ...owner(app), body: { title: "Fitness", kind: "fitness", properties: { child_tier: "private" } } });
    const areaId = (area.json as { id: string }).id;
    await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example training plan", status: "open", area_id: areaId } });

    const coach = await makeKey(app, { name: "coach" });
    await call(app, `/api/v1/keys/${coach.id}/private`, { method: "POST", ...owner(app), body: { days: 14, understood: true } });
    expect((await search(app, coach.token, "training")).text).not.toContain("Example training plan");
    // The owner opens Health for this one key. Money stays closed.
    const changed = await call(app, `/api/v1/keys/${coach.id}`, { method: "POST", ...owner(app), body: { deny_areas: ["role:money"] } });
    expect(changed.json).toMatchObject({ deny_areas: ["role:money"], ceiling: "private" });
    expect((await search(app, coach.token, "training")).text).toContain("Example training plan");
    // The Sealed clinic note in the demonstration's Health area stays closed.
    expect((await call(app, "/api/v1/note", { key: coach.token, surface: "mcp" })).text).not.toContain("clinic");
    // The first agent key did not change.
    expect((await search(app, app.secrets!.agent, "training")).text).not.toContain("Example training plan");

    const narrow = await makeKey(app, { name: "tasks-only", allow_types: ["task"], allow_areas: ["area_work"] });
    expect((await call(app, "/api/v1/task", { key: narrow.token, surface: "mcp" })).text).toContain("Send weekly notes");
    expect(((await call(app, "/api/v1/project", { key: narrow.token, surface: "mcp" })).json as { entities: unknown[] }).entities).toEqual([]);
    expect((await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "bad", allow_areas: ["area_none"] } })).status).toBe(422);
    expect((await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "bad", allow_types: ["spaceship"] } })).status).toBe(422);
  } finally {
    app.close();
  }
});

test("a key is made with care: names, days, no Private at the start, and no key to a phone", async () => {
  const app = testApp();
  try {
    const make = (body: Record<string, unknown>, ip = "127.0.0.1") => call(app, "/api/v1/keys", { method: "POST", ...owner(app), ip, body });
    expect((await make({ name: "Has Space" })).status).toBe(422);
    expect((await make({ name: "ok", days: 0 })).status).toBe(422);
    expect((await make({ name: "ok", days: 366 })).status).toBe(422);
    expect((await make({ name: "ok", ceiling: "private" })).status).toBe(422);
    expect((await make({ name: "ok", ceiling: "sealed" })).status).toBe(422);
    const made = await make({ name: "ok", days: 10 });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ expires_at: "2026-11-21T04:39:00.000Z", deny_areas: ["role:health", "role:money"], state: "active" });
    expect((await make({ name: "ok" })).status).toBe(409);
    // The tests use no Keychain, so a caller that is not on the mini gets no key and no row.
    const before = (app.hmn.store.db.query("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n;
    const remote = await make({ name: "from-phone" }, "10.0.0.5");
    expect(remote.status).toBe(409);
    expect(remote.text).not.toContain("hmn_");
    expect((app.hmn.store.db.query("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n).toBe(before);
    // The list has no secret.
    const listed = await call(app, "/api/v1/keys", owner(app));
    expect(listed.text).not.toContain("hmn_");
    expect(listed.text).not.toContain("key_hash");
    // A key at Public cannot get the grant.
    const open = await make({ name: "public-only", ceiling: "public" });
    const publicId = (open.json as { id: string }).id;
    expect((await call(app, `/api/v1/keys/${publicId}/private`, { method: "POST", ...owner(app), body: { days: 5, understood: true } })).status).toBe(409);
    // An agent key cannot use these routes.
    const agent = { key: app.secrets!.agent, surface: "mcp" };
    expect((await call(app, "/api/v1/keys", agent)).status).toBe(403);
    expect((await call(app, "/api/v1/keys", { method: "POST", ...agent, body: { name: "sneak" } })).status).toBe(403);
    expect((await call(app, "/api/v1/keys/key_agent/private", { method: "POST", ...agent, body: { days: 90, understood: true } })).status).toBe(403);
    expect((await call(app, "/api/v1/keys/key_owner/private", { method: "POST", ...owner(app), body: { days: 5, understood: true } })).status).toBe(404);
  } finally {
    app.close();
  }
});

test("the ceiling of an agent key is one rule, for a local key and for an outside client", () => {
  const row: CredentialRow = {
    id: "k", name: "k", kind: "key", key_hash: "", scope: "agent", max_tier: "personal", vault: 1, allow_types: null, allow_areas: null, deny_areas: null,
    forced_ceiling: null, expires_at: null, created_at: "", revoked_at: null, rotated_from: null, external: 0, private_until: "2026-12-01T00:00:00.000Z",
  };
  const at = (changes: Partial<CredentialRow>, now: string, surface = "mcp") => resolveCeiling(principalFromRow({ ...row, ...changes }, now), surface as never, true);
  expect(at({}, "2026-11-30T00:00:00.000Z")).toBe("private");
  expect(at({}, "2026-12-01T00:00:00.000Z")).toBe("personal");
  expect(at({ private_until: null }, "2026-11-30T00:00:00.000Z")).toBe("personal");
  // An outside client with the grant, and with the forced ceiling that each outside client has.
  expect(at({ external: 1, forced_ceiling: "personal" }, "2026-11-30T00:00:00.000Z")).toBe("private");
  expect(at({ external: 1, forced_ceiling: "personal" }, "2026-12-02T00:00:00.000Z")).toBe("personal");
  // Public stays Public, and nothing gives Sealed: not the vault mark, not a tier in the row, not the surface.
  expect(at({ max_tier: "public" }, "2026-11-30T00:00:00.000Z")).toBe("public");
  expect(at({ forced_ceiling: "public" }, "2026-11-30T00:00:00.000Z")).toBe("public");
  expect(at({ max_tier: "sealed" }, "2026-11-30T00:00:00.000Z", "phone")).toBe("private");
  expect(at({ max_tier: "sealed", private_until: null }, "2026-11-30T00:00:00.000Z", "phone")).toBe("personal");
  expect(at({}, "2026-11-30T00:00:00.000Z", "display")).toBe("public");
  expect(at({}, "2026-11-30T00:00:00.000Z", "widget")).toBe("personal");
  // Lock is Household, even while a Private grant is open. A Public key stays Public.
  expect(at({}, "2026-11-30T00:00:00.000Z", "lock")).toBe("household");
  expect(at({ max_tier: "public" }, "2026-11-30T00:00:00.000Z", "lock")).toBe("public");
  expect(at({ forced_ceiling: "public" }, "2026-11-30T00:00:00.000Z", "lock")).toBe("public");
  // No time means no grant.
  expect(resolveCeiling(principalFromRow(row), "mcp", true)).toBe("personal");
});

test("a view key reads up to its ceiling, writes nothing, cannot get Private, and is in the read log", async () => {
  const app = testApp();
  try {
    const kitchen = await makeKey(app, { name: "kitchen", scope: "read" });
    expect(kitchen).toMatchObject({ id: "view_kitchen", scope: "read", ceiling: "public" });
    const desk = await makeKey(app, { name: "desk", scope: "read", ceiling: "personal" });
    expect(desk).toMatchObject({ id: "view_desk", scope: "read", ceiling: "personal" });
    expect((await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "bad", scope: "write" } })).status).toBe(422);
    expect((await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "bad", scope: "read", ceiling: "private" } })).status).toBe(422);

    // A Public view reads the race, and no Personal row. The surface that it names changes nothing.
    for (const surface of ["phone", "mcp", undefined]) {
      expect((await call(app, "/api/v1/event", { key: kitchen.token, surface })).text).toContain("Lakeside Grand Prix");
      const tasks = await call(app, "/api/v1/task", { key: kitchen.token, surface });
      expect(tasks.status).toBe(200);
      expect(tasks.text).not.toContain("weekly notes");
      expect(tasks.text).not.toContain("dentist");
    }
    const today = await call(app, "/api/v1/screens/today", { key: kitchen.token });
    expect(today.status).toBe(200);
    expect(today.text).not.toContain("weekly notes");
    // A Personal view reads Personal rows, and no Private row and no Health area.
    const deskTasks = await call(app, "/api/v1/task", { key: desk.token, surface: "phone" });
    expect(deskTasks.text).toContain("Send weekly notes");
    expect(deskTasks.text).not.toContain("dentist");
    expect((await call(app, "/api/v1/area/area_health", { key: desk.token })).status).toBe(404);

    // A view writes nothing: no proposal, no capture, no entity, and no tool that proposes.
    const count = (table: string) => (app.hmn.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = { proposals: count("proposals"), inbox: count("inbox_items"), entities: count("entities") };
    const entity = { type: "task", title: "From a view", status: "open", kind: "task" };
    const proposal = { op: "create", entity, reason: "A test." };
    expect((await call(app, "/api/v1/proposals", { method: "POST", key: desk.token, body: proposal })).status).toBe(403);
    expect((await call(app, "/api/v1/task", { method: "POST", key: desk.token, body: entity })).status).toBe(403);
    const rpc = (method: string, params: Record<string, unknown>) => call(app, "/mcp", { method: "POST", key: desk.token, body: { jsonrpc: "2.0", id: 1, method, params } });
    const tools = ((await rpc("tools/list", {})).json as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    expect(tools).toContain("search");
    expect(tools).toContain("proposal_status");
    expect(tools.filter((name) => name.startsWith("propose_") || name === "capture_inbox")).toEqual([]);
    expect((await rpc("tools/call", { name: "propose_create", arguments: proposal })).text).toContain("cannot propose");
    expect((await rpc("tools/call", { name: "capture_inbox", arguments: { text: "From a view" } })).text).toContain("cannot capture");
    expect({ proposals: count("proposals"), inbox: count("inbox_items"), entities: count("entities") }).toEqual(before);
    // An agent key keeps the tools that propose.
    const agentTools = ((await call(app, "/mcp", { method: "POST", key: app.secrets!.agent, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } })).json as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    expect(agentTools).toContain("propose_create");

    // No Private grant, no preview of one, and no vault.
    const grant = await call(app, `/api/v1/keys/${desk.id}/private`, { method: "POST", ...owner(app), body: { days: 5, understood: true } });
    expect(grant.status).toBe(409);
    expect(grant.text).toContain("view_key");
    expect((await call(app, `/api/v1/keys/${desk.id}/preview`, owner(app))).status).toBe(409);
    expect((await call(app, "/api/v1/vault/grants", { method: "POST", key: desk.token, surface: "phone" })).status).toBe(403);

    // The owner sees what each view read.
    const reads = await call(app, `/api/v1/access/${kitchen.id}/reads`, owner(app));
    expect(reads.status).toBe(200);
    expect(reads.text).toContain("event_race");
    expect(reads.text).not.toContain("hmn_");

    // The list of keys has the two views, with their scope and no secret.
    const listed = await call(app, "/api/v1/keys", owner(app));
    const keys = (listed.json as { keys: Array<{ id: string; scope: string }> }).keys;
    expect(keys.filter((key) => key.scope === "read").map((key) => key.id)).toEqual(expect.arrayContaining(["view_kitchen", "view_desk"]));
    expect(keys.find((key) => key.id === "key_agent")?.scope).toBe("agent");
    expect(listed.text).not.toContain("hmn_");

    // A revoke stops one view and leaves the other.
    expect((await call(app, `/api/v1/devices/${kitchen.id}/revoke`, { method: "POST", ...owner(app) })).status).toBe(200);
    expect((await call(app, "/api/v1/event", { key: kitchen.token })).status).toBe(401);
    expect((await call(app, "/api/v1/event", { key: desk.token })).status).toBe(200);
  } finally {
    app.close();
  }
});
