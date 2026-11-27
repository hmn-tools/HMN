import type { Database } from "bun:sqlite";
import { readableDue } from "./time";
import { DEFAULT_KIND_FIELDS } from "./kinds";
import { ApiError } from "./types";

/**
 * Typed fields. A type has a few fields of its own (a person's birthday), and a kind adds more (a car's
 * registration, a document's expiry). The values live in `properties` under the field's key. A client shows a form
 * from the specs, and the server checks each value on each write. A key that has no spec is kept as it is.
 * docs/SCHEMA.md, "Typed fields".
 */
export const FIELD_TYPES = ["text", "long", "date", "yearly", "expiry", "number", "url", "choice", "person", "thing"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FieldSpec = { key: string; label: string; type: FieldType; choices?: string[] };

/** The fields of each type, whatever its kind. */
export const BASE_FIELDS: Record<string, FieldSpec[]> = {
  person: [
    { key: "nickname", label: "Nickname", type: "text" },
    { key: "birthday", label: "Birthday", type: "yearly" },
    { key: "anniversary", label: "Anniversary", type: "yearly" },
    { key: "address_line", label: "Address", type: "text" },
    { key: "last_contact", label: "Last in touch", type: "date" },
  ],
  place: [
    { key: "address_line", label: "Address", type: "text" },
    { key: "url", label: "Website or map", type: "url" },
  ],
  asset: [
    { key: "model", label: "Make and model", type: "text" },
    { key: "year", label: "Year", type: "number" },
    { key: "expires", label: "Renewal or expiry", type: "expiry" },
    { key: "url", label: "Manual or folder", type: "url" },
  ],
  goal: [{ key: "horizon", label: "Horizon", type: "choice", choices: ["year", "quarter", "open"] }],
  note: [{ key: "url", label: "Link", type: "url" }],
  project: [{ key: "outcome", label: "Outcome", type: "text" }],
};


export const MAX_KIND_FIELDS = 20;

export function ensureFieldTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kind_fields (
      type TEXT NOT NULL,
      kind TEXT NOT NULL,
      fields TEXT NOT NULL,
      PRIMARY KEY (type, kind)
    );
  `);
  // Once for each graph. After that the lists are the owner's.
  if (!db.query("SELECT 1 FROM meta WHERE key = 'kind_fields_v1'").get()) {
    const insert = db.query("INSERT OR IGNORE INTO kind_fields (type, kind, fields) VALUES (?, ?, ?)");
    for (const [type, kind, fields] of DEFAULT_KIND_FIELDS) insert.run(type, kind, JSON.stringify(fields));
    db.query("INSERT INTO meta (key, value) VALUES ('kind_fields_v1', '1')").run();
  }
}

/** The fields that each kind adds, for the kinds that the graph has. */
export function kindFieldList(db: Database): Array<{ type: string; kind: string; fields: FieldSpec[] }> {
  const rows = db
    .query("SELECT f.type, f.kind, f.fields FROM kind_fields f JOIN kinds k ON k.type = f.type AND k.kind = f.kind ORDER BY f.type, k.position, f.kind")
    .all() as Array<{ type: string; kind: string; fields: string }>;
  return rows.map((row) => ({ type: row.type, kind: row.kind, fields: parseSpecs(row.fields) }));
}

/** The whole form of one row: the type's fields, then the kind's. */
export function fieldsFor(db: Database, type: string, kind: string | null): FieldSpec[] {
  const base = BASE_FIELDS[type] ?? [];
  if (!kind) return base;
  const row = db.query("SELECT fields FROM kind_fields WHERE type = ? AND kind = ?").get(type, kind) as { fields: string } | null;
  return row ? base.concat(parseSpecs(row.fields)) : base;
}

function parseSpecs(text: string): FieldSpec[] {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? (value as FieldSpec[]) : [];
  } catch {
    return [];
  }
}

/** Check a list of fields from the owner. A key of the type's own fields cannot be used again. */
export function cleanSpecs(type: string, input: unknown): FieldSpec[] {
  if (!Array.isArray(input)) throw new ApiError(422, "bad_fields", "Send `fields` as a list.");
  if (input.length > MAX_KIND_FIELDS) throw new ApiError(422, "bad_fields", `A kind has at most ${MAX_KIND_FIELDS} fields.`);
  const taken = new Set((BASE_FIELDS[type] ?? []).map((field) => field.key));
  const seen = new Set<string>();
  return input.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label.trim().slice(0, 60) : "";
    if (!label) throw new ApiError(422, "bad_fields", "Each field has a name.");
    const key = typeof item.key === "string" && item.key ? item.key : keyOf(label);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new ApiError(422, "bad_fields", `"${label}" needs a key of lower-case letters, digits, and underscores.`);
    if (taken.has(key)) throw new ApiError(422, "bad_fields", `"${label}" uses the key of a field that every ${type} has.`);
    if (seen.has(key)) throw new ApiError(422, "bad_fields", `Two fields use the key "${key}".`);
    seen.add(key);
    const type_ = FIELD_TYPES.find((name) => name === item.type);
    if (!type_) throw new ApiError(422, "bad_fields", `"${label}" needs a type: ${FIELD_TYPES.join(", ")}.`);
    const spec: FieldSpec = { key, label, type: type_ };
    if (type_ === "choice") {
      const choices = Array.isArray(item.choices) ? item.choices.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim().slice(0, 40)) : [];
      if (choices.length < 2 || choices.length > 20) throw new ApiError(422, "bad_fields", `"${label}" needs 2 to 20 choices.`);
      spec.choices = [...new Set(choices)];
    }
    return spec;
  });
}

/** "Insurance ends" becomes `insurance_ends`. */
export function keyOf(label: string): string {
  const key = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40);
}

const LIMITS: Partial<Record<FieldType, number>> = { text: 500, long: 20_000, url: 2_000 };

/**
 * Check the values of the typed fields in `properties` that differ from `before`. An empty string removes the
 * value. `typeOf` gives the type of a row that the writer can see, or null, for a field that names a person or a thing.
 */
export function cleanValues(
  specs: FieldSpec[],
  properties: Record<string, unknown>,
  before: Record<string, unknown>,
  typeOf: (id: string) => string | null,
): Record<string, unknown> {
  const out = { ...properties };
  for (const spec of specs) {
    if (!(spec.key in out)) continue;
    let value = out[spec.key];
    // A value that this write does not change is not checked again, so an old value never blocks a save.
    if (JSON.stringify(value) === JSON.stringify(before[spec.key])) continue;
    if (value === null || value === "") {
      delete out[spec.key];
      continue;
    }
    const fail = (what: string): never => {
      throw new ApiError(422, "bad_field", `${spec.label}: ${what}`);
    };
    switch (spec.type) {
      case "text":
      case "long":
      case "url":
        if (typeof value !== "string") fail("use text.");
        value = (value as string).trim();
        if ((value as string).length > (LIMITS[spec.type] ?? 500)) fail(`use at most ${LIMITS[spec.type]} characters.`);
        if (spec.type === "url" && !/^https?:\/\/\S+$/i.test(value as string)) fail("use a link that starts with https://.");
        break;
      case "date":
      case "expiry":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !readableDue(value)) fail("use a date like 2026-12-01.");
        break;
      case "yearly":
        // A date that comes back each year. The year can be left out: 11-20 is 20 November.
        if (typeof value !== "string" || !(/^\d{4}-\d{2}-\d{2}$/.test(value) ? readableDue(value) : /^\d{2}-\d{2}$/.test(value) && readableDue(`2000-${value}`))) {
          fail("use a date like 1990-04-02, or 04-02 when the year is not known.");
        }
        break;
      case "number": {
        const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
        if (!Number.isFinite(number)) fail("use a number.");
        value = number;
        break;
      }
      case "choice":
        if (typeof value !== "string" || !(spec.choices ?? []).includes(value)) fail(`choose one of ${(spec.choices ?? []).join(", ")}.`);
        break;
      case "person":
      case "thing": {
        const want = spec.type === "person" ? "person" : "asset";
        if (typeof value !== "string" || typeOf(value) !== want) fail(`choose a ${spec.type} from your HMN.`);
        break;
      }
    }
    out[spec.key] = value;
  }
  return out;
}
