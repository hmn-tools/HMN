import type { Database } from "bun:sqlite";
import type { Tier } from "../types";
import { catalog } from "./catalog";
import { MODEL_TASKS, type ModelSpec, type ModelTask } from "./policy";

export type ModelRow = ModelSpec & {
  installed: boolean;
  pinnedVersion: string | null;
};

export type ModelStats = {
  modelId: string;
  calls: number;
  errors: number;
  latencyMs: number;
  tokens: number;
};

export function ensureModelSchema(db: Database) {
  const columns = db.query("PRAGMA table_info(proposals)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("model_id")) db.exec("ALTER TABLE proposals ADD COLUMN model_id TEXT");
  if (!names.has("model_version")) db.exec("ALTER TABLE proposals ADD COLUMN model_version TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_routes (
      task TEXT PRIMARY KEY,
      model_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_stats (
      model_id TEXT PRIMARY KEY,
      calls INTEGER NOT NULL,
      errors INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_pins (
      model_id TEXT PRIMARY KEY,
      version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_installed (
      model_id TEXT PRIMARY KEY,
      installed INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_vectors (
      entity_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      vector TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS model_cloud (
      id TEXT PRIMARY KEY,
      endpoint TEXT,
      opt_in INTEGER NOT NULL,
      ceiling TEXT
    );
    CREATE TABLE IF NOT EXISTS model_egress (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      month TEXT NOT NULL,
      model_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      chars INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      entities TEXT NOT NULL,
      usd REAL NOT NULL,
      blocked INTEGER NOT NULL,
      capped INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_budget (
      id TEXT PRIMARY KEY CHECK (id = 'month'),
      cap_usd REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_notices (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      month TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
  const count = db.query("SELECT COUNT(*) AS n FROM model_routes").get() as { n: number };
  if (count.n === 0) {
    const chat = process.env.HMN_LLM_MODEL?.trim() || "hmn.fallback";
    const chatId = chat.startsWith("ollama:") || chat === "hmn.fallback" ? chat : `ollama:${chat}`;
    const seed: Array<[ModelTask, string]> = [
      ["morning_brief", chatId],
      ["triage", chatId],
      ["weekly_review", chatId],
      ["chat", chatId],
      ["search_embeddings", "ollama:nomic-embed-text"],
      ["transcription", "apple.speech"],
    ];
    for (const [task, modelId] of seed) {
      db.query("INSERT INTO model_routes (task, model_id) VALUES (?, ?)").run(task, modelId);
    }
  }
}

export function listModels(db: Database, discovered: Set<string>): ModelRow[] {
  ensureModelSchema(db);
  const pins = new Map(
    (db.query("SELECT model_id, version FROM model_pins").all() as Array<{ model_id: string; version: string }>).map((row) => [
      row.model_id,
      row.version,
    ]),
  );
  const forced = new Map(
    (db.query("SELECT model_id, installed FROM model_installed").all() as Array<{ model_id: string; installed: number }>).map(
      (row) => [row.model_id, row.installed === 1],
    ),
  );
  const grant = cloudGrant(db);
  return catalog().map((model) => {
    const pinnedVersion = pins.get(model.id) ?? null;
    let installed = model.runtime === "fallback" || model.runtime === "apple";
    let endpoint = model.endpoint;
    if (model.runtime === "ollama") installed = discovered.has(model.name);
    if (model.id === "cloud:openai") {
      endpoint = grant.endpoint;
      installed = grant.optIn && Boolean(grant.endpoint);
    }
    if (forced.has(model.id)) installed = forced.get(model.id) === true;
    return { ...model, endpoint, version: pinnedVersion ?? model.version, installed, pinnedVersion };
  });
}

export function routes(db: Database): Record<ModelTask, string> {
  ensureModelSchema(db);
  const rows = db.query("SELECT task, model_id FROM model_routes").all() as Array<{ task: string; model_id: string }>;
  const out = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) out[task] = "hmn.fallback";
  for (const row of rows) {
    if ((MODEL_TASKS as string[]).includes(row.task)) out[row.task as ModelTask] = row.model_id;
  }
  return out;
}

export function setRoute(db: Database, task: ModelTask, modelId: string) {
  ensureModelSchema(db);
  db.query("INSERT INTO model_routes (task, model_id) VALUES (?, ?) ON CONFLICT(task) DO UPDATE SET model_id = excluded.model_id").run(
    task,
    modelId,
  );
}

export function setInstalled(db: Database, modelId: string, installed: boolean) {
  ensureModelSchema(db);
  db.query("INSERT INTO model_installed (model_id, installed) VALUES (?, ?) ON CONFLICT(model_id) DO UPDATE SET installed = excluded.installed").run(
    modelId,
    installed ? 1 : 0,
  );
}

export function pinModel(db: Database, modelId: string, version: string) {
  ensureModelSchema(db);
  db.query("INSERT INTO model_pins (model_id, version) VALUES (?, ?) ON CONFLICT(model_id) DO UPDATE SET version = excluded.version").run(
    modelId,
    version,
  );
}

export function recordStat(db: Database, modelId: string, latencyMs: number, tokens: number, error: boolean, at: string) {
  ensureModelSchema(db);
  db.query(
    `INSERT INTO model_stats (model_id, calls, errors, latency_ms, tokens, updated_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(model_id) DO UPDATE SET
       calls = calls + 1,
       errors = errors + ?,
       latency_ms = latency_ms + ?,
       tokens = tokens + ?,
       updated_at = excluded.updated_at`,
  ).run(modelId, error ? 1 : 0, latencyMs, tokens, at, error ? 1 : 0, latencyMs, tokens);
}

export function readStats(db: Database): ModelStats[] {
  ensureModelSchema(db);
  return (db.query("SELECT * FROM model_stats").all() as Array<Record<string, number | string>>).map((row) => ({
    modelId: String(row.model_id),
    calls: Number(row.calls),
    errors: Number(row.errors),
    latencyMs: Number(row.latency_ms),
    tokens: Number(row.tokens),
  }));
}

export function cloudGrant(db: Database): { optIn: boolean; ceiling: Tier | null; endpoint: string | null } {
  ensureModelSchema(db);
  const row = db.query("SELECT endpoint, opt_in, ceiling FROM model_cloud WHERE id = 'default'").get() as
    | { endpoint: string | null; opt_in: number; ceiling: string | null }
    | null;
  if (!row) return { optIn: false, ceiling: null, endpoint: null };
  const ceiling = row.ceiling === "public" || row.ceiling === "household" || row.ceiling === "personal" ? row.ceiling : null;
  return { optIn: row.opt_in === 1, ceiling, endpoint: row.endpoint };
}

export function setCloudGrant(db: Database, optIn: boolean, ceiling: Tier | null, endpoint: string | null) {
  ensureModelSchema(db);
  db.query(
    `INSERT INTO model_cloud (id, endpoint, opt_in, ceiling) VALUES ('default', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET endpoint = excluded.endpoint, opt_in = excluded.opt_in, ceiling = excluded.ceiling`,
  ).run(endpoint, optIn ? 1 : 0, ceiling);
}

export function writeVector(db: Database, entityId: string, modelId: string, tier: string, vector: number[], at: string) {
  ensureModelSchema(db);
  db.query(
    `INSERT INTO model_vectors (entity_id, model_id, tier, vector, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, model_id) DO UPDATE SET tier = excluded.tier, vector = excluded.vector, updated_at = excluded.updated_at`,
  ).run(entityId, modelId, tier, JSON.stringify(vector), at);
}

export function readVectors(db: Database, modelId: string): Array<{ entityId: string; tier: string; vector: number[] }> {
  ensureModelSchema(db);
  const rows = db.query("SELECT entity_id, tier, vector FROM model_vectors WHERE model_id = ?").all(modelId) as Array<{
    entity_id: string;
    tier: string;
    vector: string;
  }>;
  return rows.map((row) => ({ entityId: row.entity_id, tier: row.tier, vector: JSON.parse(row.vector) as number[] }));
}

export function readCap(db: Database): number {
  ensureModelSchema(db);
  const row = db.query("SELECT cap_usd FROM model_budget WHERE id = 'month'").get() as { cap_usd: number } | null;
  return row ? Number(row.cap_usd) : 10;
}

export function setCap(db: Database, usd: number) {
  ensureModelSchema(db);
  db.query("INSERT INTO model_budget (id, cap_usd) VALUES ('month', ?) ON CONFLICT(id) DO UPDATE SET cap_usd = excluded.cap_usd").run(usd);
}

export function monthSpend(db: Database, month: string): { chars: number; tokens: number; usd: number } {
  ensureModelSchema(db);
  const row = db
    .query(
      "SELECT COALESCE(SUM(chars), 0) AS chars, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(usd), 0) AS usd FROM model_egress WHERE month = ? AND blocked = 0 AND capped = 0",
    )
    .get(month) as { chars: number; tokens: number; usd: number };
  return { chars: Number(row.chars), tokens: Number(row.tokens), usd: Number(row.usd) };
}

export function writeEgress(
  db: Database,
  row: {
    id: string;
    at: string;
    month: string;
    modelId: string;
    destination: string;
    chars: number;
    tokens: number;
    entities: Array<{ id: string; tier: string }>;
    usd: number;
    blocked: boolean;
    capped: boolean;
  },
) {
  ensureModelSchema(db);
  db.query(
    `INSERT INTO model_egress (id, at, month, model_id, destination, chars, tokens, entities, usd, blocked, capped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.at,
    row.month,
    row.modelId,
    row.destination,
    row.chars,
    row.tokens,
    JSON.stringify(row.entities),
    row.usd,
    row.blocked ? 1 : 0,
    row.capped ? 1 : 0,
  );
}

export function writeNotice(db: Database, month: string, at: string, message: string) {
  ensureModelSchema(db);
  db.query(
    `INSERT INTO model_notices (id, at, month, message) VALUES ('current', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET at = excluded.at, month = excluded.month, message = excluded.message`,
  ).run(at, month, message);
}

export function readNotice(db: Database, month: string): string | null {
  ensureModelSchema(db);
  const row = db.query("SELECT message, month FROM model_notices WHERE id = 'current'").get() as { message: string; month: string } | null;
  if (!row || row.month !== month) return null;
  return row.message;
}
