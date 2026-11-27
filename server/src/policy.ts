import { sourceOf } from "./approval";
import { LEGACY_ROLES, MEMBER_ROLES, PARTNER_ROLE } from "./kinds";
import { isSealed, openString } from "./crypto";
import {
  type Access,
  type CredentialRow,
  type EntityRow,
  type EntityType,
  type LinkRow,
  type Principal,
  type ProposalRow,
  type Surface,
  type Tier,
  ApiError,
  SURFACE_CEILING,
  SPOILER_KEYS,
  covers,
  isTier,
  looser,
  stricter,
} from "./types";

/** `role` is the role of the area's kind, when the caller has the kinds. A deny list can name a role as `role:<name>`. */
export type AreaInfo = { id: string; childTier: Tier; role?: string | null };

export type OpenEntity = EntityRow & {
  plainTitle: string;
  plainBody: string | null;
  plainProperties: Record<string, unknown>;
  effectiveTier: Tier;
  tierSource: "override" | "area" | "default";
};

/**
 * The statuses of each type. `archived` keeps a row that is old but worth keeping: it leaves lists, search, and
 * screens, and it stays readable. No status (null) is the same as the first status of the type.
 */
export const STATUS: Record<string, string[]> = {
  goal: ["active", "paused", "done", "archived"],
  project: ["active", "paused", "done", "someday", "archived"],
  task: ["inbox", "open", "done"],
  note: ["open", "archived"],
  event: ["upcoming", "past", "cancelled"],
  habit: ["active", "paused"],
  person: ["active", "archived"],
  place: ["active", "archived"],
  asset: ["active", "archived"],
  area: ["active", "archived"],
};

/** `nowIso` decides if a Private grant is still open. With no time, there is no grant. */
export function principalFromRow(row: CredentialRow, nowIso?: string): Principal {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    scope: row.scope,
    maxTier: row.max_tier,
    vault: row.vault === 1,
    denyAreas: parseList(row.deny_areas),
    allowAreas: row.allow_areas ? parseList(row.allow_areas) : null,
    allowTypes: row.allow_types ? parseList(row.allow_types) : null,
    forcedCeiling: row.forced_ceiling,
    external: row.external === 1,
    // A grant is for an agent key that is not held at Public, and it has an end.
    privateGrant: Boolean(nowIso && row.scope === "agent" && row.max_tier !== "public" && row.max_tier !== "household" && row.private_until && row.private_until > nowIso),
    freeBusy: row.free_busy === 1,
    memory: row.memory === 1 && row.scope === "agent" && row.external !== 1 && row.guest !== 1,
    guest: row.guest === 1,
    ...memberOf(row),
  };
}

/** The member part of a principal. The role sets the reach: the server does not store a ceiling for each area. */
function memberOf(row: CredentialRow): Pick<Principal, "member" | "areaTiers"> {
  const role = MEMBER_ROLES.find((name) => name === row.member_role);
  if (!row.person_id || !role) return {};
  const member = { role, personId: row.person_id };
  return role === PARTNER_ROLE ? { member, areaTiers: { "role:family": "private" } } : { member };
}

/**
 * The ceiling for one row. It is the ceiling of the access, raised for a row in an area that the principal has a
 * ceiling for. The raise is for the phone only, it is never Sealed, and Hide ends it.
 */
export function rowCeiling(access: Access, entity: { type: string; id: string; area_id: string | null }, areas?: Map<string, AreaInfo>): Tier {
  const raise = access.principal.areaTiers;
  if (!raise || access.principal.forcedCeiling || access.surface !== "phone") return access.ceiling;
  const areaId = entity.type === "area" ? entity.id : entity.area_id;
  if (!areaId) return access.ceiling;
  const role = areas?.get(areaId)?.role;
  const tier = raise[areaId] ?? (role ? raise[`role:${role}`] : undefined);
  if (!tier || tier === "sealed" || covers(access.ceiling, tier)) return access.ceiling;
  return tier;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
}

