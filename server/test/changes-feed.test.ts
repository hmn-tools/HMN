// The feed of changes: a key that the owner marks as "keeps memory" can ask for each row that changed.
// All data is fictional.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp, type App } from "../src/app";
import { issueBearer } from "../src/external/clients";
import { principalFromRow } from "../src/policy";
import type { CredentialRow } from "../src/types";
import { call } from "./helpers";

function clockedApp() {
  const clock = { now: new Date("2026-11-11T04:39:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-feed-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

async function makeKey(app: App, body: Record<string, unknown>) {
  const reply = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body });
  expect(reply.status).toBe(201);
  return reply.json as { id: string; token: string; memory: boolean };
}

async function setMemory(app: App, id: string, memory: boolean) {
  return call(app, `/api/v1/keys/${id}`, { method: "POST", ...owner(app), body: { memory } });
}

async function tool(app: App, token: string, name: string, args: Record<string, unknown> = {}) {
  const reply = await call(app, "/mcp", { method: "POST", key: token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  const result = (reply.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { data: JSON.parse(result.content[0].text) as Record<string, any>, error: result.isError === true };
}

async function toolNames(app: App, token: string) {
  const reply = await call(app, "/mcp", { method: "POST", key: token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  return (reply.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((item) => item.name);
}

async function make(app: App, type: string, body: Record<string, unknown>) {
  const reply = await call(app, `/api/v1/${type}`, { method: "POST", ...owner(app), body });
  expect(reply.status).toBe(201);
  return (reply.json as { id: string }).id;
}

const patch = (app: App, type: string, id: string, body: Record<string, unknown>) => call(app, `/api/v1/${type}/${id}`, { method: "PATCH", ...owner(app), body });

type Change = { id: string; type: string; change: string; at: string; entity?: { title: string } };

test("a key without memory does not see the tool and is refused", async () => {
  const { app } = clockedApp();
  const key = await makeKey(app, { name: "plain" });
  expect(key.memory).toBe(false);
  expect(await toolNames(app, key.token)).not.toContain("changes_since");
  const refused = await tool(app, key.token, "changes_since", {});
  expect(refused.error).toBe(true);
  expect(refused.data.error).toContain("does not keep its own memory");
});

test("a memory key gets a cursor, then a created, a changed, and a removed row", async () => {
  const { app } = clockedApp();
  const changed = await make(app, "task", { title: "Example old task", status: "open", tier: "personal" });
  const gone = await make(app, "task", { title: "Example doomed task", status: "open", tier: "personal" });
  const key = await makeKey(app, { name: "keeper", memory: true });
  expect(key.memory).toBe(true);
  expect(await toolNames(app, key.token)).toContain("changes_since");

  // The first call has no history. It gives a cursor and no rows.
  const first = await tool(app, key.token, "changes_since", {});
  expect(first.data.changes).toEqual([]);
  expect(first.data.more).toBe(false);
  expect(typeof first.data.cursor).toBe("string");

  const created = await make(app, "task", { title: "Example new task", status: "open", tier: "personal" });
  await patch(app, "task", changed, { title: "Example renamed task" });
  expect((await call(app, `/api/v1/task/${gone}`, { method: "DELETE", ...owner(app) })).status).toBe(200);

  const next = await tool(app, key.token, "changes_since", { cursor: first.data.cursor });
  const changes = next.data.changes as Change[];
  expect(changes.map((item) => [item.id, item.change])).toEqual([
    [created, "created"],
    [changed, "changed"],
    [gone, "removed"],
  ]);
  expect(changes[0]!.entity!.title).toBe("Example new task");
  expect(changes[1]!.entity!.title).toBe("Example renamed task");
  expect(changes[2]!.entity).toBeUndefined();
  expect(next.data.more).toBe(false);

  // The same cursor again gives nothing new.
  const again = await tool(app, key.token, "changes_since", { cursor: next.data.cursor });
  expect(again.data.changes).toEqual([]);

  // A bad cursor and a bad limit are refused with a plain message.
  expect((await tool(app, key.token, "changes_since", { cursor: "nonsense" })).error).toBe(true);
  expect((await tool(app, key.token, "changes_since", { cursor: next.data.cursor, limit: 500 })).error).toBe(true);
});

test("a page is cut by the limit and more says that rows wait", async () => {
  const { app } = clockedApp();
  const key = await makeKey(app, { name: "pager", memory: true });
  const start = (await tool(app, key.token, "changes_since", {})).data.cursor as string;
  for (const n of [1, 2, 3]) await make(app, "task", { title: `Example page task ${n}`, status: "open", tier: "personal" });
  const one = await tool(app, key.token, "changes_since", { cursor: start, limit: 2 });
  expect(one.data.changes).toHaveLength(2);
  expect(one.data.more).toBe(true);
  const two = await tool(app, key.token, "changes_since", { cursor: one.data.cursor, limit: 2 });
  expect(two.data.changes).toHaveLength(1);
  expect(two.data.more).toBe(false);
});

test("a row raised to Private leaves as removed with no entity", async () => {
  const { app } = clockedApp();
  const id = await make(app, "note", { title: "Example shared note", status: "open", tier: "personal" });
  const key = await makeKey(app, { name: "forgetter", memory: true });
  const start = (await tool(app, key.token, "changes_since", {})).data.cursor as string;
  await patch(app, "note", id, { tier: "private" });
  const got = await tool(app, key.token, "changes_since", { cursor: start });
  const changes = got.data.changes as Change[];
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ id, change: "removed" });
  expect(changes[0]!.entity).toBeUndefined();
  expect(JSON.stringify(got.data)).not.toContain("Example shared note");
});

test("a row outside the allow list never appears, and a row the key never saw is not removed", async () => {
  const { app } = clockedApp();
  const hidden = await make(app, "task", { title: "Example work secret", status: "open", tier: "personal", area_id: "area_work" });
  const key = await makeKey(app, { name: "cars-keeper", memory: true, allow_areas: ["area_cars"] });
  const start = (await tool(app, key.token, "changes_since", {})).data.cursor as string;

  const outside = await make(app, "task", { title: "Example work item", status: "open", tier: "personal", area_id: "area_work" });
  const inside = await make(app, "task", { title: "Example car item", status: "open", tier: "personal", area_id: "area_cars" });
  await patch(app, "task", hidden, { title: "Example work secret, edited" });
  await call(app, `/api/v1/task/${outside}`, { method: "DELETE", ...owner(app) });
  // A row that had no area and never was in view, now raised: still nothing.
  const private1 = await make(app, "task", { title: "Example private item", status: "open", tier: "private", area_id: "area_cars" });
  await patch(app, "task", private1, { title: "Example private item, edited" });
  await call(app, `/api/v1/task/${private1}`, { method: "DELETE", ...owner(app) });

  const got = await tool(app, key.token, "changes_since", { cursor: start });
  const changes = got.data.changes as Change[];
  expect(changes.map((item) => [item.id, item.change])).toEqual([[inside, "created"]]);
  const text = JSON.stringify(got.data);
  for (const id of [hidden, outside, private1]) expect(text).not.toContain(id);

  // A row that leaves the allowed area is removed, because the key could read it before.
  await patch(app, "task", inside, { area_id: "area_work" });
  const moved = await tool(app, key.token, "changes_since", { cursor: got.data.cursor });
  expect((moved.data.changes as Change[]).map((item) => [item.id, item.change])).toEqual([[inside, "removed"]]);
});

test("the daily limit stops the feed and says when it resets", async () => {
  const { app, clock } = clockedApp();
  const key = await makeKey(app, { name: "greedy", memory: true });
  const start = (await tool(app, key.token, "changes_since", {})).data.cursor as string;
  for (const n of [1, 2, 3]) await make(app, "task", { title: `Example bulk task ${n}`, status: "open", tier: "personal" });
  // The key has read 1,999 rows in this day already.
  app.hmn.store.db.query("INSERT INTO feed_log (at, key_name, n) VALUES (?, 'greedy', 1999)").run(clock.now.toISOString());
  const last = await tool(app, key.token, "changes_since", { cursor: start });
  expect(last.data.changes).toHaveLength(1);
  expect(last.data.more).toBe(true);
  const over = await tool(app, key.token, "changes_since", { cursor: last.data.cursor });
  expect(over.error).toBe(true);
  expect(over.data.error).toContain("limit");
  expect(over.data.error).toContain("2026-11-12T04:39:00.000Z");
  // After 24 hours the count is gone.
  clock.now = new Date(clock.now.getTime() + 25 * 3_600_000);
  const later = await tool(app, key.token, "changes_since", { cursor: last.data.cursor });
  expect(later.error).toBe(false);
  expect(later.data.changes).toHaveLength(2);
});

test("a rotation keeps the daily count", async () => {
  const { app, clock } = clockedApp();
  const key = await makeKey(app, { name: "rotator", memory: true });
  const start = (await tool(app, key.token, "changes_since", {})).data.cursor as string;
  await make(app, "task", { title: "Example rotate task", status: "open", tier: "personal" });
  app.hmn.store.db.query("INSERT INTO feed_log (at, key_name, n) VALUES (?, 'rotator', 2000)").run(clock.now.toISOString());
  const rotated = await call(app, `/api/v1/credentials/${key.id}/rotate`, { method: "POST", ...owner(app) });
  const secret = (rotated.json as { secret: string }).secret;
  expect((await tool(app, secret, "changes_since", { cursor: start })).error).toBe(true);
});

test("reads are logged as one grouped line on the agent page", async () => {
  const { app } = clockedApp();
  const key = await makeKey(app, { name: "logged", memory: true });
  const start = (await tool(app, key.token, "changes_since", {})).data.cursor as string;
  for (const n of [1, 2, 3]) await make(app, "task", { title: `Example logged task ${n}`, status: "open", tier: "personal" });
  await tool(app, key.token, "changes_since", { cursor: start });
  const reads = app.hmn.store.db.query("SELECT action FROM client_reads WHERE principal_id = ? ORDER BY seq").all(key.id) as Array<{ action: string }>;
  expect(reads.filter((row) => row.action === "read")).toHaveLength(3);
  expect(reads.filter((row) => row.action === "changes_since")).toHaveLength(2);
  const timeline = await call(app, `/api/v1/access/${key.id}/timeline`, { ...owner(app) });
  const lines = (timeline.json as { items: Array<{ kind: string; text: string }> }).items.filter((item) => item.kind === "read").map((item) => item.text);
  expect(lines).toContain("Asked for what changed: 3 rows");
});

test("the owner turns memory on and off, and each change is in the audit log", async () => {
  const { app } = clockedApp();
  const key = await makeKey(app, { name: "toggle" });
  const scopeOf = async () => (await call(app, `/api/v1/access/${key.id}/scope`, { ...owner(app) })).json as { memory: boolean };
  expect((await scopeOf()).memory).toBe(false);
  expect((await setMemory(app, key.id, true)).status).toBe(200);
  expect((await scopeOf()).memory).toBe(true);
  const list = (await call(app, "/api/v1/keys", { ...owner(app) })).json as { keys: Array<{ id: string; memory: boolean }> };
  expect(list.keys.find((item) => item.id === key.id)!.memory).toBe(true);
  expect(await toolNames(app, key.token)).toContain("changes_since");
  expect((await setMemory(app, key.id, false)).status).toBe(200);
  expect(await toolNames(app, key.token)).not.toContain("changes_since");
  expect((await tool(app, key.token, "changes_since", {})).error).toBe(true);
  const audit = app.hmn.store.db.query("SELECT action FROM audit_log WHERE action IN ('memory_on', 'memory_off') AND entity_id = ? ORDER BY seq").all(key.id) as Array<{ action: string }>;
  expect(audit.map((row) => row.action)).toEqual(["memory_on", "memory_off"]);
  // A change that keeps the value writes no memory row.
  await setMemory(app, key.id, false);
  expect(app.hmn.store.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'memory_%'").get()).toEqual({ n: 2 });
  expect((await call(app, `/api/v1/keys/${key.id}`, { method: "POST", ...owner(app), body: { memory: "yes" } })).status).toBe(422);
});

test("rotate keeps memory", async () => {
  const { app } = clockedApp();
  const key = await makeKey(app, { name: "keeps", memory: true });
  const rotated = await call(app, `/api/v1/credentials/${key.id}/rotate`, { method: "POST", ...owner(app) });
  expect(rotated.status).toBe(200);
  const next = rotated.json as { id: string; secret: string };
  const list = (await call(app, "/api/v1/keys", { ...owner(app) })).json as { keys: Array<{ id: string; memory: boolean; state: string }> };
  expect(list.keys.find((item) => item.id === next.id)!.memory).toBe(true);
  expect(await toolNames(app, next.secret)).toContain("changes_since");
});

test("an outside client, a guest, and a view key never get memory", async () => {
  const { app } = clockedApp();
  const outside = issueBearer(app.hmn, "Example outside", "personal");
  expect((await setMemory(app, outside.id, true)).status).toBe(409);
  const guest = issueBearer(app.hmn, "Example guest", "public", { guest: true });
  expect((await setMemory(app, guest.id, true)).status).toBe(409);
  const view = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "a-view", scope: "read", memory: true } });
  expect(view.status).toBe(409);
  // Even a row that is marked in the database does not give the feed to such a key.
  const row = app.hmn.store.db.query("SELECT * FROM credentials WHERE id = ?").get(outside.id) as CredentialRow;
  expect(principalFromRow({ ...row, memory: 1 }).memory).toBe(false);
  expect(principalFromRow({ ...row, memory: 1, external: 0, guest: 1 }).memory).toBe(false);
});
