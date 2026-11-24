# Local model sizes

`deploy/install.sh --local-llm` reads the chip and the unified memory, then pulls one Ollama model. The same table is `defaultLocalModel` in `server/src/models/catalog.ts`. The rest of the model layer is [MODELS.md](MODELS.md).

| Memory | Apple silicon | Intel |
| --- | --- | --- |
| under 12 GB | `qwen2.5:3b` | `qwen2.5:3b` |
| 12 GB up to 24 GB | `qwen2.5:7b` | `qwen2.5:3b` |
| 24 GB up to 36 GB | `qwen2.5:14b` | `qwen2.5:3b` |
| 36 GB and above | `qwen2.5:32b` | `qwen2.5:3b` |

Intel stays on the 3B model because it has no unified memory to spare. The menu can install or remove a different local model later. Ollama is bound to `127.0.0.1:11434` only.
