// The cost of a request, and floods. A read saves nothing. A key that is not the owner's has a budget. A declined
// proposal keeps a short record. Each test starts its own graph.
import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { handleExternal } from "../src/external/http";
import { call } from "./helpers";

function clockedApp() {
  const clock = { now: new Date("2026-11-11T04:39:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-floods-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  return { app, clock };
}

const fileHash = (app: App) => createHash("sha256").update(readFileSync(app.store.encPath)).digest("hex");
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function propose(app: App, key: string, title: string, body?: string) {
  return call(app, "/api/v1/proposals", {
    method: "POST",
    key,
    surface: "mcp",
    body: { op: "create", payload: { op: "create", entity: { type: "task", title, ...(body ? { body } : {}) } }, reason: "A test." },
  });
}

test("a request that changes nothing does not write the graph again", async () => {
  const { app } = clockedApp();
  try {
    const start = fileHash(app);
    for (let i = 0; i < 50; i++) expect((await call(app, "/health", { ip: "10.2.2.2" })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call(app, "/api/v1/me", { ip: "10.2.2.2" })).status).toBe(401);
    expect(fileHash(app)).toBe(start);

    // The first use of a key records the time. Later reads in the next ten minutes change nothing.
    await call(app, "/api/v1/me", { key: app.secrets!.display });
    await wait(1100);
    app.hmn.saveSoon();
    const used = fileHash(app);
    for (let i = 0; i < 20; i++) expect((await call(app, "/api/v1/me", { key: app.secrets!.display })).status).toBe(200);
    expect(app.store.dirty()).toBe(false);
    expect(fileHash(app)).toBe(used);
  } finally {
    app.close();
  }
});

test("changes in quick steps are saved together, at most one second after the last save", async () => {
  const { app } = clockedApp();
  try {
    // A bad token writes an audit row. That is a change, and the first one is saved at once.
    await call(app, "/api/v1/me", { key: "hmn_bad_1", ip: "10.3.3.3" });
    expect(app.store.dirty()).toBe(false);
    const first = fileHash(app);
    await call(app, "/api/v1/me", { key: "hmn_bad_2", ip: "10.3.3.3" });
    await call(app, "/api/v1/me", { key: "hmn_bad_3", ip: "10.3.3.3" });
    expect(app.store.dirty()).toBe(true);
    expect(fileHash(app)).toBe(first);
    await wait(1200);
    expect(app.store.dirty()).toBe(false);
    expect(fileHash(app)).not.toBe(first);
  } finally {
    app.close();
  }
});

test("a key has a budget for proposals, and the owner has none", async () => {
  const { app, clock } = clockedApp();
  try {
    const agent = app.secrets!.agent;
    const huge = await propose(app, agent, "Too long", "x".repeat(40_000));
    expect(huge.status).toBe(413);

    for (let i = 0; i < 60; i++) expect((await propose(app, agent, `Errand ${i}`)).status).toBe(201);
    const fast = await propose(app, agent, "One more");
    expect(fast.status).toBe(429);
    expect((fast.json as { error: { code: string } }).error.code).toBe("rate");

    // An hour later the rate allows more, until 100 wait for the owner.
    clock.now = new Date(clock.now.getTime() + 61 * 60_000);
    for (let i = 60; i < 100; i++) expect((await propose(app, agent, `Errand ${i}`)).status).toBe(201);
    const full = await propose(app, agent, "One more");
    expect(full.status).toBe(429);
    expect((full.json as { error: { code: string } }).error.code).toBe("queue_full");

    // A decision makes room.
    const one = app.store.db.query("SELECT id FROM proposals WHERE status = 'pending' AND source LIKE 'key:%' AND agent_name != 'Trip helper' LIMIT 1").get() as { id: string };
    expect((await call(app, `/api/v1/proposals/${one.id}/reject`, { method: "POST", key: app.secrets!.owner, surface: "phone" })).status).toBe(200);
    expect((await propose(app, agent, "After a decision")).status).toBe(201);

    // The owner's own key has no budget.
    for (let i = 0; i < 3; i++) expect((await propose(app, app.secrets!.owner, `Owner ${i}`, "y".repeat(40_000))).status).toBe(201);
  } finally {
    app.close();
  }
});

test("a declined proposal keeps its title and loses the rest of its text", async () => {
  const { app } = clockedApp();
  try {
    const made = await propose(app, app.secrets!.agent, "Read the long article", "z".repeat(30_000));
    expect(made.status).toBe(201);
    const id = (made.json as { id: string }).id;
    const before = app.store.db.query("SELECT LENGTH(payload) AS n FROM proposals WHERE id = ?").get(id) as { n: number };
    expect(before.n).toBeGreaterThan(30_000);
    expect((await call(app, `/api/v1/proposals/${id}/reject`, { method: "POST", key: app.secrets!.owner, surface: "phone" })).status).toBe(200);
    const after = app.store.db.query("SELECT LENGTH(payload) AS n, read_set FROM proposals WHERE id = ?").get(id) as { n: number; read_set: string | null };
    expect(after.n).toBeLessThan(500);
    expect(after.read_set).toBeNull();
    const activity = await call(app, "/api/v1/activity", { key: app.secrets!.owner, surface: "phone" });
    expect(activity.text).toContain("Read the long article");
    expect(activity.text).not.toContain("zzzz");
  } finally {
    app.close();
  }
});

test("a key has a budget for the inbox", async () => {
  const { app } = clockedApp();
  try {
    const send = (key: string, text: string) => call(app, "/api/v1/inbox", { method: "POST", key, surface: "mcp", body: { text } });
    for (let i = 0; i < 50; i++) expect((await send(app.secrets!.agent, `Note ${i}`)).status).toBe(201);
    const full = await send(app.secrets!.agent, "One more");
    expect(full.status).toBe(429);
    expect((await send(app.secrets!.owner, "The owner can always write")).status).toBe(201);
  } finally {
    app.close();
  }
});

test("only ten outside clients can wait for a sign-in", async () => {
  const { app } = clockedApp();
  try {
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const register = async () => {
      const response = await handleExternal(
        app.hmn,
        new Request("https://hmn.local/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Probe", redirect_uris: ["https://example.test/cb"] }) }),
        "203.0.113.9",
      );
      return response.status;
    };
    for (let i = 0; i < 10; i++) expect(await register()).toBe(201);
    expect(await register()).toBe(429);
    // A client that did not sign in within an hour is removed, and makes room.
    app.store.db.query("UPDATE external_oauth_clients SET created_at = '2000-01-01T00:00:00.000Z'").run();
    expect(await register()).toBe(201);
    expect((app.store.db.query("SELECT COUNT(*) AS n FROM external_oauth_clients").get() as { n: number }).n).toBe(1);
  } finally {
    app.close();
  }
});
