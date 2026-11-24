import type { Database } from "bun:sqlite";
import { ApiError, isTier, looser, type Tier } from "../types";
import { ensureWorkerTables } from "./tables";

export const WORKER_IDS = ["morning", "weekly", "triage", "people", "fixtures", "goals"] as const;
export type WorkerId = (typeof WORKER_IDS)[number];
export type LlmMode = "fallback" | "local" | "cloud";

export type WorkerConfig = {
  id: WorkerId;
  name: string;
  kind: WorkerId;
  enabled: boolean;
  tier: Tier;
  schedule: string;
  llm_mode: LlmMode;
  llm_endpoint: string;
  llm_model: string;
  cloud_enabled: boolean;
  cloud_endpoint: string | null;
  cloud_tier: Tier | null;
  cloud_warning_ack: boolean;
  last_run_at: string | null;
  updated_at: string;
};

const DEFAULT_LOCAL = "http://127.0.0.1:11434/api/chat";

const DEFAULTS: Array<Pick<WorkerConfig, "id" | "name" | "kind" | "schedule" | "tier">> = [
  { id: "morning", name: "Morning", kind: "morning", schedule: "daily:07:00", tier: "personal" },
  { id: "weekly", name: "Week", kind: "weekly", schedule: "weekly:0:18:00", tier: "personal" },
  { id: "triage", name: "Triage", kind: "triage", schedule: "hourly", tier: "personal" },
  { id: "people", name: "People", kind: "people", schedule: "daily:07:30", tier: "private" },
  { id: "fixtures", name: "Fixtures", kind: "fixtures", schedule: "weekly:1:07:00", tier: "public" },
  { id: "goals", name: "Goals", kind: "goals", schedule: "monthly:1:08:00", tier: "personal" },
];

type Row = {
  id: string;
  name: string;
  kind: string;
  enabled: number;
  tier: string;
  schedule: string;
  llm_mode: string;
  llm_endpoint: string | null;
  llm_model: string | null;
  cloud_enabled: number;
  cloud_endpoint: string | null;
  cloud_tier: string | null;
  cloud_warning_ack: number;
  last_run_at: string | null;
  updated_at: string;
};

export function effectiveWorkerTier(tier: Tier): Tier {
  if (tier === "sealed") throw new ApiError(422, "bad_tier", "Workers cannot use the Sealed tier.");
  return looser(tier, "personal");
}

/** People may read Private so family reminders stay in the family tier. Every other worker stops at Personal. Nobody reads Sealed. */
export function ceilingFor(worker: Pick<WorkerConfig, "id" | "tier">): Tier {
  if (worker.tier === "sealed") throw new ApiError(422, "bad_tier", "Workers cannot use the Sealed tier.");
  if (worker.id === "people") return looser(worker.tier, "private");
  return looser(worker.tier, "personal");
}

/** Cloud receives the lower of the worker ceiling and the tier the owner named. */
export function sendTierOf(worker: Pick<WorkerConfig, "id" | "tier" | "llm_mode" | "cloud_tier">): Tier {
  const cap = ceilingFor(worker);
  if (worker.llm_mode !== "cloud" || !worker.cloud_tier) return cap;
  return looser(cap, effectiveWorkerTier(worker.cloud_tier));
}

export function cloudWarning(host: string, tier: Tier): string {
  return `Cloud is on for this worker. Data up to ${tier} may be sent to ${host}. Sealed data is never sent. Health and Money are never sent. Nothing is written until you approve a proposal. Turn cloud off if you did not mean to enable it.`;
}

export function ensureWorkers(db: Database, nowIso: string) {
  ensureWorkerTables(db);
  const mode: LlmMode = loopbackEnvUrl() ? "local" : "fallback";
  const endpoint = loopbackEnvUrl() ?? DEFAULT_LOCAL;
  const model = process.env.HMN_LLM_MODEL?.trim() || "llama3.2";
  for (const worker of DEFAULTS) {
    db.query(
      `INSERT OR IGNORE INTO worker_configs (
        id, name, kind, enabled, tier, schedule, llm_mode, llm_endpoint, llm_model,
        cloud_enabled, cloud_endpoint, cloud_tier, cloud_warning_ack, last_run_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, NULL, ?)`,
    ).run(worker.id, worker.name, worker.kind, worker.tier, worker.schedule, mode, endpoint, model, nowIso);
  }
}

