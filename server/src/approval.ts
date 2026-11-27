import type { Database } from "bun:sqlite";
import type { Tier } from "./types";

/** `review` waits for the owner. `auto` applies the proposal at once. `deny` refuses it. */
export type ApprovalMode = "review" | "auto" | "deny";

export const APPROVAL_MODES: ApprovalMode[] = ["review", "auto", "deny"];
export const POLICY_OPS = ["create", "update", "delete", "link", "unlink"];
export const ANY = "*";

export type PolicyRule = {
  id: string;
  source: string;
  op: string;
  entity_type: string;
  tier: string;
  mode: ApprovalMode;
  updated_at: string;
};

/** A class of proposal: where it comes from, what it does, to what, and at which tier. */
export type ProposalClass = {
  source: string;
  op: string;
  entityType: string | null;
  tier: Tier;
};

export function ensureApprovalTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_policies (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      op TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      tier TEXT NOT NULL,
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (source, op, entity_type, tier)
    );
  `);
  const names = new Set((db.query("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map((row) => row.name));
  if (names.size === 0) return;
  // `source` is set by the server. A caller cannot name its own source.
  if (!names.has("source")) db.exec("ALTER TABLE proposals ADD COLUMN source TEXT");
  // What an approval wrote, so that the owner can undo it.
  if (!names.has("applied")) db.exec("ALTER TABLE proposals ADD COLUMN applied TEXT");
  if (!names.has("undone_at")) db.exec("ALTER TABLE proposals ADD COLUMN undone_at TEXT");
  // A grant of the Private tier to one agent key. It ends at this instant.
  const credentialColumns = new Set((db.query("PRAGMA table_info(credentials)").all() as Array<{ name: string }>).map((row) => row.name));
  if (credentialColumns.size > 0 && !credentialColumns.has("private_until")) db.exec("ALTER TABLE credentials ADD COLUMN private_until TEXT");
  // A key can be allowed to read the owner's busy times. A guest is the agent of another person.
  if (credentialColumns.size > 0 && !credentialColumns.has("free_busy")) db.exec("ALTER TABLE credentials ADD COLUMN free_busy INTEGER NOT NULL DEFAULT 0");
  if (credentialColumns.size > 0 && !credentialColumns.has("guest")) db.exec("ALTER TABLE credentials ADD COLUMN guest INTEGER NOT NULL DEFAULT 0");
  // The credential that made this one. A key ends when its maker is revoked. Null is a credential from before this column, or from the first boot.
  if (credentialColumns.size > 0 && !credentialColumns.has("created_by")) db.exec("ALTER TABLE credentials ADD COLUMN created_by TEXT");
  // What the owner made this key for, in a few words. For the owner only: it is never sent to the agent.
  if (credentialColumns.size > 0 && !credentialColumns.has("purpose")) db.exec("ALTER TABLE credentials ADD COLUMN purpose TEXT");
  // The owner lets this key keep its own memory: it may ask for the feed of changed rows. Off by default.
  if (credentialColumns.size > 0 && !credentialColumns.has("memory")) db.exec("ALTER TABLE credentials ADD COLUMN memory INTEGER NOT NULL DEFAULT 0");
  // How many rows of the feed each key received, for the daily limit. The key is the name, so a rotated key keeps its count.
  db.exec("CREATE TABLE IF NOT EXISTS feed_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, key_name TEXT NOT NULL, n INTEGER NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_feed_log_key ON feed_log(key_name, at)");
  // The key that sent an inbox item, for the budget of that key. Null for an item from before this column.
  const inboxColumns = new Set((db.query("PRAGMA table_info(inbox_items)").all() as Array<{ name: string }>).map((row) => row.name));
  if (inboxColumns.size > 0 && !inboxColumns.has("credential_id")) db.exec("ALTER TABLE inbox_items ADD COLUMN credential_id TEXT");
  const pairingColumns = new Set((db.query("PRAGMA table_info(pairing_codes)").all() as Array<{ name: string }>).map((row) => row.name));
  if (pairingColumns.size > 0 && !pairingColumns.has("created_by")) db.exec("ALTER TABLE pairing_codes ADD COLUMN created_by TEXT");
  // A member of the household: the phone of a person, with a role. A code for a member makes a member credential.
  for (const table of ["credentials", "pairing_codes"]) {
    const columns = table === "credentials" ? credentialColumns : pairingColumns;
    if (columns.size > 0 && !columns.has("member_role")) db.exec(`ALTER TABLE ${table} ADD COLUMN member_role TEXT`);
    if (columns.size > 0 && !columns.has("person_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN person_id TEXT`);
  }
  // A caller that retries sends the same key. The second call returns the first proposal.
  if (!names.has("idempotency_key")) db.exec("ALTER TABLE proposals ADD COLUMN idempotency_key TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proposals_idempotency ON proposals(source, idempotency_key)");
  // What each agent key read. The audit log holds Private and Sealed reads only, and an agent reads Personal data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_reads (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      tier TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_reads_principal ON client_reads(principal_id, seq);
  `);
}

/**
 * Rules that hold when the owner has set no rule for the class. A calendar is the source of truth for its
 * events, so its mirror is accepted with no review. A rule from the owner always comes first.
 */
export const DEFAULT_RULES: PolicyRule[] = [
  { id: "default_calendar_create", source: "plugin:calendar", op: "create", entity_type: "event", tier: ANY, mode: "auto", updated_at: "" },
  { id: "default_calendar_update", source: "plugin:calendar", op: "update", entity_type: "event", tier: ANY, mode: "auto", updated_at: "" },
];

/** The mode for a class: the owner's rules, then the defaults, then review. */
export function modeFor(rules: PolicyRule[], cls: ProposalClass): ApprovalMode {
  return (ruleFor(rules, cls) ?? ruleFor(DEFAULT_RULES, cls))?.mode ?? "review";
}

/** The source of a proposal row. A row from before the column existed is read from the key. */
export function sourceOf(row: { source?: string | null; key_id: string | null }): string {
  if (row.source) return row.source;
  if (row.key_id?.startsWith("worker:")) return row.key_id;
  return `key:${row.key_id ?? "unknown"}`;
}

/** Only code inside the server can be auto-accepted: a worker or a plugin. An outside client has no grant yet. */
export function sourceCanAuto(source: string): boolean {
  return /^(worker|plugin):[a-z0-9_-]+$/.test(source);
}

/** A member of the household. The server names this source, from the member's credential. */
export function isMemberSource(source: string): boolean {
  return /^member:[A-Za-z0-9_]+$/.test(source);
}

function fieldMatches(rule: string, value: string | null): boolean {
  return rule === ANY || (value !== null && rule === value);
}

const STRICTNESS: Record<ApprovalMode, number> = { auto: 0, review: 1, deny: 2 };

/** The most specific rule wins. Between two rules of the same specificity, the stricter mode wins. */
export function ruleFor(rules: PolicyRule[], cls: ProposalClass): PolicyRule | null {
  let best: PolicyRule | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (!fieldMatches(rule.source, cls.source)) continue;
    if (!fieldMatches(rule.op, cls.op)) continue;
    if (!fieldMatches(rule.entity_type, cls.entityType)) continue;
    if (!fieldMatches(rule.tier, cls.tier)) continue;
    const score = [rule.source, rule.op, rule.entity_type, rule.tier].filter((field) => field !== ANY).length;
    if (score > bestScore || (score === bestScore && best && STRICTNESS[rule.mode] > STRICTNESS[best.mode])) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The reason a proposal is never auto-accepted, or null. These hold for every rule.
 * A patch that sets the tier or the area, and any patch to an area, can lower a tier, so it always waits for the owner.
 */
export function autoBlocked(cls: ProposalClass, payload: Record<string, unknown>): string | null {
  if (!sourceCanAuto(cls.source) && !isMemberSource(cls.source)) return "outside";
  if (cls.op === "delete") return "delete";
  if (cls.tier === "sealed") return "sealed";
  if (cls.op === "update") {
    // An area holds the tier of its items in `child_tier`. A patch to an area can lower all of them.
    if (cls.entityType === "area") return "tier";
    const patch = payload.patch && typeof payload.patch === "object" ? (payload.patch as Record<string, unknown>) : {};
    if ("tier" in patch || "area_id" in patch) return "tier";
  }
  return null;
}
