// The page of one agent key: what it can see, the Today screen as it gets it, and what it did.
// All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

const AWAY = "10.7.7.8";
const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });

async function makeKey(app: App, body: Record<string, unknown>) {
  const reply = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body });
  expect(reply.status).toBe(201);
  return reply.json as { id: string; token: string };
}

function mcp(app: App, token: string, name: string, args: Record<string, unknown>) {
  return call(app, "/mcp", { method: "POST", key: token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
}

type Scope = { ceiling: string; total: number; by_type: Array<{ type: string; count: number }>; by_area: Array<{ area_id: string | null; title: string | null; count: number }>; closed: string[] };
type Timeline = { summary: { approved: number; declined: number; pending: number; open_requests: number }; items: Array<{ at: string; kind: string; text: string; status?: string; proposal_id?: string; request_id?: string }> };

test("the scope of an agent key is counts only, and it matches what the key can read", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "scout" });
    const reply = await call(app, `/api/v1/access/${key.id}/scope`, owner(app));
    expect(reply.status).toBe(200);
    const scope = reply.json as Scope;
    expect(scope.ceiling).toBe("personal");
    expect(scope.by_type.reduce((sum, item) => sum + item.count, 0)).toBe(scope.total);
    expect(scope.by_area.reduce((sum, item) => sum + item.count, 0)).toBe(scope.total);
    expect(scope.closed).toContain("Sealed rows");
    expect(scope.closed).toContain("Private rows");
    expect(scope.closed).toContain("The Health area");
    // Counts only: no row title is in the answer.
    expect(reply.text).not.toContain("dentist");

    // The same rows that the key can open by id, one by one.
    const rows = app.hmn.store.db.query("SELECT id, type FROM entities WHERE deleted_at IS NULL").all() as Array<{ id: string; type: string }>;
    expect(scope.total).toBeLessThan(rows.length);
    let readable = 0;
    for (const row of rows) {
      const got = await call(app, `/api/v1/${row.type}/${row.id}`, { key: key.token, surface: "mcp" });
      if (got.status === 200) readable += 1;
    }
    expect(readable).toBe(scope.total);

    // The ceiling holds when the owner lifts nothing: a Public key has fewer rows.
    const low = await makeKey(app, { name: "lobby", ceiling: "public" });
    const lowScope = (await call(app, `/api/v1/access/${low.id}/scope`, owner(app))).json as Scope;
    expect(lowScope.ceiling).toBe("public");
    expect(lowScope.total).toBeLessThan(scope.total);
    expect(lowScope.closed).toContain("Personal rows");
  } finally {
    app.close();
  }
});

test("the page is for the owner: a member, the key itself, a hidden phone, and a view key are refused", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "scout" });
    const view = await makeKey(app, { name: "screen", scope: "read" });
    const routes = ["scope", "today", "timeline"];
    for (const route of routes) {
      const url = `/api/v1/access/${key.id}/${route}`;
      expect((await call(app, url, owner(app))).status).toBe(200);
      expect((await call(app, url, { key: key.token, surface: "mcp" })).status).toBe(403);
      expect((await call(app, url, { key: view.token, surface: "mcp" })).status).toBe(403);
      expect((await call(app, url, { key: app.secrets!.agent, surface: "mcp" })).status).toBe(403);
      expect((await call(app, `/api/v1/access/key_missing/${route}`, owner(app))).status).toBe(404);
    }

    // A member's phone.
    const made = await call(app, "/api/v1/members/pairing", { method: "POST", ...owner(app), ip: AWAY, body: { person_id: "person_sam", role: "partner" } });
    expect(made.status).toBe(201);
    {
      const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (made.json as { code: string }).code, device_name: "Example member phone" } });
      const member = (paired.json as { secret: string }).secret;
      for (const route of routes) expect([403, 404]).toContain((await call(app, `/api/v1/access/${key.id}/${route}`, { key: member, surface: "phone", ip: AWAY })).status);
    }

    // A hidden phone.
    const code = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
    const paired = await call(app, "/api/v1/pair", { method: "POST", ip: AWAY, body: { code: (code.json as { code: string }).code, device_name: "Example hidden phone" } });
    const phone = (paired.json as { secret: string }).secret;
    expect((await call(app, `/api/v1/access/${key.id}/scope`, { key: phone, surface: "phone", ip: AWAY })).status).toBe(200);
    expect((await call(app, "/api/v1/panic", { method: "POST", key: phone, surface: "phone", ip: AWAY })).status).toBe(200);
    for (const route of routes) expect((await call(app, `/api/v1/access/${key.id}/${route}`, { key: phone, surface: "phone", ip: AWAY })).status).toBe(403);
  } finally {
    app.close();
  }
});