export function listWorkers(db: Database, nowIso: string): WorkerConfig[] {
  ensureWorkers(db, nowIso);
  const rows = db.query("SELECT * FROM worker_configs ORDER BY id").all() as Row[];
  return rows.map(fromRow);
}

export function getWorker(db: Database, id: string, nowIso: string): WorkerConfig {
  ensureWorkers(db, nowIso);
  const row = db.query("SELECT * FROM worker_configs WHERE id = ?").get(id) as Row | null;
  if (!row) throw new ApiError(404, "not_found", "Not found.");
  return fromRow(row);
}

export function saveWorker(db: Database, id: string, patch: Record<string, unknown>, nowIso: string): { worker: WorkerConfig; warning: string | null } {
  const current = getWorker(db, id, nowIso);
  const next = { ...current };
  if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name.trim().slice(0, 40);
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.tier === "string") {
    if (!isTier(patch.tier) || patch.tier === "sealed") {
      throw new ApiError(422, "bad_tier", "A worker tier is public, personal, or private. Sealed is refused.");
    }
    next.tier = patch.tier;
  }
  if (typeof patch.schedule === "string") {
    if (!validSchedule(patch.schedule)) throw new ApiError(422, "bad_schedule", "Use hourly, daily:HH:MM, weekly:D:HH:MM, or monthly:D:HH:MM.");
    next.schedule = patch.schedule;
  }
  if (typeof patch.llm_mode === "string") {
    if (patch.llm_mode !== "fallback" && patch.llm_mode !== "local" && patch.llm_mode !== "cloud") {
      throw new ApiError(422, "bad_llm", "The model is fallback, local, or cloud.");
    }
    next.llm_mode = patch.llm_mode;
  }
  if (typeof patch.llm_endpoint === "string") {
    assertLocalEndpoint(patch.llm_endpoint);
    next.llm_endpoint = patch.llm_endpoint;
  }
  if (typeof patch.llm_model === "string" && patch.llm_model.trim()) next.llm_model = patch.llm_model.trim().slice(0, 80);
  if (typeof patch.cloud_endpoint === "string") {
    assertCloudEndpoint(patch.cloud_endpoint);
    next.cloud_endpoint = patch.cloud_endpoint;
  }
  if (typeof patch.cloud_tier === "string") {
    if (!isTier(patch.cloud_tier) || patch.cloud_tier === "sealed") {
      throw new ApiError(422, "bad_tier", "Cloud can be public, personal, or private. Sealed is refused.");
    }
    next.cloud_tier = patch.cloud_tier;
  }
  if (typeof patch.cloud_warning_ack === "boolean") next.cloud_warning_ack = patch.cloud_warning_ack;
  if (typeof patch.cloud_enabled === "boolean") next.cloud_enabled = patch.cloud_enabled;

  if (patch.cloud_enabled === false) {
    next.cloud_enabled = false;
    if (next.llm_mode === "cloud") next.llm_mode = "fallback";
  }
  if ((patch.llm_mode === "local" || patch.llm_mode === "fallback") && patch.cloud_enabled !== true) {
    next.cloud_enabled = false;
  }
  if (next.llm_mode === "cloud" || next.cloud_enabled) {
    if (!next.cloud_warning_ack) {
      throw new ApiError(422, "cloud_warning", cloudWarning(hostOf(next.cloud_endpoint), effectiveWorkerTier(next.cloud_tier ?? next.tier)));
    }
    if (!next.cloud_endpoint) throw new ApiError(422, "cloud_endpoint", "Name the cloud endpoint. It is off until you do.");
    assertCloudEndpoint(next.cloud_endpoint);
    if (!next.cloud_tier) next.cloud_tier = "public";
    next.cloud_enabled = true;
    next.llm_mode = "cloud";
  }
  if (next.llm_mode === "local") assertLocalEndpoint(next.llm_endpoint);

  db.query(
    `UPDATE worker_configs SET
      name = ?, enabled = ?, tier = ?, schedule = ?, llm_mode = ?, llm_endpoint = ?, llm_model = ?,
      cloud_enabled = ?, cloud_endpoint = ?, cloud_tier = ?, cloud_warning_ack = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.name,
    next.enabled ? 1 : 0,
    next.tier,
    next.schedule,
    next.llm_mode,
    next.llm_endpoint,
    next.llm_model,
    next.cloud_enabled ? 1 : 0,
    next.cloud_endpoint,
    next.cloud_tier,
    next.cloud_warning_ack ? 1 : 0,
    nowIso,
    id,
  );
  const worker = getWorker(db, id, nowIso);
  return { worker, warning: warningFor(worker) };
}

export function markRan(db: Database, id: string, at: string) {
  db.query("UPDATE worker_configs SET last_run_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
}

export function recordRun(db: Database, id: string, runId: string, at: string, llm: string, warning: string | null, proposalIds: string[], summary: string) {
  db.query(
    `INSERT INTO worker_runs (id, worker_id, at, llm, warning, proposal_ids, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, id, at, llm, warning, JSON.stringify(proposalIds), summary.slice(0, 2000));
}

