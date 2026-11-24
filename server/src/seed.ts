import type { Database } from "bun:sqlite";
import { randomSecret, sha256hex } from "./crypto";
import type { Tier } from "./types";

const NOW = "2026-10-01T00:00:00.000Z";
const QUIET = "2026-10-21T04:39:00.000Z";

type EntitySeed = {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  status?: string | null;
  kind?: string | null;
  due_at?: string | null;
  area_id?: string | null;
  properties?: Record<string, unknown>;
  tier?: Tier | null;
  updated_at?: string;
};

const entities: EntitySeed[] = [
  { id: "area_work", type: "area", title: "Work", kind: "work", properties: { child_tier: "personal" } },
  { id: "area_side", type: "area", title: "Side project", kind: "side_project", properties: { child_tier: "personal" } },
  { id: "area_family", type: "area", title: "Family", kind: "family", properties: { child_tier: "private" } },
  { id: "area_health", type: "area", title: "Health", kind: "health", properties: { child_tier: "sealed" } },
  { id: "area_cars", type: "area", title: "Cars", kind: "cars", properties: { child_tier: "personal" } },
  { id: "area_sport", type: "area", title: "Sport", kind: "sport", properties: { child_tier: "public" } },
  { id: "area_home", type: "area", title: "Home", kind: "home", properties: { child_tier: "personal" } },
  { id: "area_money", type: "area", title: "Money", kind: "money", properties: { child_tier: "sealed" } },
  { id: "person_alex", type: "person", title: "Alex", kind: "self", body: "The owner. Example only." },
  { id: "person_sam", type: "person", title: "Sam", kind: "spouse", area_id: "area_family" },
  { id: "person_yves", type: "person", title: "Yves", kind: "child", area_id: "area_family" },
  { id: "person_luca", type: "person", title: "Luca", kind: "child", area_id: "area_family" },
  { id: "goal_quiet", type: "goal", title: "A quieter year", status: "active", properties: { horizon: "year" } },
  {
    id: "goal_family",
    type: "goal",
    title: "Show up at the things that matter",
    status: "active",
    area_id: "area_family",
    properties: { horizon: "year" },
  },
  { id: "project_brief", type: "project", title: "Weekly brief", status: "active", area_id: "area_work" },
  {
    id: "project_side",
    type: "project",
    title: "Side project",
    status: "active",
    area_id: "area_side",
    body: "A placeholder for the one side project. No product name is stored here.",
  },
  { id: "project_trip", type: "project", title: "Dec trip", status: "active", area_id: "area_home" },
  { id: "place_school", type: "place", title: "School", kind: "school" },
  { id: "place_garage", type: "place", title: "Garage", kind: "garage" },
  { id: "asset_coupe", type: "asset", title: "Coupe", kind: "car", area_id: "area_cars", properties: { model: "1998" } },
  {
    id: "task_notes",
    type: "task",
    title: "Send weekly notes",
    status: "open",
    kind: "task",
    due_at: "2026-11-11T09:00:00.000Z",
    area_id: "area_work",
  },
  {
    id: "task_dentist",
    type: "task",
    title: "Book Luca's dentist",
    status: "open",
    kind: "task",
    due_at: "2026-11-11",
    area_id: "area_family",
  },
  {
    id: "task_garage",
    type: "task",
    title: "Reply to garage about the coupe service",
    status: "open",
    kind: "task",
    due_at: "2026-11-11",
    area_id: "area_cars",
  },
  {
    id: "task_srs",
    type: "task",
    title: "Coupe SRS light",
    status: "open",
    kind: "task",
    area_id: "area_cars",
    updated_at: QUIET,
  },
  {
    id: "event_concert",
    type: "event",
    title: "school concert",
    status: "upcoming",
    kind: "family",
    due_at: "2026-11-13T08:30:00.000Z",
    area_id: "area_family",
    properties: { short_title: "Yves' concert" },
  },
  {
    id: "event_race",
    type: "event",
    title: "Lakeside Grand Prix",
    status: "upcoming",
    kind: "fixture",
    due_at: "2026-11-22T06:00:00.000Z",
    area_id: "area_sport",
    properties: { badge: "GT", tz_label: "AWST", no_results: true },
  },
  {
    id: "note_trip",
    type: "note",
    title: "Dec trip",
    body: "Yves' passport expires 02/2027. Example note, not a real document.",
    status: "open",
    area_id: "area_home",
    tier: "sealed",
  },
  {
    id: "note_health",
    type: "note",
    title: "Example clinic note",
    body: "Fictional reminder to book a checkup. Not a real record.",
    status: "open",
    area_id: "area_health",
  },
  {
    id: "source_demo",
    type: "source",
    title: "Demonstration seed",
    body: "Fictional data for the interface.",
    kind: "manual",
  },
];

