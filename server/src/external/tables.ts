import type { Database } from "bun:sqlite";

export function ensureExternalTables(db: Database) {
    try {
    db.exec("ALTER TABLE credentials ADD COLUMN external INTEGER NOT NULL DEFAULT 0");
  } catch {
    // The column is already there.
  }
  try {
    db.exec("ALTER TABLE credentials ADD COLUMN last_used_at TEXT");
  } catch {
    // The column is already there.
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_gate (
      id TEXT PRIMARY KEY CHECK (id = 'gate'),
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_oauth_clients (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_setup_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      ceiling TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_auth_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL,
      ceiling TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_sessions (
      id TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL UNIQUE,
      credential_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS external_rate (
      subject TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start TEXT NOT NULL
    );
  `);
  // The owner's credential that made a setup code. The key from that code ends when the maker is revoked.
  for (const table of ["external_setup_codes", "external_auth_codes"]) {
    const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("created_by")) db.exec(`ALTER TABLE ${table} ADD COLUMN created_by TEXT`);
  }
}

export function externalEnabled(db: Database): boolean {
  ensureExternalTables(db);
  const row = db.query("SELECT enabled FROM external_gate WHERE id = 'gate'").get() as { enabled: number } | null;
  return row?.enabled === 1;
}

export function setExternalEnabled(db: Database, enabled: boolean, at: string) {
  ensureExternalTables(db);
  db.query(
    `INSERT INTO external_gate (id, enabled, updated_at) VALUES ('gate', ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(enabled ? 1 : 0, at);
}