test("the timeline shows a search, a proposal, and a request of the key, and the counts of the summary", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "scout" });
    const other = await makeKey(app, { name: "errands" });
    expect((await mcp(app, key.token, "search", { query: "Grand Prix" })).status).toBe(200);
    const filed = await call(app, "/api/v1/proposals", {
      method: "POST",
      key: key.token,
      surface: "mcp",
      body: { op: "create", entity: { type: "task", title: "Example check the tyres", status: "open", kind: "task", area_id: "area_work" }, reason: "A test." },
    });
    expect(filed.status).toBe(201);
    const proposalId = (filed.json as { id: string }).id;
    const asked = await call(app, "/api/v1/agent-requests", { method: "POST", key: key.token, surface: "mcp", body: { need: "Example a field for tyre age", why: "A test." } });
    expect(asked.status).toBe(201);
    // Another key's work is not in this timeline.
    await mcp(app, other.token, "search", { query: "Luca" });

    const reply = await call(app, `/api/v1/access/${key.id}/timeline?limit=50`, owner(app));
    expect(reply.status).toBe(200);
    const body = reply.json as Timeline;
    const search = body.items.find((item) => item.kind === "read" && item.text.includes("Grand Prix"));
    expect(search).toBeTruthy();
    expect(search!.text).toMatch(/^Searched for "Grand Prix": \d+ rows?$/);
    expect(body.items.filter((item) => item.kind === "read" && item.text.startsWith("Searched")).length).toBe(1);
    const proposal = body.items.find((item) => item.kind === "proposal");
    expect(proposal).toMatchObject({ status: "pending", proposal_id: proposalId });
    expect(proposal!.text).toContain("Example check the tyres");
    const request = body.items.find((item) => item.kind === "request");
    expect(request).toMatchObject({ status: "open", text: "Example a field for tyre age" });
    expect(request!.request_id).toBeTruthy();
    expect(body.summary).toEqual({ approved: 0, declined: 0, pending: 1, open_requests: 1 });
    expect(reply.text).not.toContain("Luca");

    // After a decision, the count moves and the status follows.
    const approved = await call(app, `/api/v1/proposals/${proposalId}/approve`, { method: "POST", ...owner(app) });
    expect(approved.status).toBe(200);
    const after = (await call(app, `/api/v1/access/${key.id}/timeline`, owner(app))).json as Timeline;
    expect(after.summary).toMatchObject({ approved: 1, pending: 0 });
    expect(after.items.find((item) => item.kind === "proposal")!.status).toBe("approved");
  } finally {
    app.close();
  }
});

test("today as the agent omits a private row that the owner's today shows, and it leaves no read by the key", async () => {
  const app = testApp();
  try {
    const key = await makeKey(app, { name: "scout" });
    const made = await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Example private errand", status: "open", kind: "task", area_id: "area_work", tier: "private", due_at: "2026-11-11T06:00:00.000Z" } });
    expect(made.status).toBe(201);
    const mine = await call(app, "/api/v1/screens/today", owner(app));
    expect(mine.text).toContain("Example private errand");
    const reads = () => (app.hmn.store.db.query("SELECT COUNT(*) AS n FROM client_reads WHERE principal_id = ?").get(key.id) as { n: number }).n;
    const before = reads();
    const theirs = await call(app, `/api/v1/access/${key.id}/today`, owner(app));
    expect(theirs.status).toBe(200);
    expect((theirs.json as { id: string; surface: string; ceiling: string }).id).toBe("today");
    expect(theirs.text).not.toContain("Example private errand");
    expect((theirs.json as { surface: string }).surface).toBe("mcp");
    expect(reads()).toBe(before);
  } finally {
    app.close();
  }
});
