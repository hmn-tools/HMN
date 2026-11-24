import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { call, testApp } from "./helpers";
import type { App } from "../src/app";

let app: App;
beforeAll(() => {
  app = testApp();
});
afterAll(() => app.close());

type Item = { id: string; tier: string; tags: string[]; suggestion: { route: string; label: string; entity_id?: string } | null; status?: string; result_type?: string; result_id?: string; source?: string; redacted?: boolean };

test("#todo and #family become a private task in Family", async () => {
  const captured = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Order school shoes #todo #family", source: "app" },
  });
  expect(captured.status).toBe(201);
  const item = captured.json as Item;
  expect(item.tier).toBe("private");
  expect(item.tags).toContain("todo");
  expect(item.tags).toContain("family");
  expect(item.suggestion?.label).toBe("Task in Family");
  expect(item.suggestion?.entity_id).toBe("area_family");
  const widget = await call(app, "/api/v1/inbox", { key: app.secrets!.owner, surface: "widget" });
  expect(widget.text).not.toContain("school shoes");
  const accepted = await call(app, `/api/v1/inbox/${item.id}/process`, {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { action: "accept" },
  });
  expect(accepted.status).toBe(200);
  const done = accepted.json as Item;
  expect(done.status).toBe("processed");
  expect(done.result_type).toBe("task");
  const task = await call(app, `/api/v1/task/${done.result_id}`, { key: app.secrets!.owner, surface: "phone" });
  expect(task.status).toBe(200);
  expect((task.json as { area_id: string; tier: string; origin_ref: string }).area_id).toBe("area_family");
  expect((task.json as { tier: string }).tier).toBe("private");
  expect((task.json as { origin_ref: string }).origin_ref).toBe(`inbox:${item.id}`);
  const hidden = await call(app, `/api/v1/task/${done.result_id}`, { key: app.secrets!.owner, surface: "widget" });
  expect(hidden.status).toBe(404);
});

test("a #private item is omitted from the widget, the display, and the agent", async () => {
  const captured = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Passport renewal window #private #idea", source: "app" },
  });
  const phrase = "Passport renewal window";
  expect((captured.json as Item).tier).toBe("private");
  for (const surface of ["widget", "display"] as const) {
    const listed = await call(app, "/api/v1/inbox", { key: app.secrets!.owner, surface });
    expect(listed.text).not.toContain(phrase);
  }
  const agent = await call(app, "/api/v1/inbox", { key: app.secrets!.agent, surface: "mcp" });
  expect(agent.text).not.toContain(phrase);
  const tags = await call(app, "/api/v1/inbox/tags?q=idea", { key: app.secrets!.agent, surface: "mcp" });
  expect(tags.text).not.toContain("renewal");
  const phone = await call(app, "/api/v1/inbox", { key: app.secrets!.owner, surface: "phone" });
  expect(phone.text).toContain(phrase);
});

test("a sealed capture is field-encrypted and needs the vault", async () => {
  const phrase = "sealed-clinic-phrase";
  const captured = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: `Bring the form ${phrase} #sealed #area/health`, source: "app", url: "https://clinic.example/sealed-clinic-phrase" },
  });
  expect(captured.status).toBe(201);
  expect((captured.json as Item).redacted).toBe(true);
  expect(captured.text).not.toContain(phrase);
  const raw = app.store.plainBytes().toString("utf8");
  expect(raw).not.toContain(phrase);
  expect(raw).toContain("seal1:");
  const phone = await call(app, "/api/v1/inbox", { key: app.secrets!.owner, surface: "phone" });
  expect(phone.text).not.toContain(phrase);
  const paired = await call(app, "/api/v1/pairing", { method: "POST", key: app.secrets!.owner, ip: "127.0.0.1" });
  const device = await call(app, "/api/v1/pair", {
    method: "POST",
    ip: "10.9.9.9",
    body: { code: (paired.json as { code: string }).code, device_name: "Inbox" },
  });
  const secret = (device.json as { secret: string }).secret;
  const grant = await call(app, "/api/v1/vault/grants", { method: "POST", key: secret, surface: "phone" });
  const token = (grant.json as { grant: string }).grant;
  const opened = await call(app, "/api/v1/inbox", { key: secret, surface: "phone", grant: token });
  expect(opened.text).toContain(phrase);
  expect(opened.text).not.toContain("seal1:");
});

