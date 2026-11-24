import type { Database } from "bun:sqlite";

export function ensureDeviceTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trmnl_devices (
      id TEXT PRIMARY KEY,
      mac TEXT NOT NULL UNIQUE,
      friendly_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      model TEXT,
      firmware TEXT,
      status TEXT NOT NULL,
      credential_id TEXT,
      key_pending TEXT,
      claimed_at TEXT,
      delivered_at TEXT,
      last_seen_at TEXT,
      battery TEXT,
      rssi TEXT,
      width INTEGER,
      height INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trmnl_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      at TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
  // The address that first asked as a display, and a mark when a second address asked as the same display.
  const columns = new Set((db.query("PRAGMA table_info(trmnl_devices)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("setup_ip")) db.exec("ALTER TABLE trmnl_devices ADD COLUMN setup_ip TEXT");
  if (!columns.has("conflict")) db.exec("ALTER TABLE trmnl_devices ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0");
  // The tier that the display reads (public, or household for the fridge), and its inks (bw or bwry).
  if (!columns.has("ceiling")) db.exec("ALTER TABLE trmnl_devices ADD COLUMN ceiling TEXT NOT NULL DEFAULT 'public'");
  if (!columns.has("palette")) db.exec("ALTER TABLE trmnl_devices ADD COLUMN palette TEXT");
}
