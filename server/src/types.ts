/**
 * The tiers, from the most visible to the least. Household is for the people who live in the home: the fridge,
 * the phones of household members, and the owner. It is above Public, so a guest agent and the lock screen do not
 * read it, and below Personal, so each surface of the owner reads it.
 */
export const TIERS = ["public", "household", "personal", "private", "sealed"] as const;
export type Tier = (typeof TIERS)[number];

/** The version of this server. The apps and the release tag use the same number. */
export const VERSION = "0.2.1";

export const SURFACES = ["phone", "widget", "display", "lock", "mcp", "api"] as const;
export type Surface = (typeof SURFACES)[number];
/** The port that a request came in on: the main API, or the port for outside MCP clients. */
export type Listener = "main" | "external";

export const ENTITY_TYPES = [
  "area",
  "person",
  "goal",
  "project",
  "task",
  "note",
  "event",
  "place",
  "asset",
  "source",
  "habit",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const SCOPES = ["read", "write", "agent"] as const;
export type Scope = (typeof SCOPES)[number];

export const SURFACE_CEILING: Record<Surface, Tier> = {
  display: "public",
  lock: "public",
  widget: "personal",
  api: "personal",
  phone: "private",
  mcp: "personal",
};

export const SPOILER_KEYS = new Set([
  "score",
  "scores",
  "result",
  "results",
  "winner",
  "standing",
  "standings",
  "points",
]);

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function stricter(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

export function looser(a: Tier, b: Tier): Tier {
  return tierRank(a) <= tierRank(b) ? a : b;
}

export function covers(ceiling: Tier, item: Tier): boolean {
  return tierRank(ceiling) >= tierRank(item);
}

export type EntityRow = {
  id: string;
  type: EntityType;
  title: string | null;
  body: string | null;
  status: string | null;
  kind: string | null;
  due_at: string | null;
  area_id: string | null;
  properties: string;
  tier: Tier | null;
  content_sealed: number;
  origin: string;
  origin_ref: string | null;
  source_id: string | null;
  external_id: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type LinkRow = {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  rel: string;
  origin: string;
  origin_ref: string | null;
  tier: Tier | null;
  created_at: string;
  deleted_at: string | null;
};

export type CredentialRow = {
  id: string;
  name: string;
  kind: "key" | "device";
  key_hash: string;
  scope: Scope;
  max_tier: Tier;
  vault: number;
  allow_types: string | null;
  allow_areas: string | null;
  deny_areas: string | null;
  forced_ceiling: Tier | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  rotated_from: string | null;
  external?: number;
  /** The Private grant of an agent key ends at this instant. Null is no grant. */
  private_until?: string | null;
  last_used_at?: string | null;
  free_busy?: number;
  guest?: number;
  /** The credential that made this one. */
  created_by?: string | null;
  /** Set for the phone of a household member. */
  member_role?: string | null;
  person_id?: string | null;
};

export type ProposalRow = {
  id: string;
  agent_name: string;
  key_id: string | null;
  op: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: string | null;
  reason: string | null;
  read_set: string | null;
  tier: Tier;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  model_id?: string | null;
  model_version?: string | null;
  source_key?: string | null;
  expires_on?: string | null;
  source?: string | null;
  applied?: string | null;
  undone_at?: string | null;
  idempotency_key?: string | null;
};

export type Principal = {
  id: string;
  name: string;
  kind: "key" | "device";
  scope: Scope;
  maxTier: Tier;
  vault: boolean;
  denyAreas: string[];
  allowAreas: string[] | null;
  allowTypes: string[] | null;
  forcedCeiling: Tier | null;
  /** Set for a credential issued to an off-box MCP client. */
  external?: boolean;
  /** True while the owner's Private grant for this agent key has not ended. */
  privateGrant?: boolean;
  /** True when the owner lets this key read busy times. */
  freeBusy?: boolean;
  /** True for the agent of another person. It reads Public, and it proposes an event or an inbox item only. */
  guest?: boolean;
  /** A member of the household: a person who uses HMN through the app, with a role. docs/ONTOLOGY.md, section 5.4. */
  member?: { role: MemberRole; personId: string };
  /**
   * A ceiling for named areas, above the ceiling of the key. A key is an area id, or `role:<name>` for each area
   * whose kind has that role. It applies on the phone only, and never while the credential is hidden.
   */
  areaTiers?: Record<string, Tier>;
};

/** The role of a household member. The words are in kinds.ts, with the other fixed words. */
export type MemberRole = (typeof import("./kinds").MEMBER_ROLES)[number];

export type Access = {
  principal: Principal;
  surface: Surface;
  grant: boolean;
  ceiling: Tier;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
