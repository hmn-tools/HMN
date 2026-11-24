import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

// What a key that is not the owner's cannot do through a proposal, a history, or a list.
// Each test is a finding of the audit of 2026-11-23.

type Summary = { title: string; lines: Array<{ label: string; text: string; was?: string }>; warning: string | null };
type View = { id: string; agent_name: string; op: string; status: string; tier: string; payload?: { entity?: { title?: string } }; reason?: string; read_set?: Record<string, unknown>; summary?: Summary };

function owner(app: App) {
  return { key: app.secrets!.owner, surface: "phone" };
}

function agent(app: App) {
  return { key: app.secrets!.agent, surface: "mcp" };
}

async function makeTask(app: App, body: Record<string, unknown>) {
  const reply = await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { status: "open", kind: "task", area_id: "area_work", ...body } });
  expect(reply.status).toBe(201);
  return (reply.json as { id: string }).id;
}

function propose(app: App, caller: { key: string; surface: string }, body: Record<string, unknown>, name?: string) {
  return call(app, "/api/v1/proposals", { method: "POST", ...caller, body, agent: name });
}

async function pending(app: App, caller: { key: string; surface: string }) {
  const reply = await call(app, "/api/v1/proposals?status=all", caller);
  expect(reply.status).toBe(200);
  return (reply.json as { proposals: View[] }).proposals;
}

function tierOf(app: App, id: string) {
  return app.hmn.store.db.query("SELECT tier, area_id, title FROM entities WHERE id = ?").get(id) as { tier: string | null; area_id: string | null; title: string };
}

test("a key cannot make a row more visible with a patch, and it cannot change an area", async () => {
  const app = testApp();
  try {
    const id = await makeTask(app, { title: "Example renewal" });

    // The tier of the row, and the tier that the area gives.
    const lower = await propose(app, agent(app), { op: "update", payload: { op: "update", id, patch: { tier: "public" } }, reason: "A test." });
    expect(lower.status).toBe(422);
    expect((lower.json as { error: { code: string } }).error.code).toBe("tier_floor");
    const move = await propose(app, agent(app), { op: "update", payload: { op: "update", id, patch: { area_id: "area_sport" } }, reason: "A test." });
    expect(move.status).toBe(422);
    const unknown = await propose(app, agent(app), { op: "update", payload: { op: "update", id, patch: { tier: "open" } }, reason: "A test." });
    expect(unknown.status).toBe(422);

    // An area holds the tier of its items.
    const area = await propose(app, agent(app), { op: "update", payload: { op: "update", id: "area_cars", patch: { properties: { child_tier: "public" } } }, reason: "A test." });
    expect(area.status).toBe(403);
    expect((await propose(app, agent(app), { op: "delete", payload: { op: "delete", id: "area_cars" }, reason: "A test." })).status).toBe(403);

    // A row that looks like a copy of a calendar refuses the edits of the owner.
    const mirror = await propose(app, agent(app), { op: "create", entity: { type: "event", title: "Example copy", status: "upcoming", kind: "appointment", due_at: "2026-11-20T02:00:00Z", properties: { mirror: true } }, reason: "A test." });
    expect(mirror.status).toBe(422);

    // A move to an area with the same tier is a proposal, and the summary names the two areas.
    const same = await propose(app, agent(app), { op: "update", payload: { op: "update", id, patch: { area_id: "area_cars" } }, reason: "A test." });
    expect(same.status).toBe(201);
    const view = same.json as View;
    expect(view.summary?.title).toBe("Example renewal");
    expect(view.summary?.lines).toContainEqual({ label: "Area", text: "Cars", was: "Work" });
    expect(view.summary?.warning).toBeNull();
    expect(tierOf(app, id).tier).toBeNull();
    // No refused proposal is stored. The demonstration has one proposal, and this test made one.
    expect(app.hmn.store.db.query("SELECT COUNT(*) AS n FROM proposals").get()).toEqual({ n: 2 });
  } finally {
    app.close();
  }
});

