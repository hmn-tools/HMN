import type { Database } from "bun:sqlite";
import { accountWorkerCloud } from "../models/client";
import { readPluginSecret } from "../plugins/secrets";
import type { Tier } from "../types";
import type { WorkerConfig } from "./config";
import { assertCloudEndpoint, assertLocalEndpoint } from "./config";
import { buildModelInput } from "./guard";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type LlmClient = {
  id: "fallback" | "local" | "cloud";
  complete(instructions: string, data: unknown): Promise<string>;
};

export const fallbackClient: LlmClient = {
  id: "fallback",
  async complete() {
    return "";
  },
};

/** A worker sends at most this many characters to a cloud model in one call. */
export const CLOUD_MAX_CHARS = 24_000;

export function clientFor(worker: WorkerConfig, fetchImpl?: FetchLike, db?: Database): { client: LlmClient; warning: string | null } {
  if (worker.llm_mode === "cloud") {
    if (!worker.cloud_enabled || !worker.cloud_warning_ack || !worker.cloud_endpoint) return { client: fallbackClient, warning: null };
    assertCloudEndpoint(worker.cloud_endpoint);
    const key = readPluginSecret("hmn.llm.cloud", "HMN_LLM_CLOUD_KEY");
    if (!key) return { client: fallbackClient, warning: null };
    const tier: Tier = worker.cloud_tier ?? worker.tier;
    const endpoint = worker.cloud_endpoint;
    const account = (instructions: string, data: unknown) => {
      if (JSON.stringify({ instructions, data }).length > CLOUD_MAX_CHARS) throw new Error("too_large");
      // With no database there is no record and no cap, so the call does not go out.
      if (!db) throw new Error("no_ledger");
      accountWorkerCloud(db, endpoint, worker.llm_model, tier, { instructions, data }, new Date().toISOString());
    };
    return {
      client: httpClient("cloud", endpoint, worker.llm_model, key, fetchImpl ?? fetch, account),
      warning: null,
    };
  }
  if (worker.llm_mode === "local") {
    const endpoint = process.env.HMN_LLM_URL?.trim() || worker.llm_endpoint;
    try {
      assertLocalEndpoint(endpoint);
    } catch {
      return { client: fallbackClient, warning: null };
    }
    return { client: httpClient("local", endpoint, worker.llm_model, null, fetchImpl ?? fetch), warning: null };
  }
  return { client: fallbackClient, warning: null };
}

function httpClient(
  id: "local" | "cloud",
  endpoint: string,
  model: string,
  key: string | null,
  fetchImpl: FetchLike,
  account?: (instructions: string, data: unknown) => void,
): LlmClient {
  return {
    id,
    async complete(instructions, data) {
      account?.(instructions, data);
      const input = buildModelInput(instructions, data);
      const ollama = id === "local" && endpoint.includes("/api/chat");
      const body = ollama
        ? { model, stream: false, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] }
        : { model, temperature: 0, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key) headers.authorization = `Bearer ${key}`;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(id === "local" ? 8_000 : 15_000),
      });
      if (!response.ok) throw new Error("model");
      const payload = (await response.json()) as { message?: { content?: string }; choices?: Array<{ message?: { content?: string } }> };
      const text = payload.message?.content ?? payload.choices?.[0]?.message?.content ?? "";
      return text.slice(0, 8_000);
    },
  };
}