export function resolveCeiling(principal: Principal, surface: Surface, grant: boolean): Tier {
  if (principal.scope === "agent") return agentCeiling(principal, surface);
  let cap = looser(principal.maxTier, SURFACE_CEILING[surface]);
  if (surface === "display" || surface === "lock") cap = "public";
  if (surface === "widget") cap = looser(cap, "personal");
  if (surface === "mcp" || principal.scope === "agent") cap = looser(cap, principal.maxTier);
  if (grant && principal.vault && (surface === "phone" || surface === "mcp")) {
    cap = "sealed";
  }
  if (!grant && principal.scope === "agent") cap = looser(cap, "personal");
  if (principal.forcedCeiling) cap = looser(cap, principal.forcedCeiling);
  if (principal.external) cap = externalCeiling(cap, principal);
  return cap;
}

/**
 * The ceiling of an agent key, local or outside. It is Public, Household, or Personal. It is Private only while the
 * owner's grant for this key is open. It is never Sealed: a vault grant, a `max_tier`, and the surface
 * that the caller names do not raise it.
 */
function agentCeiling(principal: Principal, surface: Surface): Tier {
  // A key made at Public or Household stays there. Each other key starts at Personal.
  let cap: Tier = principal.forcedCeiling === "public" ? "public" : principal.maxTier === "public" || principal.maxTier === "household" ? principal.maxTier : "personal";
  if (cap === "personal" && principal.privateGrant) cap = "private";
  if (surface === "display" || surface === "lock") cap = "public";
  if (surface === "widget") cap = looser(cap, "personal");
  return cap;
}

/** An outside client is an agent key. It gets no more than the same ceiling. */
export function externalCeiling(cap: Tier, principal: Principal): Tier {
  return looser(cap, agentCeiling(principal, "mcp"));
}

export function makeAccess(principal: Principal, surface: Surface, grant: boolean): Access {
  return { principal, surface, grant, ceiling: resolveCeiling(principal, surface, grant) };
}

export function childTierOf(properties: Record<string, unknown> | null): Tier {
  const value = properties?.child_tier;
  return isTier(value) ? value : "personal";
}

export function ownTier(
  entity: { type: string; tier: Tier | null; area_id: string | null },
  areas: Map<string, AreaInfo>,
): { tier: Tier; source: "override" | "area" | "default" } {
  if (entity.tier && isTier(entity.tier)) return { tier: entity.tier, source: "override" };
  if (entity.area_id) {
    const area = areas.get(entity.area_id);
    if (area) return { tier: area.childTier, source: "area" };
  }
  return { tier: "personal", source: "default" };
}

export function openEntity(row: EntityRow, areas: Map<string, AreaInfo>, sealedKey: Buffer): OpenEntity {
  let title = row.title ?? "";
  let body = row.body;
  let properties: Record<string, unknown> = {};
  if (row.content_sealed) {
    title = openString(sealedKey, title);
    body = body ? openString(sealedKey, body) : null;
    const raw = openString(sealedKey, row.properties);
    properties = asObject(JSON.parse(raw));
  } else {
    properties = asObject(JSON.parse(row.properties || "{}"));
    properties = unsealPropertyValues(properties, sealedKey);
  }
  const own = ownTier(row, areas);
  return {
    ...row,
    title,
    body,
    plainTitle: title,
    plainBody: body,
    plainProperties: properties,
    effectiveTier: own.tier,
    tierSource: own.source,
  };
}

function unsealPropertyValues(props: Record<string, unknown>, sealedKey: Buffer): Record<string, unknown> {
  const privacy = asObject(props._privacy);
  const copy: Record<string, unknown> = { ...props };
  for (const [key, tier] of Object.entries(privacy)) {
    if (tier === "sealed" && typeof copy[key] === "string" && isSealed(copy[key] as string)) {
      copy[key] = JSON.parse(openString(sealedKey, copy[key] as string));
    }
  }
  return copy;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    out[key] = entry;
  }
  return out;
}

/** The word in an allow list of areas that lets a key read the rows with no area. */
export const NO_AREA = "none";

