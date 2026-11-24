import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { randomCode, randomId, randomSecret, sha256hex } from "../crypto";
import type { Hmn } from "../hmn";
import { type Access, ApiError, type Tier } from "../types";
import { assertNotHidden } from "../policy";
import { ensureExternalTables, externalEnabled, setExternalEnabled } from "./tables";

/** An outside client does not read an area whose kind has the role `health` or `money`. */
const DENY = JSON.stringify(["role:health", "role:money"]);
const WINDOW_MS = 10 * 60_000;

export function isLoopback(ip: string | null): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function requireOwner(hmn: Hmn, access: Access, ip: string | null) {
  if (access.principal.scope !== "write") throw new ApiError(403, "forbidden", "The owner turns outside clients on.");
  if (!isLoopback(ip)) throw new ApiError(403, "localhost", "Outside clients are managed on the mini itself.");
  assertNotHidden(access);
  ensureExternalTables(hmn.store.db);
}

export function gateStatus(hmn: Hmn) {
  ensureExternalTables(hmn.store.db);
  return { enabled: externalEnabled(hmn.store.db), port: process.env.HMN_EXTERNAL_PORT ?? "8788" };
}

export function setGate(hmn: Hmn, enabled: boolean) {
  setExternalEnabled(hmn.store.db, enabled, hmnNow(hmn));
  hmn.store.persist();
  return gateStatus(hmn);
}

/**
 * A key for an outside client. A guest is the agent of another person: it reads Public only, and it can
 * propose an event or an inbox item. `freeBusy` lets the key read the owner's busy times.
 */
export function issueBearer(hmn: Hmn, name: string, ceiling: Tier, options: { guest?: boolean; freeBusy?: boolean; createdBy?: string | null } = {}) {
  const guest = options.guest === true;
  const cap = guest ? "public" : externalCap(ceiling);
  const secret = randomSecret();
  const id = randomId("external");
  const now = hmnNow(hmn);
  const expires = new Date(new Date(now).getTime() + 30 * 86_400_000).toISOString();
  hmn.store.db
    .query(
      `INSERT INTO credentials (
        id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
        forced_ceiling, expires_at, created_at, revoked_at, rotated_from, external, guest, free_busy, created_by
      ) VALUES (?, ?, 'key', ?, 'agent', ?, 0, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?)`,
    )
    .run(id, `external:${name}`.slice(0, 80), sha256hex(secret), cap, DENY, cap, expires, now, guest ? 1 : 0, options.freeBusy === true ? 1 : 0, options.createdBy ?? null);
  hmn.store.persist();
  return { id, token: secret, ceiling: cap, expires_at: expires, name, guest, free_busy: options.freeBusy === true };
}

export function issueSetupCode(hmn: Hmn, ceiling: Tier, createdBy: string | null = null) {
  const cap = externalCap(ceiling);
  // 12 characters from 32: 60 bits. A failed code also counts toward a limit for all codes (see setupFailures).
  const code = randomCode(12);
  const now = hmnNow(hmn);
  const expires = new Date(new Date(now).getTime() + 10 * 60_000).toISOString();
  hmn.store.db
    .query("INSERT INTO external_setup_codes (id, code_hash, ceiling, expires_at, used_at, created_at, created_by) VALUES (?, ?, ?, ?, NULL, ?, ?)")
    .run(randomId("setup"), sha256hex(code), cap, expires, now, createdBy);
  hmn.store.persist();
  return { code, ceiling: cap, expires_at: expires };
}

/** Registration needs no key. So a client that has not finished its sign-in is kept one hour, and only a few wait at a time. */
const UNUSED_CLIENT_MS = 3_600_000;
const UNUSED_CLIENTS_MAX = 10;

