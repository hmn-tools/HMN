import type { Database } from "bun:sqlite";
import { ensureFieldTables, type FieldSpec } from "./fields";

/**
 * A kind is a row that the owner can add and rename. A role is a fixed word that the rules read.
 * The rules never read the name of a kind. They ask for the kinds that have a role.
 */
export const ROLES: Record<string, string[]> = {
  // `self` is the owner. `family` is a person whose dates are family dates. `organisation` is a school, a garage, a doctor.
  person: ["self", "family", "organisation"],
  // `family` is a family date. `fixture` is a start time with no result.
  event: ["family", "fixture"],
  // Where family dates, fixtures, and health summaries go, which areas an agent key cannot read by default, and which areas hold work.
  area: ["family", "work", "health", "money", "sport"],
  // `reading` is a note to read later. `review` is the owner's note for a year.
  note: ["reading", "review"],
};

/**
 * The roles of a household member. A partner reads Household, and the areas with the role `family` at Private.
 * The other role reads Household. docs/ONTOLOGY.md, section 5.4.
 */
export const MEMBER_ROLES = ["partner", "child"] as const;
export const PARTNER_ROLE = MEMBER_ROLES[0];

/** The types whose kinds are rows. */
export const KIND_TYPES = Object.keys(ROLES).concat(["place", "asset"]);

/** Kinds that the code itself writes. They are not the owner's words, so they stay in code. */
export const FIXED_KINDS: Record<string, string[]> = {
  source: ["manual", "notion", "calendar", "health", "sport", "agent"],
  // An `item` is a line of a list, or a step of a task. The screens leave it out. docs/ONTOLOGY.md, section 2.4.
  task: ["task", "item"],
};

export type KindRow = { type: string; kind: string; title: string; role: string | null; core: number; position: number };

type Seed = [type: string, kind: string, title: string, role: string | null, core: 0 | 1];

/**
 * The kinds of every new graph. A core kind cannot be removed, because a plugin or a worker writes it.
 * The owner can give each one another title.
 */
export const DEFAULT_KINDS: Seed[] = [
  ["person", "self", "Me", "self", 1],
  ["person", "family", "Family", "family", 1],
  ["person", "other", "Other", null, 1],
  ["person", "organisation", "Organisation", "organisation", 1],
  ["event", "family", "Family date", "family", 1],
  ["event", "appointment", "Appointment", null, 1],
  ["event", "fixture", "Fixture", "fixture", 1],
  ["event", "trip", "Trip", null, 0],
  ["area", "family", "Family", "family", 0],
  ["area", "work", "Work", "work", 0],
  ["area", "health", "Health", "health", 0],
  ["area", "money", "Money", "money", 0],
  ["area", "sport", "Sport", "sport", 0],
  ["area", "home", "Home", null, 0],
  ["area", "other", "Other", null, 1],
  ["note", "note", "Note", null, 1],
  ["note", "reference", "Reference", null, 0],
  ["note", "decision", "Decision", null, 0],
  ["note", "fact", "Fact", null, 0],
  ["note", "reading", "To read", "reading", 1],
  ["note", "review", "Year review", "review", 1],
  ["note", "capture", "Capture", null, 1],
  ["place", "home", "Home", null, 0],
  ["place", "other", "Other", null, 1],
  ["asset", "document", "Document", null, 0],
  ["asset", "other", "Other", null, 1],
];

/** The extra kinds of the demonstration, and of a graph from before kinds were rows. */
export const DEMO_KINDS: Seed[] = [
  ["person", "spouse", "Spouse", "family", 0],
  ["person", "child", "Child", "family", 0],
  ["area", "side_project", "Side project", "work", 0],
  ["area", "cars", "Cars", null, 0],
  ["place", "school", "School", null, 0],
  ["place", "garage", "Garage", null, 0],
  ["asset", "car", "Car", null, 0],
];

export function ensureKindTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kinds (
      type TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT,
      core INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (type, kind)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureFieldTables(db);
  const count = db.query("SELECT COUNT(*) AS n FROM kinds").get() as { n: number };
  if (count.n > 0) {
    addedKinds(db);
    return;
  }
  seedKinds(db, DEFAULT_KINDS);
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('kinds_organisation', '1')").run();
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('kinds_note', '1')").run();
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('kinds_document', '1')").run();
  // A graph from before this table: keep each kind that a row already uses, so that no row becomes invalid.
  const used = db
    .query(`SELECT DISTINCT type, kind FROM entities WHERE kind IS NOT NULL AND type IN (${KIND_TYPES.map(() => "?").join(",")})`)
    .all(...KIND_TYPES) as Array<{ type: string; kind: string }>;
  for (const row of used) {
    const known = DEMO_KINDS.find((seed) => seed[0] === row.type && seed[1] === row.kind);
    seedKinds(db, [known ?? [row.type, row.kind, titleOf(row.kind), null, 0]]);
  }
}

/**
 * A kind that a later version adds to every graph, once, at the next start. The owner can rename it.
 * The person kind `organisation` came on 24/11/2026.
 */
