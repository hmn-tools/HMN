import { isTier, stricter, type Tier } from "./types";

const TAG = /#([a-z0-9][a-z0-9/_-]*)/gi;
const TIER_TAGS = new Set(["public", "household", "personal", "private", "sealed"]);

export type InboxTag = string;

export type InboxSuggestion = {
  route: "task" | "person" | "reading" | "file";
  label: string;
  entity_type?: string;
  entity_id?: string;
};

export type AreaRef = { id: string; title: string; kind: string | null };
export type NamedRef = { id: string; title: string };

export function parseCapture(text: string, explicit?: string | null): { body: string; tags: string[]; tier: Tier } {
  const found: string[] = [];
  const body = text
    .replace(TAG, (_match, raw: string) => {
      found.push(raw.toLowerCase());
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  let tagged: Tier | null = null;
  if (found.includes("public")) tagged = "public";
  if (found.includes("household")) tagged = "household";
  if (found.includes("private")) tagged = "private";
  if (found.includes("sealed")) tagged = "sealed";
  const chosen = explicit && isTier(explicit) ? explicit : null;
  const tier = tagged && chosen ? stricter(chosen, tagged) : tagged ?? chosen ?? "personal";
  return {
    body,
    tags: [...new Set(found.filter((tag) => !TIER_TAGS.has(tag)))],
    tier,
  };
}

export function clampTier(tier: Tier, scope: string): Tier {
  if (scope === "agent" && tier === "public") return "personal";
  return tier;
}

export function suggestRoute(tags: string[], areas: AreaRef[], projects: NamedRef[], people: NamedRef[] = [], body = ""): InboxSuggestion | null {
  const area = matchArea(tags, areas);
  const project = projects.find((item) => tags.includes(slug(item.title)));
  if (tags.includes("todo")) {
    return { route: "task", label: area ? `Task in ${area.title}` : project ? `Task in ${project.title}` : "Task", entity_type: area ? "area" : project ? "project" : undefined, entity_id: area?.id ?? project?.id };
  }
  if (tags.includes("person")) {
    const named = people.find((person) => body.toLowerCase().includes(person.title.toLowerCase()));
    if (named) return { route: "file", label: named.title, entity_type: "person", entity_id: named.id };
    return { route: "person", label: "Person" };
  }
  if (tags.includes("read")) return { route: "reading", label: "Reading" };
  if (area) return { route: "file", label: area.title, entity_type: "area", entity_id: area.id };
  if (project) return { route: "file", label: project.title, entity_type: "project", entity_id: project.id };
  return null;
}

function matchArea(tags: string[], areas: AreaRef[]): AreaRef | undefined {
  for (const tag of tags) {
    const name = tag.startsWith("area/") ? tag.slice("area/".length) : tag;
    const found = areas.find((area) => area.kind === name || slug(area.title) === name);
    if (found) return found;
  }
  return undefined;
}

export function mentionsTitle(body: string, title: string): boolean {
  if (title.trim().length < 3) return false;
  const escaped = title.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(body);
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function titleFromBody(body: string): string {
  const line = body.split("\n")[0]?.trim() || "Untitled";
  return line.slice(0, 120);
}
