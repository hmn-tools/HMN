// Typed fields for each kind, and requests from agents. All data is fictional.
import { expect, test } from "bun:test";
import type { App } from "../src/app";
import { keyOf } from "../src/fields";
import { call, testApp } from "./helpers";

const owner = (app: App) => ({ key: app.secrets!.owner, surface: "phone" });
type Field = { key: string; type: string };
type Schema = { fields: Record<string, Field[]>; kind_fields: Array<{ type: string; kind: string; fields: Field[] }>; kinds: Array<{ type: string; kind: string }> };

async function mcp(app: App, name: string, args: Record<string, unknown> = {}) {
  const answer = await call(app, "/mcp", { method: "POST", key: app.secrets!.agent, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  const result = (answer.json as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { error: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

test("a kind adds its fields, and a new graph has a Document kind with an expiry", async () => {
  const app = testApp();
  try {
    const schema = (await call(app, "/api/v1/schema", owner(app))).json as Schema;
    expect(schema.kinds.some((row) => row.type === "asset" && row.kind === "document")).toBe(true);
    const car = schema.kind_fields.find((row) => row.type === "asset" && row.kind === "car")!;
    expect(car.fields.map((field) => field.key)).toContain("registration");
    expect(schema.fields.asset!.find((field) => field.key === "expires")!.type).toBe("expiry");
    const made = await call(app, "/api/v1/asset", {
      method: "POST",
      ...owner(app),
      body: { title: "Example passport", kind: "document", properties: { number: "X0000000", expires: "2027-02-14", holder: "person_alex" } },
    });
    expect(made.status).toBe(201);
    expect((made.json as { properties: Record<string, unknown> }).properties).toMatchObject({ number: "X0000000", expires: "2027-02-14", holder: "person_alex" });
  } finally {
    app.close();
  }
});

test("a typed value is checked: a date, a number, a choice, a person, and a link", async () => {
  const app = testApp();
  try {
    const patch = (properties_patch: Record<string, unknown>) =>
      call(app, "/api/v1/asset/asset_coupe", { method: "PATCH", ...owner(app), body: { properties_patch } });
    expect((await patch({ insurance_expires: "next spring" })).status).toBe(422);
    expect((await patch({ insurance_expires: "next spring" })).text).toContain("Insurance ends");
    expect((await patch({ mileage: "a lot" })).status).toBe(422);
    const ok = await patch({ mileage: "120500", insurance_expires: "2027-03-01", url: "https://example.org/manual" });
    expect(ok.status).toBe(200);
    expect((ok.json as { properties: Record<string, unknown> }).properties.mileage).toBe(120500);
    expect((await patch({ url: "ftp://example.org" })).status).toBe(422);
    // A field that names a person takes a person, not a task.
    const doc = await call(app, "/api/v1/asset", { method: "POST", ...owner(app), body: { title: "Example licence", kind: "document" } });
    const id = (doc.json as { id: string }).id;
    expect((await call(app, `/api/v1/asset/${id}`, { method: "PATCH", ...owner(app), body: { properties_patch: { holder: "task_notes" } } })).status).toBe(422);
    // A goal's horizon is one of its choices.
    expect((await call(app, "/api/v1/goal", { method: "POST", ...owner(app), body: { title: "Example goal", properties: { horizon: "decade" } } })).status).toBe(422);
    // An empty value removes the field.
    const cleared = await patch({ mileage: "" });
    expect((cleared.json as { properties: Record<string, unknown> }).properties.mileage).toBeUndefined();
  } finally {
    app.close();
  }
});

test("an old value that is not valid does not block a save of the other fields", async () => {
  const app = testApp();
  try {
    // A record from before the checks: its stored value is free text.
    app.hmn.store.db.query("UPDATE entities SET properties = json_set(properties, '$.service_due', 'soon') WHERE id = 'asset_coupe'").run();
    const saved = await call(app, "/api/v1/asset/asset_coupe", { method: "PATCH", ...owner(app), body: { properties_patch: { registration: "EXAMPLE 1" } } });
    expect(saved.status).toBe(200);
  } finally {
    app.close();
  }
});

test("the owner sets the fields of a kind, and a bad list is refused", async () => {
  const app = testApp();
  try {
    const put = (fields: unknown) => call(app, "/api/v1/kinds/place/school/fields", { method: "PUT", ...owner(app), body: { fields } });
    const saved = await put([
      { label: "Phone", type: "text" },
      { label: "Term ends", type: "date" },
      { label: "Year group", type: "choice", choices: ["Reception", "Year 1", "Year 2"] },
    ]);
    expect(saved.status).toBe(200);
    expect((saved.json as { fields: Field[] }).fields.map((field) => field.key)).toEqual(["phone", "term_ends", "year_group"]);
    expect((await put([{ label: "Address", key: "address_line", type: "text" }])).status).toBe(422);
    expect((await put([{ label: "Mood", type: "colour" }])).status).toBe(422);
    expect((await put([{ label: "One", type: "choice", choices: ["only"] }])).status).toBe(422);
    expect((await call(app, "/api/v1/kinds/place/nowhere/fields", { method: "PUT", ...owner(app), body: { fields: [] } })).status).toBe(404);
    // An agent key cannot change the form.
    expect((await call(app, "/api/v1/kinds/place/school/fields", { method: "PUT", key: app.secrets!.agent, body: { fields: [] } })).status).toBe(403);
    expect(keyOf("Insurance ends")).toBe("insurance_ends");
    expect(keyOf("2nd phone")).toBe("f_2nd_phone");
  } finally {
    app.close();
  }
});

test("an agent reads the schema, and a proposal with a bad typed value fails on approval", async () => {
  const app = testApp();
  try {
    const schema = await mcp(app, "describe_schema");
    expect(schema.error).toBe(false);
    expect(JSON.stringify(schema.value)).toContain("insurance_expires");
    expect(JSON.stringify(schema.value)).not.toContain("in_use");
    // The same over HTTP: an agent key reads the shape, with no counts.
    const http = await call(app, "/api/v1/schema", { key: app.secrets!.agent });
    expect(http.status).toBe(200);
    expect(http.text).not.toContain("in_use");
  } finally {
    app.close();
  }
});

test("an agent tells the owner what it needs, once, and the owner closes it", async () => {
  const app = testApp();
  try {
    const first = await mcp(app, "request_feature", { need: "A tool to read the free text of a calendar event", why: "Example: I plan a trip and need the hotel address." });
    expect(first.error).toBe(false);
    const again = await mcp(app, "request_feature", { need: "a tool to read the free text of a calendar event", why: "Asked again." });
    expect(again.value.asks).toBe(2);
    expect(again.value.id).toBe(first.value.id);
    expect((await mcp(app, "request_feature", { need: "", why: "x" })).error).toBe(true);
    const list = (await call(app, "/api/v1/agent-requests", owner(app))).json as { requests: Array<{ id: string; need: string; asks: number; status: string }> };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]!.asks).toBe(2);
    // Only the owner reads the list and closes a request.
    expect((await call(app, "/api/v1/agent-requests", { key: app.secrets!.agent })).status).toBe(403);
    const done = await call(app, `/api/v1/agent-requests/${first.value.id}`, { method: "PATCH", ...owner(app), body: { status: "done" } });
    expect(done.status).toBe(200);
    const mine = await mcp(app, "my_requests");
    expect(JSON.stringify(mine.value)).toContain("done");
    // A new request each time is capped for each key.
    for (let index = 0; index < 9; index += 1) await mcp(app, "request_feature", { need: `Example need ${index}`, why: "A test." });
    const capped = await mcp(app, "request_feature", { need: "Example need over the cap", why: "A test." });
    expect(capped.error).toBe(true);
  } finally {
    app.close();
  }
});
