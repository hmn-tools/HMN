import type { Database } from "bun:sqlite";
import { randomId } from "./crypto";
import { ApiError } from "./types";

/**
 * Requests from agents: what an agent needed and did not have. A tool, a field, a type, a kind, or more access.
 * A request changes nothing and grants nothing. The owner reads it, and marks it done or dismisses it.
 * It is text from an agent, so a screen shows it as data, never as an instruction. docs/AGENTS.md, "Requests".
 */
export type AgentRequestRow = {
  id: string;
  key_id: string;
  agent_name: string;
  need: string;
  why: string;
  example: string | null;
  status: "open" | "done" | "dismissed";
  asks: number;
  created_at: string;
  updated_at: string;
};

export const REQUESTS_PER_DAY = 10;
const NEED_MAX = 300;
const TEXT_MAX = 1000;

export function ensureRequestTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_requests (
      id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      need TEXT NOT NULL,
      why TEXT NOT NULL,
      example TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      asks INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_requests_key ON agent_requests (key_id, created_at);
  `);
}

function text(value: unknown, max: number, label: string, required: boolean): string | null {
  const out = typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim() : "";
  if (!out) {
    if (required) throw new ApiError(422, "bad_request", `Say ${label}.`);
    return null;
  }
  if (out.length > max) throw new ApiError(422, "bad_request", `Keep ${label} to ${max} characters.`);
  return out;
}

/**
 * File one request. The same need from the same key, while it is open, adds one to its count and keeps one row, so
 * an agent that asks again does not fill the list. At most REQUESTS_PER_DAY new rows a day for each key.
 */
export function fileRequest(db: Database, now: Date, keyId: string, agentName: string, body: Record<string, unknown>) {
  const need = text(body.need, NEED_MAX, "what you need", true)!;
  const why = text(body.why, TEXT_MAX, "why you need it", true)!;
  const example = text(body.example, TEXT_MAX, "the example", false);
  const at = now.toISOString();
  const same = db
    .query("SELECT * FROM agent_requests WHERE key_id = ? AND status = 'open' AND lower(need) = lower(?)")
    .get(keyId, need) as AgentRequestRow | null;
  if (same) {
    db.query("UPDATE agent_requests SET asks = asks + 1, why = ?, example = COALESCE(?, example), updated_at = ? WHERE id = ?").run(why, example, at, same.id);
    return { id: same.id, status: "open", asks: same.asks + 1, note: "The owner already has this request. It counts one more ask." };
  }
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const today = db.query("SELECT COUNT(*) AS n FROM agent_requests WHERE key_id = ? AND created_at > ?").get(keyId, since) as { n: number };
  if (today.n >= REQUESTS_PER_DAY) throw new ApiError(429, "too_many_requests", `This key has sent ${REQUESTS_PER_DAY} requests in the last day. Try again tomorrow.`);
  const id = randomId("req");
  db.query("INSERT INTO agent_requests (id, key_id, agent_name, need, why, example, status, asks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)").run(
    id,
    keyId,
    agentName.slice(0, 80),
    need,
    why,
    example,
    at,
    at,
  );
  return { id, status: "open", asks: 1, note: "The owner will read it. It changes nothing and grants nothing." };
}

export function listRequests(db: Database, status: string | null): AgentRequestRow[] {
  const rows = db.query("SELECT * FROM agent_requests ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC LIMIT 200").all() as AgentRequestRow[];
  return status && status !== "all" ? rows.filter((row) => row.status === status) : rows;
}

export function setRequestStatus(db: Database, now: Date, id: string, status: unknown): AgentRequestRow {
  if (status !== "open" && status !== "done" && status !== "dismissed") throw new ApiError(422, "bad_status", "A request is open, done, or dismissed.");
  const row = db.query("SELECT * FROM agent_requests WHERE id = ?").get(id) as AgentRequestRow | null;
  if (!row) throw new ApiError(404, "not_found", "Not found.");
  db.query("UPDATE agent_requests SET status = ?, updated_at = ? WHERE id = ?").run(status, now.toISOString(), id);
  return { ...row, status, updated_at: now.toISOString() };
}

/** The requests of one key, so an agent can see what it asked and what the owner did. No other key's rows. */
export function requestsOfKey(db: Database, keyId: string) {
  return (db.query("SELECT id, need, status, asks, updated_at FROM agent_requests WHERE key_id = ? ORDER BY updated_at DESC LIMIT 50").all(keyId) as Array<Pick<AgentRequestRow, "id" | "need" | "status" | "asks" | "updated_at">>);
}