function addedKinds(db: Database) {
  if (!db.query("SELECT 1 FROM meta WHERE key = 'kinds_organisation'").get()) {
    seedKinds(db, [["person", "organisation", "Organisation", "organisation", 1]]);
    db.query("INSERT INTO meta (key, value) VALUES ('kinds_organisation', '1')").run();
  }
  // The note kinds came on 2026-11-27. A note that was a reading note or a year note by a property gets its kind.
  if (!db.query("SELECT 1 FROM meta WHERE key = 'kinds_note'").get()) {
    seedKinds(db, DEFAULT_KINDS.filter((row) => row[0] === "note"));
    noteKindsFromProperties(db);
    db.query("INSERT INTO meta (key, value) VALUES ('kinds_note', '1')").run();
  }
  // The asset kind `document` came on 2026-11-27: a passport, a licence, a policy. Its fields are in fields.ts.
  if (!db.query("SELECT 1 FROM meta WHERE key = 'kinds_document'").get()) {
    seedKinds(db, [["asset", "document", "Document", null, 0]]);
    db.query("INSERT INTO meta (key, value) VALUES ('kinds_document', '1')").run();
  }
}

/** A Sealed note keeps no kind here, because its properties are sealed. Its kind is set when the owner edits it. */
function noteKindsFromProperties(db: Database) {
  const has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entities'").get();
  if (!has) return;
  db.exec(`
    UPDATE entities SET kind = 'reading' WHERE type = 'note' AND kind IS NULL AND content_sealed = 0 AND json_extract(properties, '$.reading') = 1;
    UPDATE entities SET kind = 'review' WHERE type = 'note' AND kind IS NULL AND content_sealed = 0 AND json_extract(properties, '$.year_review') IS NOT NULL;
    UPDATE entities SET kind = 'capture' WHERE type = 'note' AND kind IS NULL AND content_sealed = 0 AND json_extract(properties, '$.from_inbox') IS NOT NULL;
  `);
}

export function seedKinds(db: Database, rows: Seed[]) {
  const next = db.query("SELECT COALESCE(MAX(position), 0) AS n FROM kinds WHERE type = ?");
  const insert = db.query("INSERT OR IGNORE INTO kinds (type, kind, title, role, core, position) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [type, kind, title, role, core] of rows) {
    const at = (next.get(type) as { n: number }).n + 1;
    insert.run(type, kind, title, role, core, at);
  }
}

export function titleOf(kind: string): string {
  const text = kind.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The kinds, read once for a request. */
export class Kinds {
  private rows: KindRow[];

  constructor(db: Database) {
    this.rows = db.query("SELECT type, kind, title, role, core, position FROM kinds ORDER BY type, position").all() as KindRow[];
  }

  list(): KindRow[] {
    return this.rows;
  }

  /** The kinds that a type accepts, or null when the type accepts any kind. */
  allowed(type: string): Set<string> | null {
    if (FIXED_KINDS[type]) return new Set(FIXED_KINDS[type]);
    if (!KIND_TYPES.includes(type)) return null;
    return new Set(this.rows.filter((row) => row.type === type).map((row) => row.kind));
  }

  /** Every kind of a type that has the role. */
  withRole(type: string, role: string): Set<string> {
    return new Set(this.rows.filter((row) => row.type === type && row.role === role).map((row) => row.kind));
  }

  roleOf(type: string, kind: string | null): string | null {
    if (!kind) return null;
    return this.rows.find((row) => row.type === type && row.kind === kind)?.role ?? null;
  }

  has(type: string, kind: string): boolean {
    return this.rows.some((row) => row.type === type && row.kind === kind);
  }
}

/** The roles that the screens and the workers read. A caller with no registry gets the names of the first version. */
export type RoleSets = {
  familyEvent: Set<string>;
  fixtureEvent: Set<string>;
  selfPerson: Set<string>;
  familyPerson: Set<string>;
};

export const LEGACY_ROLES: RoleSets = {
  familyEvent: new Set(["family"]),
  fixtureEvent: new Set(["fixture"]),
  selfPerson: new Set(["self"]),
  familyPerson: new Set(["spouse", "child", "family"]),
};

export function roleSets(kinds: Kinds): RoleSets {
  return {
    familyEvent: kinds.withRole("event", "family"),
    fixtureEvent: kinds.withRole("event", "fixture"),
    selfPerson: kinds.withRole("person", "self"),
    familyPerson: kinds.withRole("person", "family"),
  };
}

/**
 * The fields that a kind adds in a new graph, kept here with the other kind words. fields.ts has the checks. The owner can change each list. A list for a kind that the graph
 * does not have waits until the owner adds that kind.
 */
export const DEFAULT_KIND_FIELDS: Array<[type: string, kind: string, fields: FieldSpec[]]> = [
  ["asset", "document", [
    { key: "number", label: "Number", type: "text" },
    { key: "holder", label: "Holder", type: "person" },
    { key: "issued_by", label: "Issued by", type: "text" },
    { key: "issued_on", label: "Issued", type: "date" },
  ]],
  ["asset", "car", [
    { key: "registration", label: "Registration", type: "text" },
    { key: "insurer", label: "Insurer", type: "text" },
    { key: "insurance_expires", label: "Insurance ends", type: "expiry" },
    { key: "service_due", label: "Next service", type: "date" },
    { key: "mileage", label: "Mileage", type: "number" },
  ]],
  ["person", "organisation", [
    { key: "phone", label: "Phone", type: "text" },
    { key: "email", label: "Email", type: "text" },
    { key: "reference", label: "Your account or reference", type: "text" },
    { key: "url", label: "Website", type: "url" },
  ]],
  ["note", "decision", [
    { key: "decided_on", label: "Decided", type: "date" },
    { key: "revisit_on", label: "Look again", type: "date" },
  ]],
  ["note", "fact", [
    { key: "as_of", label: "True as of", type: "date" },
    { key: "source", label: "Where it came from", type: "text" },
  ]],
  ["place", "school", [{ key: "phone", label: "Phone", type: "text" }]],
  ["place", "garage", [{ key: "phone", label: "Phone", type: "text" }]],
];
