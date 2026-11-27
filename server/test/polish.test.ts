// Link words that fit any type, titles on a proposal's links, and the list of dates that HMN cannot read.
// All data is fictional.
import { expect, test } from "bun:test";
import { RELATIONS } from "../src/hmn";
import { call, testApp } from "./helpers";

const owner = (app: ReturnType<typeof testApp>) => ({ key: app.secrets!.owner, surface: "phone" });

test("the words for the far end of a link do not assume a person", () => {
  for (const item of RELATIONS) expect(item.in).not.toMatch(/\bthem\b/i);
  expect(RELATIONS.find((item) => item.rel === "about")?.in).toBe("About this");
  expect(RELATIONS.find((item) => item.rel === "for")?.in).toBe("For this");
  expect(RELATIONS.find((item) => item.rel === "with")?.in).toBe("With this");
});

test("a proposal link carries the title of a row the caller can see, and none for a row it cannot", async () => {
  const app = testApp();
  try {
    const note = (await call(app, "/api/v1/note", { method: "POST", ...owner(app), body: { title: "Example linked note", tier: "personal" } })).json as { id: string };
    const entity = { type: "task", title: "Example task with links", status: "open" };
    const filed = await call(app, "/api/v1/proposals", { method: "POST", key: app.secrets!.agent, surface: "mcp", body: { op: "create", entity, links: [{ rel: "about", to_id: note.id }], reason: "A test." } });
    expect(filed.status).toBe(201);
    const id = (filed.json as { id: string }).id;
    type Shown = { id: string; payload: { links: Array<{ to_id: string; title?: string }> } };
    const link = async (key: string, surface: string) => {
      const list = (await call(app, "/api/v1/proposals?status=pending", { key, surface })).json as { proposals: Shown[] };
      return list.proposals.find((item) => item.id === id)!;
    };
    expect((await link(app.secrets!.agent, "mcp")).payload.links[0]!.title).toBe("Example linked note");
    expect((await link(app.secrets!.owner, "phone")).payload.links[0]!.title).toBe("Example linked note");
    // The owner raises the note above what the agent reads. The agent gets no title and no hint of one.
    expect((await call(app, `/api/v1/note/${note.id}`, { method: "PATCH", ...owner(app), body: { tier: "private" } })).status).toBe(200);
    const agent = await link(app.secrets!.agent, "mcp");
    expect(agent.payload.links[0]!.title).toBeUndefined();
    expect(JSON.stringify(agent)).not.toContain("Example linked note");
    expect((await link(app.secrets!.owner, "phone")).payload.links[0]!.title).toBe("Example linked note");
  } finally {
    app.close();
  }
});

test("the list of unreadable dates names each bad due date and typed date, and an empty list is empty", async () => {
  const app = testApp();
  try {
    expect(((await call(app, "/api/v1/dates/unreadable", owner(app))).json as { dates: unknown[] }).dates).toEqual([]);
    const task = (await call(app, "/api/v1/task", { method: "POST", ...owner(app), body: { title: "Example old task", status: "open" } })).json as { id: string };
    const person = (await call(app, "/api/v1/person", { method: "POST", ...owner(app), body: { title: "Example Person", tier: "personal" } })).json as { id: string };
    const fine = (await call(app, "/api/v1/person", { method: "POST", ...owner(app), body: { title: "Example Fine", tier: "personal", properties: { birthday: "04-02" } } })).json as { id: string };
    const db = app.hmn.store.db;
    db.query("UPDATE entities SET due_at = '2026-02-31' WHERE id = ?").run(task.id);
    db.query("UPDATE entities SET properties = ? WHERE id = ?").run(JSON.stringify({ birthday: "13-45", last_contact: "last week" }), person.id);
    const result = await call(app, "/api/v1/dates/unreadable", owner(app));
    expect(result.status).toBe(200);
    const dates = (result.json as { dates: Array<{ id: string; type: string; title: string; field: string; value: string }> }).dates;
    expect(dates.find((row) => row.id === task.id)).toEqual({ id: task.id, type: "task", title: "Example old task", field: "Date", value: "2026-02-31" });
    expect(dates.find((row) => row.id === person.id && row.field === "Birthday")?.value).toBe("13-45");
    expect(dates.find((row) => row.id === person.id && row.field === "Last in touch")?.value).toBe("last week");
    expect(dates.some((row) => row.id === fine.id)).toBe(false);
    // Only the owner reads the list.
    expect((await call(app, "/api/v1/dates/unreadable", { key: app.secrets!.agent, surface: "mcp" })).status).toBe(403);
    expect((await call(app, "/api/v1/dates/unreadable", { key: app.secrets!.display })).status).toBe(403);
  } finally {
    app.close();
  }
});