export function areaDenied(entity: { id: string; type: string; area_id: string | null }, access: Access, areas?: Map<string, AreaInfo>): boolean {
  const deny = access.principal.denyAreas;
  // An entry is the id of an area, or `role:<name>` for each area whose kind has that role.
  const denied = (areaId: string) => {
    if (deny.includes(areaId)) return true;
    const role = areas?.get(areaId)?.role;
    return Boolean(role && deny.includes(`role:${role}`));
  };
  if (entity.type === "area" && denied(entity.id)) return true;
  if (entity.area_id && denied(entity.area_id)) return true;
  // An allow list means what it says. An area row counts as its own area. A row with no area is open only when
  // the list holds the word "none".
  const allow = access.principal.allowAreas;
  if (allow) {
    const home = entity.type === "area" ? entity.id : entity.area_id;
    if (home ? !allow.includes(home) : !allow.includes(NO_AREA)) return true;
  }
  if (access.principal.allowTypes && !access.principal.allowTypes.includes(entity.type)) return true;
  return false;
}

export type EntityView = {
  id: string;
  type: EntityType;
  title: string;
  body: string | null;
  status: string | null;
  kind: string | null;
  due_at: string | null;
  area_id: string | null;
  properties: Record<string, unknown>;
  tier: Tier;
  tier_source: "override" | "area" | "default";
  origin: string;
  origin_ref: string | null;
  source_id: string | null;
  external_id: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: null;
};

/** Returns null when the row must be omitted. Decrypts only after the ceiling check. Never returns ciphertext. */
export function projectEntity(row: EntityRow, areas: Map<string, AreaInfo>, access: Access, sealedKey: Buffer): EntityView | null {
  if (row.deleted_at) return null;
  if (areaDenied(row, access, areas)) return null;
  const own = ownTier(row, areas);
  const ceiling = rowCeiling(access, row, areas);
  if (!covers(ceiling, own.tier)) return null;
  const opened = openEntity(row, areas, sealedKey);
  const properties = filterProperties(opened.plainProperties, opened.effectiveTier, ceiling);
  return {
    id: row.id,
    type: row.type,
    title: opened.plainTitle,
    body: opened.plainBody,
    status: row.status,
    kind: row.kind,
    due_at: row.due_at,
    area_id: row.area_id,
    properties,
    tier: opened.effectiveTier,
    tier_source: opened.tierSource,
    origin: row.origin,
    origin_ref: row.origin_ref,
    source_id: row.source_id,
    external_id: row.external_id,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: null,
  };
}

function filterProperties(props: Record<string, unknown>, entityTier: Tier, ceiling: Tier): Record<string, unknown> {
  const privacy = asObject(props._privacy);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "_privacy") continue;
    const fieldTier = isTier(privacy[key]) ? stricter(entityTier, privacy[key]) : entityTier;
    if (!covers(ceiling, fieldTier)) continue;
    if (typeof value === "string" && isSealed(value)) continue;
    out[key] = value;
  }
  return out;
}

export type LinkView = {
  id: string;
  rel: string;
  direction: "out" | "in";
  peer: { type: string; id: string; title: string; kind: string | null; tier: Tier };
};

export function projectLinks(
  entityId: string,
  links: LinkRow[],
  views: Map<string, EntityView>,
): LinkView[] {
  const out: LinkView[] = [];
  for (const link of links) {
    if (link.deleted_at) continue;
    const forward = link.from_id === entityId;
    const backward = link.to_id === entityId;
    if (!forward && !backward) continue;
    const peer = views.get(forward ? link.to_id : link.from_id);
    if (!peer) continue;
    out.push({
      id: link.id,
      rel: link.rel,
      direction: forward ? "out" : "in",
      peer: { type: peer.type, id: peer.id, title: peer.title, kind: peer.kind, tier: peer.tier },
    });
  }
  return out;
}

/**
 * What an approval writes, in words that the server made: the item, each changed field, and a warning.
 * `text` is the value after the approval. `was` is the value now, for a change that waits.
 */
export type ProposalSummary = {
  title: string;
  lines: Array<{ label: string; text: string; was?: string }>;
  warning: string | null;
};

export type ProposalView = {
  id: string;
  agent_name: string;
  op: string;
  entity_type: string | null;
  entity_id: string | null;
  tier: Tier;
  status: string;
  created_at: string;
  decided_at: string | null;
  redacted: boolean;
  reason?: string | null;
  payload?: unknown;
  read_set?: unknown;
  model_id?: string | null;
  model_version?: string | null;
  /** The last day, in the owner's time zone, on which this proposal is still useful. */
  expires_on?: string | null;
  /** Named by the server: `worker:<id>`, `plugin:<id>`, or `key:<credential id>`. */
  source?: string;
  decided_by?: string | null;
  summary?: ProposalSummary;
};

