import type { Database } from "bun:sqlite";

/** Worker config lives beside the graph. Created here so the core schema file can stay still. */
export function ensureWorkerTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      tier TEXT NOT NULL,
      schedule TEXT NOT NULL,
      llm_mode TEXT NOT NULL,
      llm_endpoint TEXT,
      llm_model TEXT,
      cloud_enabled INTEGER NOT NULL,
      cloud_endpoint TEXT,
      cloud_tier TEXT,
      cloud_warning_ack INTEGER NOT NULL,
      last_run_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_runs (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      at TEXT NOT NULL,
      llm TEXT NOT NULL,
      warning TEXT,
      proposal_ids TEXT NOT NULL,
      summary TEXT NOT NULL
    );
  `);
  // A worker draft has a source key, so that a decision is remembered. A draft about a date has a last day.
  const names = new Set((db.query("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map((row) => row.name));
  if (names.size > 0) {
    if (!names.has("source_key")) db.exec("ALTER TABLE proposals ADD COLUMN source_key TEXT");
    if (!names.has("expires_on")) db.exec("ALTER TABLE proposals ADD COLUMN expires_on TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_source ON proposals(key_id, source_key)");
  }
}
