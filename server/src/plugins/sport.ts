import type { PluginManifest } from "../plugins";
import { SPOILER_KEYS } from "../types";

export const sportManifest: PluginManifest = {
  id: "sport",
  maxTier: "public",
  areas: ["role:sport"],
  permissions: ["propose"],
};

export type RawFixture = {
  id: string;
  title: string;
  start: string;
  competition?: string;
  category?: "sport" | "motorsport";
  score?: string;
  result?: string;
  winner?: string;
  standing?: string;
  points?: string;
};

export function stripFixture(fixture: RawFixture): Omit<RawFixture, "score" | "result" | "winner" | "standing" | "points"> {
  const copy: Record<string, unknown> = { ...fixture };
  for (const key of Object.keys(copy)) {
    if (SPOILER_KEYS.has(key)) delete copy[key];
  }
  return copy as Omit<RawFixture, "score" | "result" | "winner" | "standing" | "points">;
}

export function sportDrafts(input: {
  fixtures: RawFixture[];
  now: Date;
  sourceId: string | null;
  existing: Array<{ id: string; external_id: string | null }>;
}) {
  return input.fixtures.flatMap((raw) => {
    const fixture = stripFixture(raw);
    const start = new Date(fixture.start);
    if (Number.isNaN(start.getTime()) || start.getTime() < input.now.getTime()) return [];
    if (input.existing.some((item) => item.external_id === fixture.id)) return [];
    const properties: Record<string, unknown> = {
      plugin: "sport",
      no_results: true,
      category: fixture.category ?? "sport",
    };
    if (fixture.competition) properties.badge = fixture.competition;
    for (const key of Object.keys(properties)) {
      if (SPOILER_KEYS.has(key)) delete properties[key];
    }
    return [{
      op: "create" as const,
      external_id: fixture.id,
      entity: {
        type: "event",
        title: fixture.title,
        status: "upcoming",
        kind: "fixture",
        due_at: fixture.start,
        // The owner's area with the role `sport`. The parent process finds it.
        area_id: null,
        area_role: "sport",
        tier: null,
        source_id: input.sourceId,
        external_id: fixture.id,
        properties,
      },
      reason: fixture.category === "motorsport" ? "An upcoming motorsport session. Results are not stored." : "An upcoming fixture. Results are not stored.",
    }];
  });
}
