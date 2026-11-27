// The fixes from the review of 2026-11-27: an undo cannot bring a row back without its area, a real calendar day,
// events of several days, kinds already in use, and what a guest, a view key, and a hidden phone can read or send.
// All data is fictional.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app";
import { handleExternal } from "../src/external/http";
import { ensureKindTables } from "../src/kinds";
import { readableDue } from "../src/time";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
const MINI = "127.0.0.1";

test("an undo does not bring back a row whose area was removed, and a write names a live area", async () => {
  const app = testApp();
  try {
    const area = (await call(app, "/api/v1/area", { method: "POST", ...owner(app), body: { title: "Example area", kind: "other" } })).json as { id: string };
    const note = (await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example note in an area", area_id: area.id, tier: "personal" } })).json as { id: string };
    const proposed = await call(app, "/api/v1/proposals", { method: "POST", key: app.secrets!.agent, surface: "mcp", body: { op: "delete", id: note.id, reason: "A test." } });
    expect(proposed.status).toBe(201);
    const id = (proposed.json as { id: string }).id;
    expect((await call(app, `/api/v1/proposals/${id}/approve`, { method: "POST", ...owner(app) })).status).toBe(200);
    // The area is empty now, so it can go.
    expect((await call(app, `/api/v1/area/${area.id}`, { method: "DELETE", ...owner(app) })).status).toBe(200);
    const undo = await call(app, `/api/v1/proposals/${id}/undo`, { method: "POST", ...owner(app) });
    expect(undo.status).toBe(409);
    expect(undo.text).toContain("area");
    expect((await call(app, "/api/v1/task/task_notes", { method: "PATCH", ...owner(app), body: { area_id: "area_nowhere" } })).status).toBe(422);
  } finally {
    app.close();
  }
});

test("a day must be on the calendar", async () => {
  expect(readableDue("2026-02-31")).toBe(false);
  expect(readableDue("2026-02-28")).toBe(true);
  expect(readableDue("2028-02-29")).toBe(true);
  expect(readableDue("2026-02-31T10:00:00Z")).toBe(false);
  const app = testApp();
  try {
    expect((await call(app, "/api/v1/task/task_notes", { method: "PATCH", ...owner(app), body: { due_at: "2026-02-31" } })).status).toBe(422);
    const yearly = (birthday: string) => call(app, "/api/v1/person/person_sam", { method: "PATCH", ...owner(app), body: { properties_patch: { birthday } } });
    expect((await yearly("02-30")).status).toBe(422);
    expect((await yearly("02-29")).status).toBe(200);
  } finally {
    app.close();
  }
});

function clocked(iso: string, timeZone: string) {
  return createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-fix-")), kek: randomBytes(32), now: () => new Date(iso), timeZone });
}

test("an event of several days stays while it is on, and a zone behind UTC keeps the whole week", async () => {
  // Wednesday 11 November, 12:00 in Perth.
  const app = clocked("2026-11-11T04:00:00.000Z", "Australia/Perth");
  try {
    await call(app, "/api/v1/event", { method: "POST", ...owner(app), body: { title: "Example school camp", kind: "family", status: "upcoming", due_at: "2026-11-10", properties: { end_at: "2026-11-13" } } });
    for (const id of ["today", "upcoming", "week"]) {
      const screen = (await call(app, `/api/v1/screens/${id}`, owner(app))).json as { sections: Array<{ items: Array<{ title: string }> }> };
      expect(screen.sections.flatMap((section) => section.items.map((item) => item.title)).join(" ")).toContain("Example school camp");
    }
  } finally {
    app.close();
  }
  // Monday 16 November, 18:00 in Los Angeles: already Tuesday in UTC.
  const west = clocked("2026-11-17T02:00:00.000Z", "America/Los_Angeles");
  try {
    await call(west, "/api/v1/event", { method: "POST", ...owner(west), body: { title: "Example dinner in a week", kind: "family", status: "upcoming", due_at: "2026-11-23" } });
    const week = (await call(west, "/api/v1/screens/week", owner(west))).json as { sections: Array<{ items: Array<{ title: string }> }> };
    expect(week.sections.flatMap((section) => section.items.map((item) => item.title))).toContain("Example dinner in a week");
  } finally {
    west.close();
  }
});

test("a note of a kind that the table did not have can still be saved", async () => {
  const app = testApp();
  try {
    const made = (await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example meeting note" } })).json as { id: string };
    // A row from before note kinds, with a kind of its own.
    app.hmn.store.db.query("UPDATE entities SET kind = 'meeting' WHERE id = ?").run(made.id);
    app.hmn.store.db.query("DELETE FROM meta WHERE key = 'kinds_used_v2'").run();
    ensureKindTables(app.hmn.store.db);
    expect((await call(app, `/api/v1/note/${made.id}`, { method: "PATCH", ...owner(app), body: { title: "Example meeting note, renamed" } })).status).toBe(200);
  } finally {
    app.close();
  }
});

test("a view key reads the shape only, and a hidden phone shows no request", async () => {
  const app = testApp();
  try {
    const view = (await call(app, "/api/v1/schema", { key: app.secrets!.display })).json as { kinds: unknown[]; kind_fields: unknown[]; statuses: Record<string, string[]> };
    expect(view.kinds).toEqual([]);
    expect(view.kind_fields).toEqual([]);
    expect(view.statuses.task).toBeTruthy();
    const agent = (await call(app, "/api/v1/schema", { key: app.secrets!.agent })).json as { kinds: unknown[] };
    expect(agent.kinds.length).toBeGreaterThan(0);

    const code = (await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: MINI })).json as { code: string };
    const phone = (await call(app, "/api/v1/pair", { method: "POST", ip: "10.1.1.9", body: { code: code.code, device_name: "Example phone" } })).json as { secret: string };
    expect((await call(app, "/api/v1/agent-requests", { key: phone.secret, surface: "phone", ip: "10.1.1.9" })).status).toBe(200);
    await call(app, "/api/v1/panic", { method: "POST", key: phone.secret, surface: "phone", ip: "10.1.1.9" });
    expect((await call(app, "/api/v1/agent-requests", { key: phone.secret, surface: "phone", ip: "10.1.1.9" })).status).not.toBe(200);
  } finally {
    app.close();
  }
});

test("a guest cannot send a request", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/external/enable", { method: "POST", key: app.secrets!.owner, ip: MINI });
    const minted = (await call(app, "/api/v1/external/clients", { method: "POST", key: app.secrets!.owner, ip: MINI, body: { name: "Example guest", guest: true } })).json as { token: string };
    const post = async (body: unknown, session?: string) => {
      const headers = new Headers({ authorization: `Bearer ${minted.token}`, "content-type": "application/json" });
      if (session) headers.set("mcp-session-id", session);
      const response = await handleExternal(app.hmn, new Request("https://hmn.local/external/mcp", { method: "POST", headers, body: JSON.stringify(body) }), "203.0.113.8");
      return { text: await response.text(), session: response.headers.get("mcp-session-id") ?? session };
    };
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const asked = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "request_feature", arguments: { need: "Example need", why: "A test." } } }, init.session ?? undefined);
    // The outside port does not offer the tool. If it ever does, the key is still refused.
    expect(asked.text).toMatch(/Unknown tool|cannot send a request/);
    const list = (await call(app, "/api/v1/agent-requests", owner(app))).json as { requests: unknown[] };
    expect(list.requests).toHaveLength(0);
  } finally {
    app.close();
  }
});