const links: Array<[string, string, string, string, string]> = [
  ["link_brief_goal", "project", "project_brief", "goal", "goal_quiet"],
  ["link_notes_project", "task", "task_notes", "project", "project_brief"],
  ["link_dentist_luca", "task", "task_dentist", "person", "person_luca"],
  ["link_garage_car", "task", "task_garage", "asset", "asset_coupe"],
  ["link_srs_car", "task", "task_srs", "asset", "asset_coupe"],
  ["link_concert_yves", "event", "event_concert", "person", "person_yves"],
  ["link_concert_school", "event", "event_concert", "place", "place_school"],
  ["link_note_yves", "note", "note_trip", "person", "person_yves"],
  ["link_note_trip", "note", "note_trip", "project", "project_trip"],
  ["link_alex_car", "person", "person_alex", "asset", "asset_coupe"],
];

const linkRel: Record<string, string> = {
  link_brief_goal: "serves",
  link_notes_project: "part_of",
  link_dentist_luca: "about",
  link_garage_car: "about",
  link_srs_car: "about",
  link_concert_yves: "with",
  link_concert_school: "at",
  link_note_yves: "about",
  link_note_trip: "about",
  link_alex_car: "cares_for",
};

export type SeedSecrets = { owner: string; agent: string; display: string };

/** `demo` false writes the keys and the display state only: an empty graph for a new owner. */
export function seedDatabase(db: Database, seal: (value: string) => string, nowIso: string, demo = true): SeedSecrets {
  const insertEntity = db.query(
    `INSERT INTO entities (
      id, type, title, body, status, kind, due_at, area_id, properties, tier, content_sealed,
      origin, origin_ref, source_id, external_id, confirmed_at, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', 'seed', 'source_demo', NULL, NULL, ?, ?, NULL)`,
  );
  for (const entity of demo ? entities : []) {
    const tier = entity.tier ?? null;
    const areaSealed = entity.area_id === "area_health" || entity.area_id === "area_money";
    const sealed = tier === "sealed" || (areaSealed && entity.type !== "area");
    const title = sealed ? seal(entity.title) : entity.title;
    const body = entity.body ? (sealed ? seal(entity.body) : entity.body) : null;
    const properties = JSON.stringify(entity.properties ?? {});
    const storedProps = sealed ? seal(properties) : properties;
    insertEntity.run(
      entity.id,
      entity.type,
      title,
      body,
      entity.status ?? null,
      entity.kind ?? null,
      entity.due_at ?? null,
      entity.area_id ?? null,
      storedProps,
      tier,
      sealed ? 1 : 0,
      NOW,
      entity.updated_at ?? NOW,
    );
  }
  // source_demo should not point at itself as a missing source during insert; it exists now.
  const insertLink = db.query(
    `INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, origin, origin_ref, tier, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'seed', 'seed', NULL, ?, NULL)`,
  );
  for (const [id, fromType, fromId, toType, toId] of demo ? links : []) {
    insertLink.run(id, fromType, fromId, toType, toId, linkRel[id], NOW);
  }

  const secrets = { owner: randomSecret(), agent: randomSecret(), display: randomSecret() };
  const expires = new Date(Date.parse(nowIso) + 90 * 86_400_000).toISOString();
  const insertKey = db.query(
    `INSERT INTO credentials (
      id, name, kind, key_hash, scope, max_tier, vault, allow_types, allow_areas, deny_areas,
      forced_ceiling, expires_at, created_at, revoked_at, rotated_from
    ) VALUES (?, ?, 'key', ?, ?, ?, 0, NULL, NULL, ?, NULL, ?, ?, NULL, NULL)`,
  );
  insertKey.run("key_owner", "owner", sha256hex(secrets.owner), "write", "private", null, expires, nowIso);
  insertKey.run(
    "key_agent",
    "agent",
    sha256hex(secrets.agent),
    "agent",
    "personal",
    // A role names each area of that kind: the demonstration's Health and Money, and an area that the owner adds later.
    JSON.stringify(["role:health", "role:money"]),
    expires,
    nowIso,
  );
  insertKey.run("key_display", "display", sha256hex(secrets.display), "read", "public", null, expires, nowIso);

  const payload = {
    op: "create",
    entity: {
      type: "task",
      title: "Renew Yves' passport",
      status: "open",
      kind: "task",
      due_at: "2026-11-30",
      area_id: "area_home",
      body: null,
      properties: {},
    },
    links: [
      { rel: "about", to_type: "person", to_id: "person_yves" },
      { rel: "about", to_type: "note", to_id: "note_trip" },
    ],
  };
  const readSet = { summary: "People, Tasks, one note", denied: ["Health", "Money"] };
  const reason = 'Passport in note "Dec trip" expires 02/2027.';
  if (demo) {
    db.query(
      `INSERT INTO proposals (
        id, agent_name, key_id, op, entity_type, entity_id, payload, reason, read_set, tier, status, created_at, decided_at, decided_by
      ) VALUES ('proposal_01', 'Trip helper', 'key_agent', 'create', 'task', NULL, ?, ?, ?, 'sealed', 'pending', '2026-11-11T04:36:00.000Z', NULL, NULL)`,
    ).run(seal(JSON.stringify(payload)), seal(reason), seal(JSON.stringify(readSet)));
  }

  db.query(
    `INSERT INTO display_state (id, screen_index, shown_at) VALUES ('device', 0, ?)`,
  ).run(nowIso);
  return secrets;
}
