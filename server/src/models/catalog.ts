import type { ModelSpec } from "./policy";

/** Catalog of runtimes the menu and the router know about. Installed state is filled in later. */
export function catalog(): ModelSpec[] {
  return [
    {
      id: "hmn.fallback",
      runtime: "fallback",
      name: "Deterministic",
      version: "1",
      privacy: "local",
      capabilities: ["chat", "embeddings", "speech_to_text"],
      context: 0,
      diskBytes: 0,
      ramBytes: 0,
      speed: "fast",
      endpoint: null,
      usdPerMillion: 0,
    },
    {
      id: "apple.foundation",
      runtime: "apple",
      name: "Apple Foundation Models",
      version: "os",
      privacy: "on_device",
      capabilities: ["chat"],
      context: 4096,
      diskBytes: 0,
      ramBytes: 0,
      speed: "fast",
      endpoint: null,
      usdPerMillion: 0,
    },
    {
      id: "apple.speech",
      runtime: "apple",
      name: "On-device speech",
      version: "os",
      privacy: "on_device",
      capabilities: ["speech_to_text"],
      context: 0,
      diskBytes: 0,
      ramBytes: 0,
      speed: "fast",
      endpoint: null,
      usdPerMillion: 0,
    },
    spec("ollama:qwen2.5:3b", "qwen2.5:3b", "3b", 32_768, 2_000_000_000, 3_000_000_000, "fast", ["chat"]),
    spec("ollama:qwen2.5:7b", "qwen2.5:7b", "7b", 32_768, 4_700_000_000, 6_000_000_000, "steady", ["chat"]),
    spec("ollama:qwen2.5:14b", "qwen2.5:14b", "14b", 32_768, 9_000_000_000, 10_000_000_000, "slow", ["chat"]),
    spec("ollama:qwen2.5:32b", "qwen2.5:32b", "32b", 32_768, 20_000_000_000, 20_000_000_000, "slow", ["chat"]),
    spec("ollama:nomic-embed-text", "nomic-embed-text", "embed", 8192, 274_000_000, 1_000_000_000, "fast", ["embeddings"]),
    {
      id: "lmstudio:local",
      runtime: "lmstudio",
      name: "LM Studio",
      version: "local",
      privacy: "local",
      capabilities: ["chat"],
      context: 8192,
      diskBytes: 0,
      ramBytes: 0,
      speed: "steady",
      endpoint: "http://127.0.0.1:1234/v1",
      usdPerMillion: 0,
    },
    {
      id: "llamacpp:local",
      runtime: "llamacpp",
      name: "llama.cpp",
      version: "local",
      privacy: "local",
      capabilities: ["chat"],
      context: 8192,
      diskBytes: 0,
      ramBytes: 0,
      speed: "steady",
      endpoint: "http://127.0.0.1:8080/v1",
      usdPerMillion: 0,
    },
    {
      id: "mlx:local",
      runtime: "mlx",
      name: "MLX",
      version: "local",
      privacy: "local",
      capabilities: ["chat"],
      context: 8192,
      diskBytes: 0,
      ramBytes: 0,
      speed: "fast",
      endpoint: "http://127.0.0.1:8090/v1",
      usdPerMillion: 0,
    },
    {
      id: "cloud:openai",
      runtime: "cloud",
      name: "OpenAI-compatible cloud",
      version: "unpinned",
      privacy: "cloud",
      capabilities: ["chat", "embeddings", "vision"],
      context: 128_000,
      diskBytes: 0,
      ramBytes: 0,
      speed: "steady",
      endpoint: null,
      usdPerMillion: 5,
    },
  ];
}

function spec(
  id: string,
  name: string,
  version: string,
  context: number,
  diskBytes: number,
  ramBytes: number,
  speed: ModelSpec["speed"],
  capabilities: ModelSpec["capabilities"],
): ModelSpec {
  return {
    id,
    runtime: "ollama",
    name,
    version,
    privacy: "local",
    capabilities,
    context,
    diskBytes,
    ramBytes,
    speed,
    endpoint: "http://127.0.0.1:11434",
    usdPerMillion: 0,
  };
}

/** Same table as docs/LOCAL-MODELS.md and deploy/lib.sh. */
export function defaultLocalModel(memoryGb: number, chip: "apple" | "intel"): string {
  if (chip !== "apple") return "ollama:qwen2.5:3b";
  if (memoryGb < 12) return "ollama:qwen2.5:3b";
  if (memoryGb < 24) return "ollama:qwen2.5:7b";
  if (memoryGb < 36) return "ollama:qwen2.5:14b";
  return "ollama:qwen2.5:32b";
}

/**
 * The Ollama name in an id. A name is a model and a tag, for example `qwen2.5:7b`. A name with a host, a path, or
 * `..` is refused, because Ollama would then download from a registry that the caller names.
 */
export function ollamaName(id: string): string | null {
  if (!id.startsWith("ollama:")) return null;
  const name = id.slice("ollama:".length);
  return /^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9][a-z0-9._-]{0,63})?$/i.test(name) && !name.includes("..") ? name : null;
}
