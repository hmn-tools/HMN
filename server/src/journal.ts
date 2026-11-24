import { randomId } from "./crypto";
import type { Hmn } from "./hmn";
import { covers } from "./types";
import type { Access, Tier } from "./types";

export type JournalItem = { id: string; type: string; title: string; tier: Tier; reason?: string };

export type JournalEntry = {
  id: string;
  actor_id: string;
  name: string;
  at: string;
  model: string;
  why: string;
  read: JournalItem[];
  proposed: JournalItem[];
  hidden: boolean;
};

export function ensureJournals(db: Hmn["store"]["db"]) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journals (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      name TEXT NOT NULL,
      at TEXT NOT NULL,
      model TEXT NOT NULL,
      read_json TEXT NOT NULL,
      proposed_json TEXT NOT NULL,
      why TEXT NOT NULL
    );
  `);
}

export function writeJournal(
  hmn: Hmn,
  input: { id?: string; actorId: string; name: string; model: string; why: string; read: JournalItem[]; proposed: JournalItem[] },
): string {
  ensureJournals(hmn.store.db);
  const id = input.id ?? randomId("journal");
  hmn.store.db
    .query("INSERT INTO journals (id, actor_id, name, at, model, read_json, proposed_json, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      id,
      input.actorId,
      input.name.slice(0, 80),
      new Date().toISOString(),
      input.model.slice(0, 80),
      JSON.stringify(input.read.slice(0, 12)),
      JSON.stringify(input.proposed.slice(0, 12)),
      input.why.slice(0, 500),
    );
  return id;
}

export function listJournals(hmn: Hmn, access: Access, actorId: string): JournalEntry[] {
  ensureJournals(hmn.store.db);
  const rows = hmn.store.db
    .query("SELECT * FROM journals WHERE actor_id = ? ORDER BY at DESC LIMIT 20")
    .all(actorId) as Array<{ id: string; actor_id: string; name: string; at: string; model: string; read_json: string; proposed_json: string; why: string }>;
  return rows.map((row) => present(row, access.ceiling));
}

export function getJournal(hmn: Hmn, access: Access, id: string): JournalEntry | null {
  ensureJournals(hmn.store.db);
  const row = hmn.store.db.query("SELECT * FROM journals WHERE id = ?").get(id) as { id: string; actor_id: string; name: string; at: string; model: string; read_json: string; proposed_json: string; why: string } | null;
  return row ? present(row, access.ceiling) : null;
}

export function journalForProposal(hmn: Hmn, proposalId: string): string | null {
  ensureJournals(hmn.store.db);
  const rows = hmn.store.db.query("SELECT id, proposed_json FROM journals ORDER BY at DESC LIMIT 100").all() as Array<{ id: string; proposed_json: string }>;
  for (const row of rows) {
    if (row.proposed_json.includes(proposalId)) return row.id;
  }
  return null;
}

function present(row: { id: string; actor_id: string; name: string; at: string; model: string; read_json: string; proposed_json: string; why: string }, ceiling: Tier): JournalEntry {
  const read = parseItems(row.read_json);
  const proposed = parseItems(row.proposed_json);
  const hidden = read.some((item) => !covers(ceiling, item.tier)) || proposed.some((item) => !covers(ceiling, item.tier));
  return {
    id: row.id,
    actor_id: row.actor_id,
    name: row.name,
    at: row.at,
    model: row.model,
    // The reason is free text from the run. When the reader cannot see each item of the run, it gets no reason.
    why: hidden ? "" : row.why,
    read: read.filter((item) => covers(ceiling, item.tier)),
    proposed: proposed.filter((item) => covers(ceiling, item.tier)),
    hidden,
  };
}

function parseItems(value: string): JournalItem[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === "object" && typeof (item as JournalItem).title === "string") as JournalItem[];
  } catch {
    return [];
  }
}