test("the rule holds at the approval, when the row changed after the proposal", async () => {
  const app = testApp();
  try {
    const id = await makeTask(app, { title: "Example permit" });
    // At this time the patch keeps the tier.
    const filed = await propose(app, agent(app), { op: "update", payload: { op: "update", id, patch: { title: "Example permit, renamed", tier: "personal" } }, reason: "A test." });
    expect(filed.status).toBe(201);
    const proposalId = (filed.json as View).id;

    // The owner makes the row Private. The same patch now makes it more visible.
    expect((await call(app, `/api/v1/task/${id}`, { method: "PATCH", ...owner(app), body: { tier: "private" } })).status).toBe(200);
    const shown = (await pending(app, owner(app))).find((item) => item.id === proposalId)!;
    expect(shown.summary?.lines).toContainEqual({ label: "Tier", text: "personal", was: "private" });
    expect(shown.summary?.warning).toContain("more visible");

    const approved = await call(app, `/api/v1/proposals/${proposalId}/approve`, { method: "POST", ...owner(app) });
    expect(approved.status).toBe(422);
    expect(tierOf(app, id)).toMatchObject({ tier: "private", title: "Example permit" });
    expect((app.hmn.store.db.query("SELECT status FROM proposals WHERE id = ?").get(proposalId) as { status: string }).status).toBe("pending");
  } finally {
    app.close();
  }
});

test("history has the limits of a read: the areas of the key, and the tier of each version", async () => {
  const app = testApp();
  try {
    // A Personal row in the Health area. The agent key does not read that area.
    const health = await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example clinic visit", body: "A fictional note.", area_id: "area_health", tier: "personal" } });
    expect(health.status).toBe(201);
    const healthId = (health.json as { id: string }).id;
    expect((await call(app, `/api/v1/note/${healthId}`, agent(app))).status).toBe(404);
    expect((await call(app, `/api/v1/note/${healthId}/history`, agent(app))).status).toBe(404);

    // A row that was Private, and that the owner made Personal with a new text.
    const made = await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example private title", body: "Example private text.", area_id: "area_work", tier: "private" } });
    const id = (made.json as { id: string }).id;
    expect((await call(app, `/api/v1/note/${id}`, { method: "PATCH", ...owner(app), body: { title: "Example shared title", body: "Example shared text.", tier: "personal" } })).status).toBe(200);

    const seen = await call(app, `/api/v1/note/${id}/history`, agent(app));
    expect(seen.status).toBe(200);
    expect(seen.text).not.toContain("Example private");
    const versions = (seen.json as { versions: Array<{ title?: string; redacted?: boolean; tier: string }> }).versions;
    expect(versions.map((version) => version.title ?? null)).toEqual([null, "Example shared title"]);
    expect(versions[0]).toMatchObject({ redacted: true, tier: "private" });

    const mine = await call(app, `/api/v1/note/${id}/history`, owner(app));
    expect((mine.json as { versions: Array<{ title?: string }> }).versions.map((version) => version.title)).toEqual(["Example private title", "Example shared title"]);
  } finally {
    app.close();
  }
});

test("a key reads the proposals that it filed, and no others", async () => {
  const app = testApp();
  try {
    const second = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "research" } });
    expect(second.status).toBe(201);
    const research = { key: (second.json as { token: string }).token, surface: "mcp" };
    const task = { type: "task", status: "open", kind: "task", area_id: "area_work" };

    const a = (await propose(app, agent(app), { op: "create", entity: { ...task, title: "Example from the agent" }, reason: "A test." })).json as View;
    const b = (await propose(app, research, { op: "create", entity: { ...task, title: "Example from research" }, reason: "A test." })).json as View;
    const c = (await propose(app, owner(app), { op: "create", entity: { ...task, title: "Example from the owner" }, reason: "A test." })).json as View;

    const forAgent = await call(app, "/api/v1/proposals?status=all", agent(app));
    expect(forAgent.text).not.toContain("Example from research");
    expect(forAgent.text).not.toContain("Example from the owner");
    expect((forAgent.json as { proposals: View[] }).proposals.map((item) => item.id)).toEqual([a.id]);
    expect((await pending(app, research)).map((item) => item.id)).toEqual([b.id]);

    // The tool of the agent has the same list. The status of another key's proposal is not found.
    const tool = (name: string, args: Record<string, unknown>) =>
      call(app, "/mcp", { method: "POST", ...agent(app), body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
    expect((await tool("list_proposals", { status: "all" })).text).not.toContain("Example from research");
    expect((await tool("proposal_status", { id: b.id })).text).not.toContain("pending");

    // The owner reads each one, with a summary.
    const all = await pending(app, owner(app));
    for (const id of [a.id, b.id, c.id]) expect(all.find((item) => item.id === id)?.summary?.lines.length).toBeGreaterThan(0);
  } finally {
    app.close();
  }
});

