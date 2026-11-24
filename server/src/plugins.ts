import type { Tier } from "./types";

/** Plugins are data in, proposals out. Nothing here is loaded from disk or evaluated. */
export type PluginManifest = {
  id: string;
  maxTier: Tier;
  areas: string[];
  permissions: Array<"propose">;
};

export type ExternalRecord = {
  external_id: string;
  type: string;
  title: string;
  body?: string | null;
  area_id?: string | null;
};

export const plugins: PluginManifest[] = [];

export function draftsFromRecords(manifest: PluginManifest, records: ExternalRecord[]) {
  if (manifest.permissions.some((permission) => permission !== "propose")) {
    throw new Error("plugins cannot hold a write permission");
  }
  return records.map((record) => ({
    op: "create" as const,
    entity: {
      type: record.type,
      title: record.title,
      body: record.body ?? null,
      area_id: record.area_id ?? null,
      external_id: record.external_id,
      properties: {},
    },
  }));
}
