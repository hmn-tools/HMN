import type { Hmn } from "../hmn";
import { listJournals } from "../journal";
import { childTierOf, projectEntity, type AreaInfo } from "../policy";
import type { Access, EntityRow } from "../types";

type Read = { at: string; action: string; tier: string | null; type: string; id: string; title: string | null };

export function accessConnections(hmn: Hmn, access: Access) {
  const creds = hmn.store.db.query("SELECT * FROM credentials ORDER BY created_at").all() as Array<{
    id: string;
    name: string;
    kind: string;
    scope: string;
    max_tier: string;
    external: number | null;
    guest: number | null;
    forced_ceiling: string | null;
    revoked_at: string | null;
    last_used_at: string | null;
    expires_at: string | null;
  }>;
  const trmnl = hmn.store.db.query("SELECT id, name, credential_id, status, last_seen_at, friendly_id FROM trmnl_devices").all() as Array<{
    id: string;
    name: string;
    credential_id: string | null;
    status: string;
    last_seen_at: string | null;
    friendly_id: string;
  }>;
  const trmnlCreds = new Set(trmnl.map((row) => row.credential_id).filter(Boolean));
  const connections = [];
  for (const row of creds) {
    if (trmnlCreds.has(row.id)) continue;
    const kind = row.guest === 1 ? "guest" : row.external === 1 ? "mcp" : row.kind === "device" ? "device" : row.scope === "read" ? "view" : "mcp";
    connections.push({
      id: row.id,
      kind,
      name: row.name,
      tier_cap: capOf(row),
      scopes: [row.scope],
      last_access: row.last_used_at ?? lastAudit(hmn, row.id),
      expires_at: row.expires_at,
      revoked: Boolean(row.revoked_at),
      revocable: !row.revoked_at,
      reads: mergeReads(hmn, access, row.id),
    });
  }
  for (const row of trmnl) {
    connections.push({
      id: row.credential_id ?? row.id,
      kind: "trmnl",
      name: row.name || row.friendly_id,
      tier_cap: "public",
      scopes: ["read"],
      last_access: row.last_seen_at,
      expires_at: null,
      revoked: row.status === "revoked",
      revocable: row.status !== "revoked" && Boolean(row.credential_id),
      reads: mergeReads(hmn, access, row.credential_id),
    });
  }
  for (const plugin of [
    { id: "calendar", tier_cap: "personal" },
    { id: "sport", tier_cap: "public" },
    { id: "health", tier_cap: "sealed" },
  ]) {
    connections.push({
      id: `plugin:${plugin.id}`,
      kind: "plugin",
      name: plugin.id,
      tier_cap: plugin.tier_cap,
      scopes: ["propose"],
      last_access: null,
      expires_at: null,
      revoked: false,
      revocable: false,
      reads: [],
    });
  }
  return { connections };
}

export function accessHtml(connections: ReturnType<typeof accessConnections>["connections"]): string {
  const rows = connections
    .map((item) => {
      const reads = item.reads.map((read) => `${read.at} ${read.type} ${read.title ?? ""}`.trim()).join("; ") || "No reads at this ceiling.";
      const button = item.revocable ? `<form method="post" action="/api/v1/access/${esc(item.id)}/revoke"><button type="submit">Revoke</button></form>` : "";
      return `<article><h2>${esc(item.name)}</h2><p>${esc(item.kind)} · cap ${esc(item.tier_cap)} · ${esc(item.scopes.join(", "))} · last ${esc(item.last_access ?? "never")}</p><p>${esc(reads)}</p>${button}</article>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title></head><body style="font-family:ui-monospace,monospace;background:#F4F4F2;color:#0D0D0D;padding:28px"><h1>Connected agents and apps</h1>${rows}</body></html>`;
}

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function capOf(row: { max_tier: string; external: number | null; forced_ceiling: string | null }): string {
  if (row.external === 1) return row.forced_ceiling === "public" ? "public" : row.max_tier === "public" || row.max_tier === "household" ? row.max_tier : "personal";
  return row.forced_ceiling ?? row.max_tier;
}

function lastAudit(hmn: Hmn, actor: string): string | null {
  const row = hmn.store.db.query("SELECT at FROM audit_log WHERE actor = ? ORDER BY seq DESC LIMIT 1").get(actor) as { at: string } | null;
  return row?.at ?? null;
}

function mergeReads(hmn: Hmn, access: Access, actor: string | null): Read[] {
  if (!actor) return [];
  const fromJournal = listJournals(hmn, access, actor).flatMap((entry) =>
    entry.read.map((item) => ({ at: entry.at, action: "read", tier: item.tier, type: item.type, id: item.id, title: item.title })),
  );
  // An agent key has its own read log, with each row it read and each search it made.
  const fromLog = hmn.clientReads(access, actor, 12).map((row) => ({
    at: row.at,
    action: row.action,
    tier: row.tier,
    type: row.type ?? row.action,
    id: row.id ?? row.action,
    title: row.title ?? row.action,
  }));
  return [...fromLog, ...fromJournal, ...recentReads(hmn, access, actor)].slice(0, 12);
}

function recentReads(hmn: Hmn, access: Access, actor: string): Read[] {
  const rows = hmn.store.db
    .query("SELECT at, action, tier, entity_type, entity_id FROM audit_log WHERE actor = ? AND action IN ('read', 'external') ORDER BY seq DESC LIMIT 12")
    .all(actor) as Array<{ at: string; action: string; tier: string | null; entity_type: string | null; entity_id: string | null }>;
  const areas = areaMap(hmn);
  const out: Read[] = [];
  for (const row of rows) {
    if (row.entity_type === "tool" && row.entity_id) {
      out.push({ at: row.at, action: row.action, tier: row.tier, type: "tool", id: row.entity_id, title: row.entity_id });
      continue;
    }
    if (!row.entity_id) continue;
    const entity = hmn.store.db.query("SELECT * FROM entities WHERE id = ?").get(row.entity_id) as EntityRow | null;
    if (!entity) continue;
    const view = projectEntity(entity, areas, access, hmn.store.sealedKey);
    if (!view) continue;
    out.push({ at: row.at, action: row.action, tier: view.tier, type: view.type, id: view.id, title: view.title });
  }
  return out;
}

function areaMap(hmn: Hmn): Map<string, AreaInfo> {
  const rows = hmn.store.db.query("SELECT id, properties FROM entities WHERE type = 'area' AND deleted_at IS NULL").all() as Array<{ id: string; properties: string }>;
  const map = new Map<string, AreaInfo>();
  for (const row of rows) {
    let props: Record<string, unknown> = {};
    try {
      props = JSON.parse(row.properties) as Record<string, unknown>;
    } catch {
      props = {};
    }
    map.set(row.id, { id: row.id, childTier: childTierOf(props) });
  }
  return map;
}
