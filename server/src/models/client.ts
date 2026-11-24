import type { Database } from "bun:sqlite";
import { randomId } from "../crypto";
import { ApiError, covers, isTier, type Tier } from "../types";
import { catalog, ollamaName } from "./catalog";
import {
  cloudGrant,
  listModels,
  monthSpend,
  pinModel,
  readCap,
  readNotice,
  readStats,
  readVectors,
  recordStat,
  routes,
  setInstalled,
  setRoute,
  writeEgress,
  writeNotice,
  writeVector,
  type ModelRow,
} from "./store";
import {
  MODEL_TASKS,
  capabilityFor,
  capBlocks,
  cosine,
  egressPreview,
  fallbackChain,
  hashEmbed,
  privacyAllows,
  type CloudGrant,
  type ModelSpec,
  type ModelTask,
} from "./policy";

export type ModelFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ModelResult = {
  text: string;
  modelId: string;
  modelVersion: string;
  privacy: ModelSpec["privacy"];
  usedModel: boolean;
};

const VOICE_NOTE = "Voice stays on this Mac. It is not sent away.";

export function voiceNote(): string {
  return VOICE_NOTE;
}

export function loopbackOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
  if (url.username || url.password) return null;
  return `${url.protocol}//${url.host}`;
}

export async function discoverInstalled(fetchImpl: ModelFetch): Promise<Set<string>> {
  const found = new Set<string>();
  const probes = [
    ["http://127.0.0.1:11434/api/tags", "ollama"],
    ["http://127.0.0.1:1234/v1/models", "lmstudio:local"],
    ["http://127.0.0.1:8080/v1/models", "llamacpp:local"],
    ["http://127.0.0.1:8090/v1/models", "mlx:local"],
  ] as const;
  for (const [url, kind] of probes) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(400) });
      if (!response.ok) continue;
      const body = (await response.json()) as { models?: Array<{ name?: string }>; data?: Array<{ id?: string }> };
      if (kind === "ollama") {
        for (const model of body.models ?? []) if (model.name) found.add(model.name.split(":")[0] === model.name ? model.name : model.name);
        for (const model of body.models ?? []) if (model.name) found.add(model.name);
      } else {
        found.add(kind);
      }
    } catch {
      // A runtime that is not running is simply absent.
    }
  }
  return found;
}

export async function modelSnapshot(db: Database, fetchImpl: ModelFetch = fetch) {
  const discovered = await discoverInstalled(fetchImpl);
  const models = listModels(db, discovered);
  const grant = cloudGrant(db);
  const month = new Date().toISOString().slice(0, 7);
  const spend = monthSpend(db, month);
  const loaded = models.filter((model) => model.installed && model.runtime === "ollama").reduce((sum, model) => sum + model.ramBytes, 0);
  return {
    models: models.map(publicModel),
    routes: routes(db),
    stats: readStats(db),
    ram_bytes: loaded,
    voice: VOICE_NOTE,
    cloud: { opt_in: grant.optIn, ceiling: grant.ceiling },
    spend: { month, chars: spend.chars, tokens: spend.tokens, usd: spend.usd, cap_usd: readCap(db), notice: readNotice(db, month) },
  };
}

export async function completeTask(
  db: Database,
  task: ModelTask,
  tier: Tier,
  input: { instructions: string; data: unknown },
  options: { grant?: CloudGrant; fetchImpl?: ModelFetch; now?: string } = {},
): Promise<ModelResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const discovered = await discoverInstalled(fetchImpl);
  const models = listModels(db, discovered).filter((model) => model.installed);
  const grant = options.grant ?? cloudGrant(db);
  const chain = fallbackChain(task, tier, models, routes(db)[task] ?? null, grant);
  const at = options.now ?? new Date().toISOString();
  let last = chain[chain.length - 1];
  for (const model of chain) {
    const started = Date.now();
    try {
      if (model.privacy === "cloud") accountCloud(db, model, tier, input, at);
      const result = await callModel(model, task, input, fetchImpl);
      recordStat(db, model.id, Date.now() - started, result.tokens, false, at);
      return {
        text: result.text,
        modelId: model.id,
        modelVersion: model.pinnedVersion ?? model.version,
        privacy: model.privacy,
        usedModel: model.id !== "hmn.fallback" && model.runtime !== "apple",
      };
    } catch {
      recordStat(db, model.id, Date.now() - started, 0, true, at);
      last = model;
    }
  }
  return {
    text: "",
    modelId: last?.id ?? "hmn.fallback",
    modelVersion: "1",
    privacy: "local",
    usedModel: false,
  };
}