export function projectProposal(row: ProposalRow, access: Access, sealedKey: Buffer): ProposalView | null {
  const visible = covers(access.ceiling, row.tier);
  if (!visible) {
    if (access.surface === "phone" && row.tier === "sealed" && access.ceiling === "private" && row.status === "pending") {
      return {
        id: row.id,
        agent_name: row.agent_name,
        op: row.op,
        entity_type: null,
        entity_id: null,
        tier: "sealed",
        status: row.status,
        created_at: row.created_at,
        decided_at: null,
        redacted: true,
        source: sourceOf(row),
      };
    }
    return null;
  }
  const payload = decodeSealedJson(row.payload, sealedKey);
  const reason = row.reason ? (isSealed(row.reason) ? openString(sealedKey, row.reason) : row.reason) : null;
  const readSet = decodeSealedJson(row.read_set, sealedKey);
  return {
    id: row.id,
    agent_name: row.agent_name,
    op: row.op,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    tier: row.tier,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    redacted: false,
    reason,
    payload,
    read_set: readSet,
    model_id: row.model_id ?? null,
    model_version: row.model_version ?? null,
    expires_on: row.expires_on ?? null,
    source: sourceOf(row),
    decided_by: row.decided_by,
  };
}

function decodeSealedJson(value: string | null, sealedKey: Buffer): unknown {
  if (!value) return null;
  const text = isSealed(value) ? openString(sealedKey, value) : value;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A hidden credential reads Public only. It also cannot make, change, or show a credential, so it cannot get around Hide. */
export function assertNotHidden(access: Access) {
  if (access.principal.forcedCeiling) {
    throw new ApiError(403, "hidden", "This device is hidden. Show your things from the menu bar of your HMN first.");
  }
}

export function assertScope(access: Access, need: "read" | "write") {
  if (need === "read") return;
  if (access.principal.external) {
    throw new ApiError(403, "external", "An outside client cannot write or approve.");
  }
  if (access.principal.scope !== "write") {
    throw new ApiError(403, "use_proposals", "This credential cannot write. Agents propose, and the owner approves.");
  }
}

export function assertCanSeeTier(access: Access, tier: Tier) {
  if (!covers(access.ceiling, tier)) {
    throw new ApiError(403, "ceiling", "This surface cannot receive that tier.");
  }
}

/** `fixtureKinds` is each event kind with the role `fixture`. A row marked `no_results` is a fixture too. */
export function assertNoSpoilers(type: string, kind: string | null, properties: Record<string, unknown>, fixtureKinds: Set<string> = LEGACY_ROLES.fixtureEvent) {
  const fixture = type === "event" && ((kind !== null && fixtureKinds.has(kind)) || properties.no_results === true);
  if (!fixture) return;
  for (const key of Object.keys(properties)) {
    if (SPOILER_KEYS.has(key)) {
      throw new ApiError(422, "no_scores", "Fixtures keep a start time only.");
    }
  }
}

/** `allowed` is the kinds that the type accepts now. The kinds are rows, so the caller reads them. Null accepts any kind. */
export function assertShape(type: string, status: string | null, kind: string | null, allowed: Set<string> | null) {
  if (STATUS[type] && status && !STATUS[type]!.includes(status)) {
    throw new ApiError(422, "bad_status", "That status is not valid for this type.");
  }
  if (allowed && kind && !allowed.has(kind)) {
    throw new ApiError(422, "bad_kind", "That kind is not valid for this type. Add the kind first.");
  }
  if (type === "area" && !kind) {
    throw new ApiError(422, "bad_kind", "An area needs a kind.");
  }
}

export function agentTierFloor(declared: Tier | null, floor: Tier): Tier {
  if (declared && tierBelow(declared, floor)) {
    throw new ApiError(422, "tier_floor", "A proposal cannot be more visible than its sources.");
  }
  return declared ? stricter(declared, floor) : floor;
}

function tierBelow(a: Tier, b: Tier): boolean {
  return stricter(a, b) === b && a !== b;
}

export function requireVaultFor(access: Access, tier: Tier) {
  if (tier === "sealed" && !covers(access.ceiling, "sealed")) {
    throw new ApiError(403, "vault_required", "Open the vault to read or approve this.");
  }
}