export function warningFor(worker: WorkerConfig): string | null {
  if (!worker.cloud_enabled && worker.llm_mode !== "cloud") return null;
  return cloudWarning(hostOf(worker.cloud_endpoint), effectiveWorkerTier(worker.cloud_tier ?? worker.tier));
}

export function viewWorker(worker: WorkerConfig) {
  const effective = ceilingFor(worker);
  return {
    id: worker.id,
    name: worker.name,
    kind: worker.kind,
    enabled: worker.enabled,
    tier: worker.tier,
    effective_ceiling: effective,
    schedule: worker.schedule,
    llm_mode: worker.llm_mode,
    llm_endpoint: worker.llm_mode === "local" ? worker.llm_endpoint : null,
    llm_model: worker.llm_model,
    cloud_enabled: worker.cloud_enabled,
    cloud_endpoint: worker.cloud_enabled ? worker.cloud_endpoint : null,
    cloud_tier: worker.cloud_tier,
    cloud_warning_ack: worker.cloud_warning_ack,
    warning: warningFor(worker),
    limits: [
      "Sealed is denied.",
      "Health and Money are denied.",
      "Proposals only. Nothing is written until you approve.",
      ...(worker.id === "people" ? ["Family stays Private."] : []),
      ...(worker.id === "fixtures" ? ["No scores, results, or standings."] : []),
    ],
    last_run_at: worker.last_run_at,
  };
}

export function isDue(schedule: string, lastRun: string | null, now: Date, timeZone: string): boolean {
  const zone = zonedParts(now, timeZone);
  if (schedule === "hourly") {
    if (!lastRun) return true;
    return now.getTime() - Date.parse(lastRun) >= 3_600_000;
  }
  const daily = /^daily:(\d{2}):(\d{2})$/.exec(schedule);
  if (daily) {
    const mins = Number(daily[1]) * 60 + Number(daily[2]);
    if (zone.minutes < mins) return false;
    if (!lastRun) return true;
    return zonedParts(new Date(lastRun), timeZone).dateKey !== zone.dateKey;
  }
  const weekly = /^weekly:(\d):(\d{2}):(\d{2})$/.exec(schedule);
  if (weekly) {
    const want = Number(weekly[1]);
    const mins = Number(weekly[2]) * 60 + Number(weekly[3]);
    if (zone.weekday !== want || zone.minutes < mins) return false;
    if (!lastRun) return true;
    const prev = zonedParts(new Date(lastRun), timeZone);
    return prev.dateKey !== zone.dateKey;
  }
  const monthly = /^monthly:(\d{1,2}):(\d{2}):(\d{2})$/.exec(schedule);
  if (monthly) {
    const day = Number(monthly[1]);
    const mins = Number(monthly[2]) * 60 + Number(monthly[3]);
    if (zone.day !== day || zone.minutes < mins) return false;
    if (!lastRun) return true;
    return zonedParts(new Date(lastRun), timeZone).monthKey !== zone.monthKey;
  }
  return false;
}