export async function indexEntities(
  db: Database,
  tierCeiling: Tier,
  entities: Array<{ id: string; title: string; body: string | null; tier: Tier }>,
  options: { fetchImpl?: ModelFetch; now?: string } = {},
): Promise<{ modelId: string; indexed: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const discovered = await discoverInstalled(fetchImpl);
  const models = listModels(db, discovered).filter((model) => model.installed && model.privacy !== "cloud");
  const grant = cloudGrant(db);
  const chain = fallbackChain("search_embeddings", tierCeiling, models, routes(db).search_embeddings, grant);
  const model = chain[0];
  if (!model) return { modelId: "hmn.fallback", indexed: 0 };
  const at = options.now ?? new Date().toISOString();
  let indexed = 0;
  for (const entity of entities) {
    const decision = privacyAllows(model, entity.tier, grant);
    if (!decision.ok) continue;
    if (model.privacy === "cloud") continue;
    const vector =
      model.id === "hmn.fallback" || model.runtime === "apple"
        ? hashEmbed(`${entity.title}\n${entity.body ?? ""}`)
        : await remoteEmbed(model, `${entity.title}\n${entity.body ?? ""}`, fetchImpl);
    writeVector(db, entity.id, model.id, entity.tier, vector, at);
    indexed += 1;
  }
  return { modelId: model.id, indexed };
}

