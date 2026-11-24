import type { PluginManifest } from "../plugins";

export const healthManifest: PluginManifest = {
  id: "health",
  maxTier: "sealed",
  areas: ["role:health"],
  permissions: ["propose"],
};

export type HealthSummary = {
  id?: string;
  label?: string;
  day?: string;
  value?: unknown;
  unit?: string;
  samples?: unknown;
};

const SAMPLE_KEYS = new Set(["value", "unit", "samples", "sample", "heart_rate", "steps", "count", "quantity"]);

/** Summaries are sealed notes. The daily number is kept only when the owner opted in. Sample series are never stored. */
export function healthDrafts(summaries: HealthSummary[], includeSamples: boolean) {
  return summaries.flatMap((summary) => {
    const label = (summary.label ?? "Health").toString().slice(0, 80);
    const day = (summary.day ?? "").toString().slice(0, 10);
    const id = (summary.id ?? `health-${day}-${label}`).toString().slice(0, 120);
    if (!day || !label) return [];
    const properties: Record<string, unknown> = {
      plugin: "health",
      day,
      include_samples: includeSamples,
    };
    let body = `${label} recorded.`;
    if (includeSamples && summary.value != null && typeof summary.value !== "object") {
      body = `${label}: ${summary.value}${summary.unit ? ` ${summary.unit}` : ""}.`;
      properties.value = summary.value;
      if (summary.unit) properties.unit = summary.unit;
    }
    for (const key of Object.keys(properties)) {
      if (key === "samples" || key === "sample") delete properties[key];
    }
    return [{
      op: "create" as const,
      external_id: id,
      entity: {
        type: "note",
        title: label,
        body,
        status: "open",
        // The owner's area with the role `health`. The parent process finds it.
        area_id: null,
        area_role: "health",
        tier: "sealed",
        source_id: null,
        external_id: id,
        properties,
      },
      reason: "A health summary from this phone. It is sealed.",
    }];
  });
}

export function leaksSample(draft: ReturnType<typeof healthDrafts>[number], sample: string): boolean {
  const blob = JSON.stringify(draft);
  if (!blob.includes(sample)) return false;
  const keys = Object.keys(draft.entity.properties);
  return keys.some((key) => SAMPLE_KEYS.has(key)) || draft.entity.body.includes(sample);
}