export function registerClient(hmn: Hmn, name: string, redirects: string[]) {
  if (!externalEnabled(hmn.store.db)) throw new ApiError(404, "not_found", "Not found.");
  const used = "SELECT 1 FROM external_auth_codes WHERE external_auth_codes.client_id = external_oauth_clients.client_id AND used_at IS NOT NULL";
  const cutoff = new Date(new Date(hmnNow(hmn)).getTime() - UNUSED_CLIENT_MS).toISOString();
  hmn.store.db.query(`DELETE FROM external_oauth_clients WHERE created_at < ? AND NOT EXISTS (${used})`).run(cutoff);
  const waiting = hmn.store.db.query(`SELECT COUNT(*) AS n FROM external_oauth_clients WHERE NOT EXISTS (${used})`).get() as { n: number };
  if (waiting.n >= UNUSED_CLIENTS_MAX) throw new ApiError(429, "rate", "Too many clients wait for a sign-in. Try again in an hour.");
  const uris = redirects.filter((uri) => allowedRedirect(uri)).slice(0, 5);
  if (uris.length === 0) throw new ApiError(422, "redirect", "A redirect URI must be https, or http on localhost.");
  const clientId = randomBytes(16).toString("base64url");
  const now = hmnNow(hmn);
  hmn.store.db
    .query("INSERT INTO external_oauth_clients (id, client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomId("client"), clientId, name.slice(0, 80) || "MCP client", JSON.stringify(uris), now);
  hmn.store.persist();
  return { client_id: clientId, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] };
}

export function consumeSetupCode(hmn: Hmn, code: string): { ceiling: Tier; createdBy: string | null } | null {
  const now = hmnNow(hmn);
  const row = hmn.store.db.query("SELECT * FROM external_setup_codes WHERE code_hash = ?").get(sha256hex(code)) as { id: string; ceiling: string; expires_at: string; used_at: string | null; created_by: string | null } | null;
  if (!row || row.used_at || row.expires_at <= now) return null;
  hmn.store.db.query("UPDATE external_setup_codes SET used_at = ? WHERE id = ?").run(now, row.id);
  return { ceiling: row.ceiling === "public" || row.ceiling === "household" ? row.ceiling : "personal", createdBy: row.created_by ?? null };
}

/** Ten wrong setup codes in ten minutes close the consent form for all clients until the window ends. */
const SETUP_FAILURES_MAX = 10;

export function setupLocked(hmn: Hmn): boolean {
  const row = hmn.store.db.query("SELECT count, window_start FROM external_rate WHERE subject = 'setup-failures'").get() as { count: number; window_start: string } | null;
  if (!row) return false;
  if (Date.now() - Date.parse(row.window_start) > WINDOW_MS) return false;
  return row.count >= SETUP_FAILURES_MAX;
}

export function noteSetupFailure(hmn: Hmn) {
  const now = new Date(hmnNow(hmn));
  const row = hmn.store.db.query("SELECT count, window_start FROM external_rate WHERE subject = 'setup-failures'").get() as { count: number; window_start: string } | null;
  if (!row || now.getTime() - Date.parse(row.window_start) > WINDOW_MS) {
    hmn.store.db.query("INSERT INTO external_rate (subject, count, window_start) VALUES ('setup-failures', 1, ?) ON CONFLICT(subject) DO UPDATE SET count = 1, window_start = excluded.window_start").run(now.toISOString());
    return;
  }
  hmn.store.db.query("UPDATE external_rate SET count = count + 1 WHERE subject = 'setup-failures'").run();
}

export function clientName(hmn: Hmn, clientId: string): string | null {
  const row = hmn.store.db.query("SELECT name FROM external_oauth_clients WHERE client_id = ?").get(clientId) as { name: string } | null;
  return row?.name ?? null;
}

export function clientRedirects(hmn: Hmn, clientId: string): string[] {
  const row = hmn.store.db.query("SELECT redirect_uris FROM external_oauth_clients WHERE client_id = ?").get(clientId) as { redirect_uris: string } | null;
  if (!row) return [];
  const parsed = JSON.parse(row.redirect_uris) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
}

