// View tools for agents: today, upcoming, week, person_page, expiring. All data is fictional.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createApp, type App } from "../src/app";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
type View = { title: string; summary: string; sections: Array<{ id: string; label: string; items: Array<{ id: string; type: string | null; title: string; subtitle: string; done?: boolean }> }> };

let rpcId = 0;
async function tool(app: App, key: string, name: string, args: Record<string, unknown> = {}) {
  rpcId += 1;
  const reply = await call(app, "/mcp", { method: "POST", key, body: { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } } });
  const result = (reply.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { data: JSON.parse(result.content[0]!.text) as any, isError: result.isError === true, text: result.content[0]!.text };
}
const ids = (view: View) => view.sections.flatMap((section) => section.items.map((item) => item.id));
const titles = (view: View) => view.sections.flatMap((section) => section.items.map((item) => item.title));
const ownerToday = async (app: App) => ((await call(app, "/api/v1/screens/today", owner(app))).json as { sections: Array<{ items: Array<{ id: string }> }> }).sections.flatMap((s) => s.items.map((i) => i.id));

test("the agent's today has no row above its ceiling, and the owner's has more", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Example private errand", status: "open", tier: "private", due_at: "2026-11-11", area_id: "area_family" } });
    const mine = await ownerToday(app);
    const agent = (await tool(app, app.secrets!.agent, "today")).data as View;
    const seen = ids(agent);
    const hidden = mine.filter((id) => !seen.includes(id));
    expect(hidden.length).toBeGreaterThan(0);
    expect(titles(agent)).not.toContain("Example private errand");
    for (const id of seen) expect(mine).toContain(id);
    for (const name of ["upcoming", "week"]) expect((await tool(app, app.secrets!.agent, name)).data.title).toBeTruthy();
    // Presentation fields are dropped.
    expect(JSON.stringify(agent)).not.toContain("glyph");
  } finally {
    app.close();
  }
});

test("a game that is over is absent from the agent's today", async () => {
  const clock = { now: new Date("2026-11-22T10:00:00.000Z") };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "hmn-views-")), kek: randomBytes(32), now: () => clock.now, timeZone: "Australia/Perth" });
  try {
    await call(app, "/api/v1/event", { method: "POST", ...owner(app), body: { title: "Example evening match", kind: "fixture", status: "upcoming", tier: "public", due_at: "2026-11-22T12:30:00.000Z" } });
    await call(app, "/api/v1/event", { method: "POST", ...owner(app), body: { title: "Example afternoon match", kind: "fixture", status: "upcoming", tier: "public", due_at: "2026-11-22T06:00:00.000Z" } });
    for (const name of ["today", "upcoming", "week"]) {
      const shown = titles((await tool(app, app.secrets!.agent, name)).data as View);
      expect(shown).not.toContain("Example afternoon match");
    }
    expect(titles((await tool(app, app.secrets!.agent, "today")).data as View)).toContain("Example evening match");
  } finally {
    app.close();
  }
});

test("person_page of a hidden person answers as get_entity does", async () => {
  const app = testApp();
  try {
    const agent = app.secrets!.agent;
    const page = await tool(app, agent, "person_page", { id: "person_sam" });
    const hiddenGet = await tool(app, agent, "get_entity", { type: "person", id: "person_luca" });
    const hiddenPage = await tool(app, agent, "person_page", { id: "person_luca" });
    expect(hiddenGet.isError).toBe(true);
    expect(hiddenPage.isError).toBe(true);
    expect(hiddenPage.data.error).toBe(hiddenGet.data.error);
    const missing = await tool(app, agent, "person_page", { id: "person_nobody" });
    expect(missing.data.error).toBe(hiddenPage.data.error);
    // Sam is in the Family area, which the agent key cannot read. Alex has no area, so the agent sees Alex's page.
    expect(page.isError).toBe(true);
    const visible = await tool(app, agent, "person_page", { id: "person_alex" });
    expect(visible.isError).toBe(false);
    expect(visible.data.title).toBe("Alex");
    // The owner sees the hidden person.
    expect((await call(app, "/api/v1/person/person_luca/page", owner(app))).status).toBe(200);
  } finally {
    app.close();
  }
});

test("expiring lists a car insurance expiry", async () => {
  const app = testApp();
  try {
    const patched = await call(app, "/api/v1/asset/asset_coupe", { method: "PATCH", ...owner(app), body: { properties_patch: { insurance_expires: "2026-12-01" } } });
    expect(patched.status).toBe(200);
    const view = (await tool(app, app.secrets!.agent, "expiring")).data as View;
    const row = view.sections[0]!.items.find((item) => item.id === "asset_coupe");
    expect(row?.type).toBe("asset");
    expect(row?.subtitle).toContain("Insurance ends");
    expect((await tool(app, app.secrets!.agent, "expiring", { days: 2 })).data.sections).toEqual([]);
    expect((await tool(app, app.secrets!.agent, "expiring", { days: 400 })).isError).toBe(true);
  } finally {
    app.close();
  }
});

test("the read log records a row that the agent saw through today", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Example view task", status: "open", due_at: "2026-11-11", area_id: "area_work" } });
    const view = (await tool(app, app.secrets!.agent, "today")).data as View;
    const seen = view.sections.flatMap((s) => s.items).find((item) => item.title === "Example view task");
    expect(seen).toBeTruthy();
    const log = await call(app, "/api/v1/access/key_agent/reads", owner(app));
    const reads = (log.json as { reads: Array<{ action: string; id: string | null }> }).reads;
    expect(reads.some((row) => row.action === "read" && row.id === seen!.id)).toBe(true);
  } finally {
    app.close();
  }
});

test("the view key gets Public rows only", async () => {
  const app = testApp();
  try {
    await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Example public task", status: "open", tier: "public", due_at: "2026-11-11", area_id: "area_sport" } });
    const view = (await tool(app, app.secrets!.display, "today")).data as View;
    expect(titles(view)).toContain("Example public task");
    const all = await tool(app, app.secrets!.display, "week");
    expect(all.isError).toBe(false);
    const tiers = new Set<string>();
    for (const item of view.sections.flatMap((s) => s.items)) {
      const row = app.hmn.store.db.query("SELECT tier FROM entities WHERE id = ?").get(item.id) as { tier: string } | null;
      if (row) tiers.add(row.tier);
    }
    expect([...tiers]).toEqual(["public"]);
  } finally {
    app.close();
  }
});