export function semanticRank(
  db: Database,
  modelId: string,
  query: string,
  ceiling: Tier,
  allowedIds: Set<string>,
): string[] {
  const needle = hashEmbed(query);
  return readVectors(db, modelId)
    .filter((row) => allowedIds.has(row.entityId) && isTier(row.tier))
    .filter((row) => rankAllowed(row.tier as Tier, ceiling))
    .map((row) => ({ id: row.entityId, score: cosine(needle, row.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((row) => row.id);
}

function rankAllowed(tier: Tier, ceiling: Tier): boolean {
  return covers(ceiling, tier);
}

export async function pullModel(db: Database, modelId: string, fetchImpl: ModelFetch = fetch): Promise<{ ok: boolean; message: string }> {
  const name = ollamaName(modelId);
  if (!name) return { ok: false, message: "Only a local Ollama model can be pulled from the mini." };
  // A pull downloads a model. Only a model in the catalog can be pulled from here.
  if (!catalog().some((model) => model.id === modelId)) return { ok: false, message: "That model is not in the catalog." };
  try {
    const response = await fetchImpl("http://127.0.0.1:11434/api/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, stream: false }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { ok: false, message: "The local runtime did not accept that model." };
    setInstalled(db, modelId, true);
    return { ok: true, message: "The model is on this Mac." };
  } catch {
    return { ok: false, message: "The local runtime did not answer." };
  }
}

export async function removeModel(db: Database, modelId: string, fetchImpl: ModelFetch = fetch): Promise<{ ok: boolean; message: string }> {
  if (modelId === "hmn.fallback" || modelId.startsWith("apple.")) {
    return { ok: false, message: "That model stays on the machine." };
  }
  const name = ollamaName(modelId);
  if (!name) {
    setInstalled(db, modelId, false);
    return { ok: true, message: "That runtime is no longer selected." };
  }
  try {
    await fetchImpl("http://127.0.0.1:11434/api/delete", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    return { ok: false, message: "The local runtime did not answer." };
  }
  setInstalled(db, modelId, false);
  return { ok: true, message: "The model was removed from this Mac." };
}

export function pinVersion(db: Database, modelId: string, version: string) {
  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(version)) throw new ApiError(422, "bad_version", "That version name is not usable.");
  if (!listModels(db, new Set()).some((model) => model.id === modelId)) throw new ApiError(404, "not_found", "Not found.");
  pinModel(db, modelId, version);
  return { id: modelId, version };
}

export async function warmModel(modelId: string, unload: boolean, fetchImpl: ModelFetch = fetch): Promise<{ ok: boolean }> {
  const name = ollamaName(modelId);
  if (!name) return { ok: modelId === "hmn.fallback" || modelId.startsWith("apple.") };
  try {
    const response = await fetchImpl("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: name, prompt: "", stream: false, keep_alive: unload ? 0 : "10m" }),
      signal: AbortSignal.timeout(1500),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

export function assignRoute(db: Database, task: string, modelId: string, tier: Tier, grant: CloudGrant) {
  if (!(MODEL_TASKS as string[]).includes(task)) throw new ApiError(422, "bad_task", "Unknown task.");
  const model = listModels(db, new Set()).find((item) => item.id === modelId);
  if (!model) throw new ApiError(404, "not_found", "Not found.");
  const decision = privacyAllows(model, tier, grant);
  if (!decision.ok) throw new ApiError(422, "model_tier", decision.reason);
  if (!model.capabilities.includes(capabilityFor(task as ModelTask))) {
    throw new ApiError(422, "bad_capability", "That model does not do this job.");
  }
  setRoute(db, task as ModelTask, modelId);
  return { task, model_id: modelId };
}

function publicModel(model: ModelRow) {
  return {
    id: model.id,
    runtime: model.runtime,
    name: model.name,
    version: model.version,
    pinned_version: model.pinnedVersion,
    privacy: model.privacy,
    capabilities: model.capabilities,
    context: model.context,
    disk_bytes: model.diskBytes,
    ram_bytes: model.ramBytes,
    speed: model.speed,
    installed: model.installed,
    endpoint_host: model.endpoint ? safeHost(model.endpoint) : null,
  };
}

function safeHost(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return "localhost";
    return null;
  } catch {
    return null;
  }
}

/**
 * The same egress record, Private block, and monthly cap for a worker that calls a cloud model directly. It throws
 * when the call must not go out, and the worker then keeps its fallback text.
 */
export function accountWorkerCloud(db: Database, endpoint: string, model: string, tier: Tier, input: { instructions: string; data: unknown }, at: string) {
  const usdPerMillion = Number(process.env.HMN_LLM_CLOUD_USD_PER_MILLION ?? "5") || 5;
  accountCloud(db, { id: `cloud:${model}`, endpoint, usdPerMillion } as ModelSpec & { usdPerMillion: number; endpoint: string | null }, tier, input, at);
}

function accountCloud(
  db: Database,
  model: ModelSpec & { usdPerMillion: number; endpoint: string | null },
  tier: Tier,
  input: { instructions: string; data: unknown },
  at: string,
) {
  const preview = egressPreview(input.instructions, input.data, destinationOf(model.endpoint), model.usdPerMillion);
  const month = at.slice(0, 7);
  const row = {
    id: randomId("egress"),
    at,
    month,
    modelId: model.id,
    destination: preview.destination,
    chars: preview.chars,
    tokens: preview.tokens,
    entities: preview.entities.map((entity) => ({ id: entity.id, tier: entity.tier })),
  };
  if (tier === "private" || tier === "sealed" || preview.blocked) {
    writeEgress(db, { ...row, usd: 0, blocked: true, capped: false });
    throw new Error("blocked");
  }
  const spent = monthSpend(db, month);
  if (capBlocks(spent.usd, preview.usd, readCap(db))) {
    writeEgress(db, { ...row, usd: 0, blocked: false, capped: true });
    writeNotice(db, month, at, "Cloud spend reached the monthly cap. This call stayed on the machine.");
    throw new Error("cap");
  }
  writeEgress(db, { ...row, usd: preview.usd, blocked: false, capped: false });
}

function destinationOf(endpoint: string | null): string {
  if (!endpoint) return "unknown";
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

async function callModel(
  model: ModelSpec,
  task: ModelTask,
  input: { instructions: string; data: unknown },
  fetchImpl: ModelFetch,
): Promise<{ text: string; tokens: number }> {
  if (model.runtime === "apple") throw new Error("on-device");
  if (model.runtime === "fallback" || !model.endpoint) {
    return { text: "", tokens: 0 };
  }
  if (model.privacy === "cloud") {
    if (!model.endpoint || !model.endpoint.startsWith("https://")) throw new Error("endpoint");
    const response = await fetchImpl(model.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.name,
        temperature: 0,
        messages: [
          { role: "system", content: input.instructions },
          { role: "user", content: JSON.stringify(input.data).slice(0, 8000) },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) throw new Error("model");
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };
    return {
      text: (payload.choices?.[0]?.message?.content ?? "").slice(0, 8000),
      tokens: payload.usage?.total_tokens ?? 0,
    };
  }
  const origin = loopbackOrigin(model.endpoint);
  if (!origin) throw new Error("endpoint");
  const ollama = model.runtime === "ollama";
  const url = ollama ? `${origin}/api/chat` : `${model.endpoint.replace(/\/$/, "")}/chat/completions`;
  const body = ollama
    ? {
        model: ollamaName(model.id),
        stream: false,
        messages: [
          { role: "system", content: input.instructions },
          { role: "user", content: JSON.stringify(input.data).slice(0, 8000) },
        ],
      }
    : {
        model: model.name,
        temperature: 0,
        messages: [
          { role: "system", content: input.instructions },
          { role: "user", content: JSON.stringify(input.data).slice(0, 8000) },
        ],
      };
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(800),
  });
  if (!response.ok) throw new Error("model");
  const payload = (await response.json()) as {
    message?: { content?: string };
    choices?: Array<{ message?: { content?: string } }>;
    eval_count?: number;
    usage?: { total_tokens?: number };
  };
  const text = (payload.message?.content ?? payload.choices?.[0]?.message?.content ?? "").slice(0, 8000);
  const tokens = payload.eval_count ?? payload.usage?.total_tokens ?? 0;
  return { text, tokens };
}

/** Workers call this. `complete` returns the model id and version to store on the proposal. */
export function modelClient(db: Database, fetchImpl?: ModelFetch) {
  return {
    complete(task: ModelTask, tier: Tier, instructions: string, data: unknown, grant?: CloudGrant, now?: string) {
      return completeTask(db, task, tier, { instructions, data }, { fetchImpl, grant, now });
    },
  };
}

async function remoteEmbed(model: ModelSpec, text: string, fetchImpl: ModelFetch): Promise<number[]> {
  const origin = model.endpoint ? loopbackOrigin(model.endpoint) : null;
  if (!origin) return hashEmbed(text);
  const response = await fetchImpl(`${origin}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: ollamaName(model.id), prompt: text.slice(0, 4000) }),
    signal: AbortSignal.timeout(800),
  });
  if (!response.ok) return hashEmbed(text);
  const payload = (await response.json()) as { embedding?: number[] };
  return payload.embedding && payload.embedding.length > 0 ? payload.embedding : hashEmbed(text);
}