export function saveAuthCode(hmn: Hmn, input: { clientId: string; redirect: string; challenge: string; ceiling: Tier; createdBy?: string | null }) {
  const code = randomBytes(24).toString("base64url");
  const now = hmnNow(hmn);
  const expires = new Date(new Date(now).getTime() + 5 * 60_000).toISOString();
  hmn.store.db
    .query(
      `INSERT INTO external_auth_codes (id, code_hash, client_id, redirect_uri, challenge, ceiling, expires_at, used_at, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(randomId("auth"), sha256hex(code), input.clientId, input.redirect, input.challenge, input.ceiling, expires, now, input.createdBy ?? null);
  hmn.store.persist();
  return code;
}

export function redeemAuthCode(hmn: Hmn, code: string, verifier: string, redirect: string): { token: string; ceiling: Tier; expires_at: string } | null {
  const now = hmnNow(hmn);
  const row = hmn.store.db.query("SELECT * FROM external_auth_codes WHERE code_hash = ?").get(sha256hex(code)) as {
    id: string;
    client_id: string;
    redirect_uri: string;
    challenge: string;
    ceiling: string;
    expires_at: string;
    used_at: string | null;
    created_by: string | null;
  } | null;
  if (!row || row.used_at || row.expires_at <= now || row.redirect_uri !== redirect) return null;
  if (s256(verifier) !== row.challenge) return null;
  hmn.store.db.query("UPDATE external_auth_codes SET used_at = ? WHERE id = ?").run(now, row.id);
  const ceiling: Tier = row.ceiling === "public" || row.ceiling === "household" ? row.ceiling : "personal";
  const issued = issueBearer(hmn, row.client_id.slice(0, 24), ceiling, { createdBy: row.created_by ?? null });
  return { token: issued.token, ceiling, expires_at: issued.expires_at };
}

export function openSession(hmn: Hmn, credentialId: string): string {
  const session = randomBytes(24).toString("base64url");
  const now = hmnNow(hmn);
  const expires = new Date(new Date(now).getTime() + 24 * 3_600_000).toISOString();
  hmn.store.db
    .query("INSERT INTO external_sessions (id, session_hash, credential_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomId("session"), sha256hex(session), credentialId, expires, now);
  return session;
}

export function sessionOk(hmn: Hmn, session: string | null, credentialId: string): boolean {
  if (!session) return false;
  const now = hmnNow(hmn);
  const row = hmn.store.db.query("SELECT credential_id, expires_at FROM external_sessions WHERE session_hash = ?").get(sha256hex(session)) as { credential_id: string; expires_at: string } | null;
  return Boolean(row && row.credential_id === credentialId && row.expires_at > now);
}

export function hitRate(hmn: Hmn, subject: string): boolean {
  const limit = Number(process.env.HMN_EXTERNAL_RATE_LIMIT ?? "60");
  const now = new Date(hmnNow(hmn));
  const row = hmn.store.db.query("SELECT count, window_start FROM external_rate WHERE subject = ?").get(subject) as { count: number; window_start: string } | null;
  if (!row || now.getTime() - Date.parse(row.window_start) > WINDOW_MS) {
    hmn.store.db.query("INSERT INTO external_rate (subject, count, window_start) VALUES (?, 1, ?) ON CONFLICT(subject) DO UPDATE SET count = 1, window_start = excluded.window_start").run(subject, now.toISOString());
    return true;
  }
  if (row.count >= limit) return false;
  hmn.store.db.query("UPDATE external_rate SET count = count + 1 WHERE subject = ?").run(subject);
  return true;
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function allowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

export function externalCap(ceiling: Tier): Tier {
  if (ceiling === "public") return "public";
  if (ceiling === "household") return "household";
  if (ceiling === "personal") return "personal";
  throw new ApiError(422, "bad_tier", "An outside client is Public, Household, or Personal. Private and Sealed are refused.");
}

function hmnNow(hmn: Hmn): string {
  return new Date().toISOString();
}
