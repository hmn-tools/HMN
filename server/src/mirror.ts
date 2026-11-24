import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { asObject, childTierOf, ownTier, type AreaInfo } from "./policy";
import type { Tier } from "./types";
import { isTier } from "./types";
import type { VersionRow } from "./history";

type Head = {
  id: string;
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
  deleted_at: string | null;
};

type Manifest = { entities: Record<string, { version: string; hash: string }> };

const PLAIN = new Set<Tier>(["public", "household", "personal"]);

export function syncMirror(db: Database, dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const areas = areaMap(db);
  const heads = db.query("SELECT * FROM entities").all() as Head[];
  const versions = db.query("SELECT * FROM entity_versions ORDER BY valid_from ASC, rowid ASC").all() as VersionRow[];
  const byEntity = new Map<string, VersionRow[]>();
  for (const version of versions) {
    const list = byEntity.get(version.entity_id) ?? [];
    list.push(version);
    byEntity.set(version.entity_id, list);
  }
  const manifest = readManifest(dir);
  const next: Manifest = { entities: {} };
  const keep = new Set<string>();
  for (const head of heads) {
    const chain = byEntity.get(head.id) ?? [];
    const tip = chain.filter((version) => !chain.some((other) => other.supersedes_id === version.id)).at(-1) ?? chain.at(-1);
    if (!tip) continue;
    // The tier is in the key: a change of an area's tier changes no version, and the file must follow it.
    const key = `${tip.id}:${tip.hash}:${head.deleted_at ?? ""}:${effectiveTier(head, areas)}`;
    const folder = join(dir, "entities", head.type);
    const markdownPath = join(folder, `${head.id}.md`);
    const timelinePath = join(dir, "timelines", `${head.id}.jsonl`);
    keep.add(markdownPath);
    keep.add(timelinePath);
    next.entities[head.id] = { version: tip.id, hash: key };
    if (manifest.entities[head.id]?.hash === key && existsSync(markdownPath) && existsSync(timelinePath)) continue;
    const tier = effectiveTier(head, areas);
    const markdown = renderMarkdown(head, tip, tier, areas);
    const timeline = chain.map((version) => JSON.stringify(renderLine(head, version, areas))).join("\n") + "\n";
    writeIfChanged(markdownPath, markdown);
    writeIfChanged(timelinePath, timeline);
  }
  sweep(join(dir, "entities"), keep);
  sweep(join(dir, "timelines"), keep);
  writeIfChanged(join(dir, "manifest.json"), JSON.stringify(next, null, 2) + "\n");
}

function effectiveTier(head: Head, areas: Map<string, AreaInfo>): Tier {
  if (head.content_sealed) return "sealed";
  const declared = head.tier && isTier(head.tier) ? head.tier : null;
  return ownTier({ type: head.type, tier: declared, area_id: head.area_id }, areas).tier;
}

function versionTier(head: Head, version: VersionRow, areas: Map<string, AreaInfo>): Tier {
  if (version.content_sealed) return "sealed";
  const declared = version.tier && isTier(version.tier) ? version.tier : null;
  const own = ownTier({ type: version.type, tier: declared, area_id: version.area_id }, areas).tier;
  return stricter(own, effectiveTier(head, areas));
}

function stricter(a: Tier, b: Tier): Tier {
  const rank: Record<Tier, number> = { public: 0, household: 1, personal: 2, private: 3, sealed: 4 };
  return rank[a] >= rank[b] ? a : b;
}

function renderMarkdown(head: Head, tip: VersionRow, tier: Tier, areas: Map<string, AreaInfo>): string {
  const show = PLAIN.has(versionTier(head, tip, areas));
  const lines = [
    "---",
    `id: ${yaml(head.id)}`,
    `type: ${yaml(head.type)}`,
    `tier: ${tier}`,
    `version: ${yaml(tip.id)}`,
    `valid_from: ${yaml(tip.valid_from)}`,
    `tombstone: ${head.deleted_at || tip.tombstone ? "true" : "false"}`,
  ];
  if (show) {
    lines.push(`title: ${yaml(head.title ?? "")}`);
    if (head.status) lines.push(`status: ${yaml(head.status)}`);
    if (head.kind) lines.push(`kind: ${yaml(head.kind)}`);
    if (head.area_id) lines.push(`area_id: ${yaml(head.area_id)}`);
    if (head.due_at) lines.push(`due_at: ${yaml(head.due_at)}`);
  }
  lines.push("---", "");
  if (show && head.body) lines.push(head.body, "");
  return lines.join("\n");
}

function renderLine(head: Head, version: VersionRow, areas: Map<string, AreaInfo>): Record<string, unknown> {
  const tier = versionTier(head, version, areas);
  const base = {
    id: version.id,
    entity_id: version.entity_id,
    supersedes_id: version.supersedes_id,
    valid_from: version.valid_from,
    tombstone: Boolean(version.tombstone),
    tier,
    type: version.type,
  };
  if (!PLAIN.has(tier)) return base;
  return {
    ...base,
    title: version.title,
    body: version.body,
    status: version.status,
    kind: version.kind,
    area_id: version.area_id,
    properties: safeProperties(version.properties, tier),
  };
}

/** The fields that a reader at Personal can read. A field that the row marks as more private stays out of the mirror. */
function safeProperties(raw: string, tier: Tier): Record<string, unknown> {
  try {
    const value = asObject(JSON.parse(raw || "{}"));
    const privacy = asObject(value._privacy);
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (key === "_privacy") continue;
      const marked = isTier(privacy[key]) ? stricter(tier, privacy[key] as Tier) : tier;
      if (!PLAIN.has(marked)) continue;
      if (JSON.stringify(field).includes("seal1:")) continue;
      out[key] = field;
    }
    return out;
  } catch {
    return {};
  }
}

function yaml(value: string): string {
  if (value === "" || /[:#\n"'&*!|>%@`{}[\],]/.test(value) || value.trim() !== value) return JSON.stringify(value);
  return value;
}

function areaMap(db: Database): Map<string, AreaInfo> {
  const rows = db.query("SELECT id, properties, content_sealed FROM entities WHERE type = 'area' AND deleted_at IS NULL").all() as Array<{
    id: string;
    properties: string;
    content_sealed: number;
  }>;
  const map = new Map<string, AreaInfo>();
  for (const row of rows) {
    if (row.content_sealed) continue;
    let properties: Record<string, unknown> = {};
    try {
      properties = asObject(JSON.parse(row.properties || "{}"));
    } catch {
      properties = {};
    }
    map.set(row.id, { id: row.id, childTier: childTierOf(properties) });
  }
  return map;
}

function readManifest(dir: string): Manifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return { entities: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    return parsed?.entities ? parsed : { entities: {} };
  } catch {
    return { entities: {} };
  }
}

function writeIfChanged(path: string, text: string) {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

function sweep(root: string, keep: Set<string>) {
  if (!existsSync(root)) return;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!keep.has(path) && name !== "manifest.json") rmSync(path);
    }
  };
  walk(root);
}
