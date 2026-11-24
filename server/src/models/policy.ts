import { covers, isTier, type Tier } from "../types";

export type PrivacyClass = "on_device" | "local" | "cloud";
export type ModelCapability = "chat" | "embeddings" | "vision" | "speech_to_text";
export type ModelSpeed = "fast" | "steady" | "slow";
export type ModelRuntime = "fallback" | "ollama" | "lmstudio" | "llamacpp" | "mlx" | "apple" | "cloud";
export type ModelTask = "morning_brief" | "triage" | "weekly_review" | "search_embeddings" | "transcription" | "chat";

export const MODEL_TASKS: ModelTask[] = [
  "morning_brief",
  "triage",
  "weekly_review",
  "search_embeddings",
  "transcription",
  "chat",
];

export type ModelSpec = {
  id: string;
  runtime: ModelRuntime;
  name: string;
  version: string;
  privacy: PrivacyClass;
  capabilities: ModelCapability[];
  context: number;
  diskBytes: number;
  ramBytes: number;
  speed: ModelSpeed;
  endpoint: string | null;
  /** Estimated USD per million tokens. Local and on-device models are zero. */
  usdPerMillion: number;
};

export type CloudGrant = {
  optIn: boolean;
  ceiling: Tier | null;
};

const TASK_CAPABILITY: Record<ModelTask, ModelCapability> = {
  morning_brief: "chat",
  triage: "chat",
  weekly_review: "chat",
  chat: "chat",
  search_embeddings: "embeddings",
  transcription: "speech_to_text",
};

export function capabilityFor(task: ModelTask): ModelCapability {
  return TASK_CAPABILITY[task];
}

/** Private and sealed text never leaves the machine. Cloud cannot be opted into those tiers. */
export function privacyAllows(model: Pick<ModelSpec, "privacy">, tier: Tier, grant: CloudGrant): { ok: true } | { ok: false; reason: string } {
  if (tier === "private" || tier === "sealed") {
    if (model.privacy === "cloud") {
      return { ok: false, reason: "Private and sealed data stay on this machine." };
    }
    return { ok: true };
  }
  if (model.privacy !== "cloud") return { ok: true };
  if (!grant.optIn) return { ok: false, reason: "Cloud needs an explicit opt-in." };
  if (!grant.ceiling || grant.ceiling === "private" || grant.ceiling === "sealed") {
    return { ok: false, reason: "Cloud needs a public, household, or personal ceiling." };
  }
  if (!covers(grant.ceiling, tier)) return { ok: false, reason: "That tier is above the cloud ceiling." };
  return { ok: true };
}

export function fallbackChain(
  task: ModelTask,
  tier: Tier,
  models: ModelSpec[],
  routeId: string | null,
  grant: CloudGrant,
): ModelSpec[] {
  const capability = capabilityFor(task);
  const allowed = (model: ModelSpec) =>
    model.capabilities.includes(capability) && privacyAllows(model, tier, grant).ok;
  const fallback = models.find((model) => model.id === "hmn.fallback");
  const chain: ModelSpec[] = [];
  const primary = routeId ? models.find((model) => model.id === routeId) : undefined;
  if (primary && allowed(primary)) chain.push(primary);
  const locals = models
    .filter((model) => model.id !== "hmn.fallback" && model.privacy !== "cloud" && allowed(model) && model.id !== primary?.id)
    .sort((a, b) => b.ramBytes - a.ramBytes);
  const smaller = primary ? locals.find((model) => model.ramBytes < primary.ramBytes) : locals[locals.length - 1];
  if (smaller && !chain.some((model) => model.id === smaller.id)) chain.push(smaller);
  if (fallback && allowed(fallback) && !chain.some((model) => model.id === fallback.id)) chain.push(fallback);
  return chain;
}

export function hashEmbed(text: string, dimensions = 32): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const bytes = Buffer.from(text.toLowerCase());
  for (let i = 0; i < bytes.length; i++) {
    vector[i % dimensions] = (vector[i % dimensions] ?? 0) + (bytes[i] ?? 0) / 255;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let score = 0;
  for (let i = 0; i < length; i++) score += (a[i] ?? 0) * (b[i] ?? 0);
  return score;
}

export type EgressEntity = { id: string; tier: Tier };

export type EgressPreview = {
  chars: number;
  tokens: number;
  entities: EgressEntity[];
  destination: string;
  blocked: boolean;
  usd: number;
};

const DEFAULT_CAP_USD = 10;

export function defaultSpendCap(): number {
  return DEFAULT_CAP_USD;
}

/** Walk a payload for id+tier pairs. Titles and bodies are not copied. */
export function collectEntities(value: unknown, out: EgressEntity[] = []): EgressEntity[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEntities(item, out);
    return out;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && isTier(record.tier)) out.push({ id: record.id, tier: record.tier });
  for (const child of Object.values(record)) collectEntities(child, out);
  return out;
}

export function egressPreview(instructions: string, data: unknown, destination: string, usdPerMillion: number): EgressPreview {
  const entities = collectEntities(data);
  const chars = JSON.stringify({ instructions, data }).length;
  const tokens = Math.max(1, Math.ceil(chars / 4));
  const blocked = entities.some((entity) => entity.tier === "private" || entity.tier === "sealed");
  const usd = (tokens / 1_000_000) * usdPerMillion;
  return { chars, tokens, entities, destination, blocked, usd };
}

export function capBlocks(spentUsd: number, nextUsd: number, capUsd: number): boolean {
  return spentUsd + nextUsd > capUsd;
}
