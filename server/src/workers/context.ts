import type { Hmn } from "../hmn";
import { makeAccess } from "../policy";
import type { Access, EntityType, Principal, Tier } from "../types";
import type { WorkerConfig } from "./config";
import { ceilingFor } from "./config";

export type Visible = {
  id: string;
  type: EntityType;
  title: string;
  body: string | null;
  status: string | null;
  kind: string | null;
  due_at: string | null;
  area_id: string | null;
  tier: Tier;
  properties: Record<string, unknown>;
};

/** A worker does not read an area whose kind has the role `health` or `money`. The owner's kinds give the areas. */
const DENIED = ["role:health", "role:money"];

export function workerAccess(config: Pick<WorkerConfig, "id" | "name" | "tier">): Access {
  const tier = ceilingFor(config);
  const principal: Principal = {
    id: `worker:${config.id}`,
    name: config.name,
    kind: "key",
    scope: "agent",
    maxTier: tier,
    vault: false,
    denyAreas: DENIED,
    allowAreas: null,
    allowTypes: null,
    forcedCeiling: tier,
  };
  const access = makeAccess(principal, "mcp", false);
  return { ...access, grant: false, ceiling: tier };
}

export function visibleGraph(hmn: Hmn, access: Access): Visible[] {
  const out: Visible[] = [];
  for (const type of ["area", "person", "goal", "project", "task", "note", "event", "place", "asset", "habit"] as EntityType[]) {
    for (const view of hmn.list(access, type)) {
      if (view.tier === "sealed") continue;
      if (view.area_id && DENIED.includes(view.area_id)) continue;
      out.push({
        id: view.id,
        type: view.type,
        title: view.title,
        body: view.body,
        status: view.status,
        kind: view.kind,
        due_at: view.due_at,
        area_id: view.area_id,
        tier: view.tier,
        properties: view.properties,
      });
    }
  }
  return out;
}

export function readSet(summary: string, ceiling: Tier, journalId?: string) {
  return {
    summary,
    denied: ["Health", "Money"],
    ceiling,
    journal_id: journalId ?? null,
  };
}