test("reading, people, and untagged captures follow their tags", async () => {
  const reading = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "The design of everyday things #read", source: "app" },
  });
  const readItem = reading.json as Item;
  expect(readItem.suggestion?.route).toBe("reading");
  const filed = await call(app, `/api/v1/inbox/${readItem.id}/process`, {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { action: "accept" },
  });
  const note = await call(app, `/api/v1/note/${(filed.json as Item).result_id}`, { key: app.secrets!.owner, surface: "phone" });
  expect((note.json as { properties: { reading: boolean } }).properties.reading).toBe(true);
  const person = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Dinner with Sam #person", source: "app" },
  });
  const personItem = person.json as Item;
  expect(personItem.tier).toBe("private");
  expect(personItem.suggestion?.entity_id).toBe("person_sam");
  const linked = await call(app, `/api/v1/inbox/${personItem.id}/process`, {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { action: "accept" },
  });
  expect((linked.json as Item).result_id).toBe("person_sam");
  const loose = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Something to sort later", source: "app" },
  });
  const looseItem = loose.json as Item;
  expect(looseItem.suggestion).toBeNull();
  const refused = await call(app, `/api/v1/inbox/${looseItem.id}/process`, {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { action: "accept" },
  });
  expect(refused.status).toBe(422);
  const archived = await call(app, `/api/v1/inbox/${looseItem.id}/process`, {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { action: "archive" },
  });
  expect((archived.json as Item).status).toBe("archived");
});

test("webhook and MCP capture land in the inbox and do not write the graph", async () => {
  const before = await call(app, "/api/v1/task", { key: app.secrets!.owner, surface: "phone" });
  const hook = await call(app, "/api/v1/inbox/in", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Forwarded letter about the garage", source: "email" },
  });
  expect(hook.status).toBe(201);
  expect((hook.json as Item).source).toBe("email");
  const mailed = await call(app, "/api/v1/inbox/in", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "A webhook dropped this" },
  });
  expect((mailed.json as Item).source).toBe("webhook");
  const mcp = await call(app, "/mcp", {
    method: "POST",
    key: app.secrets!.agent,
    surface: "mcp",
    body: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "capture_inbox", arguments: { text: "Agent saw a link #public" } } },
  });
  expect(mcp.status).toBe(200);
  // A key gets one answer for each item: no text back, and no tier.
  expect(mcp.text).toContain("received");
  expect(mcp.text).not.toContain("Agent saw a link");
  expect(mcp.text).not.toContain("tier");
  const after = await call(app, "/api/v1/task", { key: app.secrets!.owner, surface: "phone" });
  expect((after.json as { entities: unknown[] }).entities.length).toBe((before.json as { entities: unknown[] }).entities.length);
  const listed = await call(app, "/api/v1/inbox", { key: app.secrets!.owner, surface: "phone" });
  expect(listed.text).toContain("Agent saw a link");
  // The agent asked for Public. The owner sees that the item stayed Personal.
  const item = (listed.json as { items: Array<{ body: string; tier: string }> }).items.find((row) => row.body.includes("Agent saw a link"));
  expect(item?.tier).toBe("personal");
});

test("an agent cannot publish a capture, and private tags do not autocomplete downward", async () => {
  await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.owner,
    surface: "phone",
    body: { text: "Quiet note #vaultcode", source: "app", tier: "private" },
  });
  const widget = await call(app, "/api/v1/inbox/tags?q=vault", { key: app.secrets!.owner, surface: "widget" });
  expect(widget.text).not.toContain("vaultcode");
  const phone = await call(app, "/api/v1/inbox/tags?q=vault", { key: app.secrets!.owner, surface: "phone" });
  expect(phone.text).toContain("vaultcode");
  const health = await call(app, "/api/v1/inbox", {
    method: "POST",
    key: app.secrets!.agent,
    surface: "mcp",
    body: { text: "Clinic follow-up #area/health", source: "mcp" },
  });
  // The same answer as for any other item. Before, "redacted" told the agent that the text named a Sealed area.
  expect(health.json).toEqual({ id: expect.any(String), received: true });
  expect(health.text).not.toContain("Clinic follow-up");
  const empty = await call(app, "/api/v1/screens/inbox", { key: app.secrets!.display, surface: "display" });
  expect(empty.text).toContain("Nothing waiting to be placed.");
});
