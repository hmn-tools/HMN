# Models

Models are a layer under the workers. A worker proposes. A model may draft the words. The policy layer decides which model is allowed to see which tier. The owner approves before anything is written.

The stable call is `modelClient` in `server/src/models/client.ts`. Workers pass a task, a tier, instructions, and data. The result names the model id and version. A proposal stores those on `model_id` and `model_version`.

## Registry

Every known model is listed, whether or not it is installed.

| Id | Where it runs | Privacy | What it can do |
| --- | --- | --- | --- |
| `hmn.fallback` | In the server process. No network. | local | Chat, embeddings, and a silent stand-in for speech. |
| `apple.foundation` | The phone, when the OS provides it. The server does not call it. | on-device | Chat. |
| `apple.speech` | The phone. Audio is not uploaded. | on-device | Speech to text. |
| `ollama:qwen2.5:*` and `ollama:nomic-embed-text` | Ollama on `127.0.0.1:11434`. | local | Chat, or embeddings for the small embed model. |
| `lmstudio:local` | `127.0.0.1:1234` | local | Chat. |
| `llamacpp:local` | `127.0.0.1:8080` | local | Chat. |
| `mlx:local` | `127.0.0.1:8090` | local | Chat. |
| `cloud:openai` | An https endpoint the owner names. | cloud | Chat, embeddings, vision. Off until opt-in. |

Each row also carries context length, size on disk, RAM, speed, and a price. Local and on-device prices are zero. The cloud catalog price is 5 US dollars per million tokens. That is an estimate, not an invoice.

## Routing

| Task | Usual model |
| --- | --- |
| Morning brief, triage, weekly review, chat | The local chat model named by `HMN_LLM_MODEL`, or the deterministic fallback. |
| Search embeddings | `ollama:nomic-embed-text` when it is installed, otherwise the deterministic embedding. |
| Transcription | On-device speech. The server does not send audio away. |

If the chosen model is down, refused, or over the spend cap, the chain is: that model, then a smaller local model, then `hmn.fallback`. The fallback returns no generated text. The worker then uses its own deterministic draft.

Private and Sealed data can go to an on-device or local model. They cannot go to a cloud model. Opt-in and a ceiling do not override that. A public or personal job that still carries a Private or Sealed entity in its payload is refused the same way. Cloud otherwise needs an explicit opt-in and a ceiling of Public or Personal. The ceiling is the highest tier that may be sent.

## Egress and the spend cap

A worker with cloud turned on uses this record and this cap too. It does not call the cloud host without them, and it sends at most 24,000 characters in one call.

Before a cloud request is sent, the server writes a log row:

- character count of the payload
- token estimate, characters divided by four
- entity ids and tiers that were included
- destination host
- estimated dollars from the registry price

The row does not store titles or bodies. The default cap is 10 US dollars per calendar month. `POST /api/v1/admin/models/cap` on the mini can set another amount from 0 to 1000. When the next call would pass the cap, that call is not sent. The job falls back to a local model or the deterministic path. The notice is: "Cloud spend reached the monthly cap. This call stayed on the machine."

`GET /api/v1/models/spend` is what the phone settings row and the menu bar show: tokens, dollars, the cap, and the notice. The display does not get this.

## Lifecycle

Pull, remove, pin, warm, and unload are localhost admin routes under `/api/v1/admin/models/`. Pull and remove talk to Ollama on loopback. Pin stores a version name. Warm and unload set Ollama `keep_alive`. Stats (calls, errors, latency, tokens) stay in the local database.

`deploy/install.sh --local-llm` installs Ollama if Homebrew can, binds it to `127.0.0.1:11434`, and pulls the model from [LOCAL-MODELS.md](LOCAL-MODELS.md). `deploy/doctor.sh` says whether that model answered.

## Search

Embeddings for the index are local. A cloud embedder is not used for the index. Semantic search returns only entities the caller's ceiling may see. A vector for a Sealed note is not a result at Private.
