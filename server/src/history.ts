import { sha256hex } from "./crypto";

export type VersionRow = {
  id: string;
  entity_id: string;
  supersedes_id: string | null;
  valid_from: string;
  tombstone: number;
  type: string;
  title: string | null;
  body: string | null;
  status: string | null;
  kind: string | null;
  due_at: string | null;
  area_id: string | null;
  properties: string;
  tier: string | null;
  content_sealed: number;
  origin: string;
  origin_ref: string | null;
  source_id: string | null;
  external_id: string | null;
  prev_hash: string;
  hash: string;
};

export function versionHash(row: Omit<VersionRow, "hash">): string {
  const body = {
    area_id: row.area_id,
    body: row.body,
    content_sealed: row.content_sealed,
    due_at: row.due_at,
    entity_id: row.entity_id,
    external_id: row.external_id,
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    origin_ref: row.origin_ref,
    prev_hash: row.prev_hash,
    properties: row.properties,
    source_id: row.source_id,
    status: row.status,
    supersedes_id: row.supersedes_id,
    tier: row.tier,
    title: row.title,
    tombstone: row.tombstone,
    type: row.type,
    valid_from: row.valid_from,
  };
  return sha256hex(JSON.stringify(body));
}