export function validSchedule(value: string): boolean {
  if (value === "hourly" || /^daily:(\d{2}):(\d{2})$/.test(value) || /^weekly:[0-6]:(\d{2}):(\d{2})$/.test(value)) return true;
  const monthly = /^monthly:(\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  if (!monthly) return false;
  const day = Number(monthly[1]);
  return day >= 1 && day <= 28;
}

export function assertLocalEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(422, "bad_endpoint", "The local model URL is not valid.");
  }
  if (url.username || url.password) throw new ApiError(422, "bad_endpoint", "The local model URL cannot carry a secret.");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ApiError(422, "bad_endpoint", "The local model URL must be http or https.");
  if (!isLoopbackHost(url.hostname)) {
    throw new ApiError(422, "bad_endpoint", "A local model stays on this machine. Use 127.0.0.1, localhost, or ::1.");
  }
}

export function assertCloudEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(422, "bad_endpoint", "The cloud endpoint is not valid.");
  }
  if (url.username || url.password) throw new ApiError(422, "bad_endpoint", "Put the cloud key in the environment, not in the URL.");
  if (url.protocol !== "https:") throw new ApiError(422, "bad_endpoint", "A cloud endpoint must be https.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host) || isBlockedCloudHost(host)) {
    throw new ApiError(422, "bad_endpoint", "That host is not a cloud endpoint.");
  }
}

function hostOf(endpoint: string | null): string {
  if (!endpoint) return "the named host";
  try {
    return new URL(endpoint).host;
  } catch {
    return "the named host";
  }
}

function fromRow(row: Row): WorkerConfig {
  const tier = isTier(row.tier) && row.tier !== "sealed" ? row.tier : "personal";
  const mode: LlmMode = row.llm_mode === "local" || row.llm_mode === "cloud" ? row.llm_mode : "fallback";
  const kind = (WORKER_IDS as readonly string[]).includes(row.kind) ? (row.kind as WorkerId) : "morning";
  return {
    id: (WORKER_IDS as readonly string[]).includes(row.id) ? (row.id as WorkerId) : kind,
    name: row.name,
    kind,
    enabled: row.enabled === 1,
    tier,
    schedule: row.schedule,
    llm_mode: mode,
    llm_endpoint: row.llm_endpoint || DEFAULT_LOCAL,
    llm_model: row.llm_model || "llama3.2",
    cloud_enabled: row.cloud_enabled === 1,
    cloud_endpoint: row.cloud_endpoint,
    cloud_tier: row.cloud_tier && isTier(row.cloud_tier) && row.cloud_tier !== "sealed" ? row.cloud_tier : null,
    cloud_warning_ack: row.cloud_warning_ack === 1,
    last_run_at: row.last_run_at,
    updated_at: row.updated_at,
  };
}

function loopbackEnvUrl(): string | null {
  const value = process.env.HMN_LLM_URL?.trim();
  if (!value) return null;
  try {
    assertLocalEndpoint(value);
    return value;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** True for a host on the internet: not loopback, not this network, not a cloud metadata address. */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return !isLoopbackHost(host) && !isBlockedCloudHost(host);
}

function isBlockedCloudHost(hostname: string): boolean {
  if (hostname === "metadata.google.internal" || /\.(local|internal|lan|home|localhost|localdomain|ts\.net|home\.arpa)$/.test(hostname)) return true;
  // A name with no dot is a name on this network, not a cloud host.
  if (!hostname.includes(".") && !hostname.includes(":")) return true;
  if (hostname.includes(":")) return isBlockedIpv6(hostname);
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

/** The URL parser gives IPv6 in its short form. Loopback, unspecified, link-local, unique-local, and mapped IPv4 are blocked. */
function isBlockedIpv6(host: string): boolean {
  const value = host.toLowerCase();
  if (value === "::" || value === "::1") return true;
  if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value)) return true;
  const mapped = /^::ffff:(.+)$/.exec(value);
  if (mapped) {
    const tail = mapped[1]!;
    if (tail.includes(".")) return isBlockedCloudHost(tail);
    const parts = tail.split(":").map((part) => parseInt(part, 16));
    if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) {
      const v4 = `${parts[0]! >> 8}.${parts[0]! & 255}.${parts[1]! >> 8}.${parts[1]! & 255}`;
      return isBlockedCloudHost(v4);
    }
    return true;
  }
  return false;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function zonedParts(date: Date, timeZone: string): { dateKey: string; monthKey: string; day: number; minutes: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    monthKey: `${parts.year}-${parts.month}`,
    day: Number(parts.day),
    minutes: hour * 60 + minute,
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? "")),
  };
}
