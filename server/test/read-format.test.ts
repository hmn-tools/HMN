import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENTITY_TYPES } from "../src/types";
import type { App } from "../src/app";
import { call, testApp } from "./helpers";

/**
 * The read format is written in docs/SCHEMA.md, under "The read format". This test reads those tables
 * and compares them with real answers. A field that is added, removed, or changed fails here until the
 * table says the same.
 */
type Field = { name: string; type: string; optional: boolean };

const TYPES = ["text", "text or null", "number", "true or false", "object", "object or null", "list", "null"];
const SCHEMA = readFileSync(new URL("../../docs/SCHEMA.md", import.meta.url), "utf8");

function format(name: string): Field[] {
  const open = `<!-- format:${name} -->`;
  const close = `<!-- /format:${name} -->`;
  const start = SCHEMA.indexOf(open);
  const end = SCHEMA.indexOf(close);
  if (start === -1 || end === -1 || end < start) throw new Error(`SCHEMA.md has no table for the format "${name}".`);
  return SCHEMA.slice(start + open.length, end)
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      const raw = cells[2] ?? "";
      const optional = raw.endsWith(", optional");
      return { name: (cells[1] ?? "").replaceAll("`", ""), type: optional ? raw.slice(0, -", optional".length) : raw, optional };
    });
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "true or false";
  return typeof value === "object" ? "object" : typeof value;
}

function fits(type: string, value: unknown): boolean {
  const kind = kindOf(value);
  if (type === kind) return true;
  return type.endsWith(" or null") && (kind === "null" || kind === type.slice(0, -" or null".length));
}

/** The answer has each field of the table that is not optional, no field that the table does not have, and the type of each. */
function check(name: string, value: unknown, where: string) {
  const fields = format(name);
  expect({ where, kind: kindOf(value) }).toEqual({ where, kind: "object" });
  const answer = value as Record<string, unknown>;
  const known = new Set(fields.map((field) => field.name));
  expect({ where, not_in_the_table: Object.keys(answer).filter((key) => !known.has(key)) }).toEqual({ where, not_in_the_table: [] });
  for (const field of fields) {
    if (!(field.name in answer)) {
      expect({ where, missing: field.optional ? null : field.name }).toEqual({ where, missing: null });
      continue;
    }
    expect({ where, field: field.name, type: field.type, fits: fits(field.type, answer[field.name]) }).toEqual({ where, field: field.name, type: field.type, fits: true });
  }
}

async function readers(app: App) {
  const made = await call(app, "/api/v1/keys", { method: "POST", key: app.secrets!.owner, surface: "phone", body: { name: "kitchen", scope: "read" } });
  expect(made.status).toBe(201);
  return [
    { who: "the owner on the phone", key: app.secrets!.owner, surface: "phone" },
    { who: "an agent key", key: app.secrets!.agent, surface: "mcp" },
    { who: "a view key at Public", key: (made.json as { token: string }).token, surface: undefined },
  ];
}

test("the tables of the read format have each field one time, with a known type", () => {
  for (const name of ["entity", "screen", "next", "section", "item"]) {
    const fields = format(name);
    expect(fields.length).toBeGreaterThan(0);
    expect(new Set(fields.map((field) => field.name)).size).toBe(fields.length);
    for (const field of fields) expect({ name, field: field.name, known: TYPES.includes(field.type) }).toEqual({ name, field: field.name, known: true });
  }
  // The format of an entity is the same as the fields that the policy layer gives.
  expect(format("entity").filter((field) => field.optional)).toEqual([]);
});

test("one entity has the written format for the owner, an agent key, and a view key, on REST and on MCP", async () => {
  const app = testApp();
  try {
    for (const reader of await readers(app)) {
      let seen = 0;
      for (const type of ENTITY_TYPES) {
        const listed = await call(app, `/api/v1/${type}`, reader);
        expect(listed.status).toBe(200);
        expect(Object.keys(listed.json as object)).toEqual(["entities"]);
        const entities = (listed.json as { entities: Array<{ id: string }> }).entities;
        expect(entities.length).toBeLessThanOrEqual(200);
        for (const entity of entities) check("entity", entity, `${reader.who}, ${type} ${entity.id}`);
        seen += entities.length;
        const first = entities[0];
        if (!first) continue;
        // One entity by id is the same object, and MCP gives the same object as REST.
        const one = await call(app, `/api/v1/${type}/${first.id}`, reader);
        expect(one.status).toBe(200);
        check("entity", one.json, `${reader.who}, GET ${type} ${first.id}`);
        expect(one.json).toEqual(first);
        // The MCP surface stops at Personal, and the phone reads Private. So this comparison is for a key that is not the phone.
        if (reader.surface === "phone") continue;
        const tool = await call(app, "/mcp", { method: "POST", key: reader.key, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_entity", arguments: { type, id: first.id } } } });
        const text = (tool.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
        expect(JSON.parse(text)).toEqual(first);
      }
      // Each reader gets a row, so the comparison is not empty. The race is Public.
      expect(seen).toBeGreaterThan(0);
      expect((await call(app, "/api/v1/event/event_race", reader)).status).toBe(200);
    }
  } finally {
    app.close();
  }
});

test("each screen has the written format for the owner, an agent key, and a view key", async () => {
  const app = testApp();
  try {
    for (const reader of await readers(app)) {
      let items = 0;
      for (const id of ["today", "upcoming", "commitments", "quiet", "week", "inbox", "agents"]) {
        const reply = await call(app, `/api/v1/screens/${id}`, reader);
        const where = `${reader.who}, screen ${id}`;
        expect({ where, status: reply.status }).toEqual({ where, status: 200 });
        check("screen", reply.json, where);
        const screen = reply.json as { id: string; next: unknown; sections: Array<{ id: string; items: unknown[] }> };
        expect(screen.id).toBe(id);
        if (screen.next !== null) check("next", screen.next, `${where}, next`);
        for (const section of screen.sections) {
          check("section", section, `${where}, section ${section.id}`);
          // A section with no row is not in the list.
          expect({ where, section: section.id, empty: section.items.length === 0 }).toEqual({ where, section: section.id, empty: false });
          for (const item of section.items) check("item", item, `${where}, section ${section.id}`);
          items += section.items.length;
        }
      }
      expect(items).toBeGreaterThan(0);
    }
  } finally {
    app.close();
  }
});
