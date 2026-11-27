import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

test("lock, standby, and the next-event payload stay at household, never personal or private", async () => {
  const lock = await call(app, "/api/v1/screens/lock", { key: app.secrets!.owner, surface: "phone" });
  expect(lock.status).toBe(200);
  expect(lock.text).toContain("Lakeside Grand Prix");
  expect(lock.text).not.toContain("no results");
  expect((lock.json as { due_count: number; ceiling: string }).due_count).toBe(0);
  expect((lock.json as { ceiling: string }).ceiling).toBe("household");
  for (const word of ["Yves", "Luca", "Alex", "dentist", "weekly notes", "SRS", "passport", "clinic"]) {
    expect(lock.text.includes(word), word).toBe(false);
  }
  const paired = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
  const device = await call(app, "/api/v1/pair", {
    method: "POST",
    ip: "10.8.8.8",
    body: { code: (paired.json as { code: string }).code, device_name: "Lock" },
  });
  const secret = (device.json as { secret: string }).secret;
  const grant = await call(app, "/api/v1/vault/grants", { method: "POST", key: secret, surface: "phone" });
  const withGrant = await call(app, "/api/v1/screens/lock", {
    key: secret,
    surface: "phone",
    grant: (grant.json as { grant: string }).grant,
  });
  expect(withGrant.text).not.toContain("Yves");
  expect(withGrant.text).not.toContain("passport");
  expect(withGrant.text).toContain("Lakeside Grand Prix");
});

test("a habit check-in has no streak", async () => {
  const created = await call(app, "/api/v1/habit", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { title: "Morning stretch", status: "active", properties: { cadence: "daily", time_of_day: "morning", streak: 9 } },
  });
  expect(created.status).toBe(201);
  const id = (created.json as { id: string }).id;
  const checked = await call(app, `/api/v1/habits/${id}/check-in`, { method: "POST", key: app.secrets!.owner, surface: "phone" });
  expect(checked.status).toBe(200);
  expect(checked.text).not.toContain("streak");
  expect(checked.text).toContain("2026-11-11");
  const today = await call(app, "/api/v1/screens/today", { key: app.secrets!.owner, surface: "phone" });
  expect(today.text).toContain("Morning stretch");
  expect(today.text).toContain("daily · morning");
  expect(today.text).not.toContain("streak");
  const display = await call(app, "/api/display/today.html", { key: app.secrets!.owner, surface: "phone" });
  expect(display.text).not.toContain("Morning stretch");
  const widget = await call(app, "/api/v1/screens/today", { key: app.secrets!.owner, surface: "widget" });
  expect(widget.text).toContain("Morning stretch");
});

test("proposal links can be edited and inherit the stricter tier", async () => {
  const proposed = await call(app, "/api/v1/proposals", {
    method: "POST",
    key: app.secrets!.agent,
    surface: "mcp",
    agent: "Trip helper",
    body: {
      op: "create",
      entity: { type: "task", title: "File the brief", status: "open", kind: "task", area_id: "area_work" },
      reason: "A work task.",
    },
  });
  expect(proposed.status).toBe(201);
  const id = (proposed.json as { id: string }).id;
  const blocked = await call(app, `/api/v1/proposals/${id}`, {
    method: "PATCH",
    key: app.secrets!.owner,
    surface: "phone",
    body: { links: [{ rel: "about", to_type: "note", to_id: "note_trip" }] },
  });
  expect(blocked.status).toBe(403);
  const paired = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
  const device = await call(app, "/api/v1/pair", {
    method: "POST",
    ip: "10.4.4.4",
    body: { code: (paired.json as { code: string }).code, device_name: "Editor" },
  });
  const secret = (device.json as { secret: string }).secret;
  const grant = await call(app, "/api/v1/vault/grants", { method: "POST", key: secret, surface: "phone" });
  const token = (grant.json as { grant: string }).grant;
  const edited = await call(app, `/api/v1/proposals/${id}`, {
    method: "PATCH",
    key: secret,
    surface: "phone",
    grant: token,
    body: { links: [{ rel: "about", to_type: "note", to_id: "note_trip" }] },
  });
  expect(edited.status).toBe(200);
  expect((edited.json as { tier: string }).tier).toBe("sealed");
  expect(edited.text).toContain("note_trip");
});

test("health summaries are sealed and drop numbers unless asked", async () => {
  const denied = await call(app, "/api/v1/plugins/health/submit", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { summaries: [{ id: "hk-steps", label: "Steps", day: "2026-11-11", value: 432198765, samples: [1, 2, 3] }] },
  });
  expect(denied.status).toBe(403);
  expect(denied.text).not.toContain("432198765");
  const paired = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
  const device = await call(app, "/api/v1/pair", {
    method: "POST",
    ip: "10.5.5.5",
    body: { code: (paired.json as { code: string }).code, device_name: "Health" },
  });
  const secret = (device.json as { secret: string }).secret;
  const grant = await call(app, "/api/v1/vault/grants", { method: "POST", key: secret, surface: "phone" });
  const token = (grant.json as { grant: string }).grant;
  const quiet = await call(app, "/api/v1/plugins/health/submit", {
    method: "POST",
    key: secret,
    surface: "phone",
    grant: token,
    body: { summaries: [{ id: "hk-steps", label: "Steps", day: "2026-11-11", value: 432198765, unit: "count", samples: [9, 8] }] },
  });
  expect(quiet.status).toBe(201);
  expect(quiet.text).not.toContain("432198765");
  expect(quiet.text).not.toContain("[9,8]");
  expect(app.store.plainBytes().toString("utf8")).not.toContain("432198765");
  const opted = await call(app, "/api/v1/plugins/health/submit", {
    method: "POST",
    key: secret,
    surface: "phone",
    grant: token,
    body: { include_samples: true, summaries: [{ id: "hk-steps-opt", label: "Steps", day: "2026-11-11", value: 432198765, unit: "count", samples: [9] }] },
  });
  expect(opted.status).toBe(201);
  const optedId = (opted.json as { proposals: Array<{ id: string }> }).proposals[0]?.id;
  const opened = await call(app, "/api/v1/proposals", { key: secret, surface: "phone", grant: token });
  expect(opened.text).toContain("432198765");
  expect(opened.text).not.toContain("\"samples\"");
  const approved = await call(app, `/api/v1/proposals/${optedId}/approve`, {
    method: "POST",
    key: secret,
    surface: "phone",
    grant: token,
  });
  expect(approved.status).toBe(200);
  const agent = await call(app, "/api/v1/search?q=Steps", { key: app.secrets!.agent, surface: "mcp" });
  expect(agent.text).not.toContain("Steps");
  const display = await call(app, "/api/display/today.html", { key: app.secrets!.display });
  expect(display.text).not.toContain("Steps");
  expect(display.text).not.toContain("432198765");
});