test("the server names the source, and the text of a proposal has no hidden characters", async () => {
  const app = testApp();
  try {
    const task = { type: "task", status: "open", kind: "task", area_id: "area_work" };
    // A key has the name that the owner gave it. The header does not change it.
    const posed = (await propose(app, agent(app), { op: "create", entity: { ...task, title: "Example posed" }, reason: "A test.", read_set: { summary: "Tasks", journal_id: "journal_fake" } }, "Calendar")).json as View;
    expect(posed.agent_name).toBe("agent");
    expect(posed.read_set).toEqual({ summary: "Tasks" });
    // The owner can name the source of a proposal that it files.
    const named = (await propose(app, owner(app), { op: "create", entity: { ...task, title: "Example named" }, reason: "A test." }, "Trip helper")).json as View;
    expect(named.agent_name).toBe("Trip helper");

    // A character that turns the direction of text, a null, a character with no width, and a line break in a title.
    const hidden = (await propose(app, agent(app), { op: "create", entity: { ...task, title: "Example ‮gpj.exe\u0000 one​\ntwo" }, reason: "First line.‮\nSecond\u0007 line." })).json as View;
    expect(hidden.payload?.entity?.title).toBe("Example gpj.exe one two");
    expect(hidden.reason).toBe("First line.\nSecond line.");
    expect(hidden.summary?.title).toBe("Example gpj.exe one two");
  } finally {
    app.close();
  }
});

test("the summary of a proposal says what an approval writes", async () => {
  const app = testApp();
  try {
    const id = await makeTask(app, { title: "Example to change", due_at: "2026-11-20" });
    const update = (await propose(app, agent(app), { op: "update", payload: { op: "update", id, patch: { title: "Example changed", status: "done" } }, reason: "It is all fine." })).json as View;
    expect(update.summary).toEqual({
      title: "Example to change",
      lines: [
        { label: "Title", text: "Example changed", was: "Example to change" },
        { label: "Status", text: "done", was: "open" },
      ],
      warning: null,
    });
    const remove = (await propose(app, agent(app), { op: "delete", payload: { op: "delete", id }, reason: "It is all fine." })).json as View;
    expect(remove.summary).toEqual({ title: "Example to change", lines: [{ label: "Removes", text: "task, personal" }], warning: null });
    const link = (await propose(app, agent(app), { op: "link", payload: { op: "link", link: { from_id: id, to_id: "project_brief", rel: "part_of" } }, reason: "It is all fine." })).json as View;
    expect(link.summary).toEqual({ title: "Example to change and Weekly brief", lines: [{ label: "Link", text: "part_of" }], warning: null });
    const create = (await propose(app, agent(app), { op: "create", entity: { type: "task", title: "Example new", status: "open", kind: "task", area_id: "area_cars", due_at: "2026-12-01" }, links: [{ rel: "about", to_type: "project", to_id: "project_brief" }], reason: "It is all fine." })).json as View;
    expect(create.summary).toEqual({
      title: "Example new",
      lines: [
        { label: "Due", text: "2026-12-01" },
        { label: "Area", text: "Cars" },
        { label: "Tier", text: "personal" },
        { label: "Links", text: "Weekly brief" },
      ],
      warning: null,
    });
  } finally {
    app.close();
  }
});

test("a key that the owner limited to some types does not read the inbox", async () => {
  const app = testApp();
  try {
    expect((await call(app, "/api/v1/inbox", { method: "POST", ...owner(app), body: { text: "Example inbox line" } })).status).toBe(201);
    const made = await call(app, "/api/v1/keys", { method: "POST", ...owner(app), body: { name: "narrow", allow_types: ["task"] } });
    expect(made.status).toBe(201);
    const narrow = { key: (made.json as { token: string }).token, surface: "mcp" };
    expect((await call(app, "/api/v1/inbox", agent(app))).text).toContain("Example inbox line");
    const limited = await call(app, "/api/v1/inbox", narrow);
    expect(limited.status).toBe(200);
    expect(limited.text).not.toContain("Example inbox line");
  } finally {
    app.close();
  }
});
