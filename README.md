# MemCore

MemCore is a memory engine for AI agents — chunks, atomic memories, a typed graph, hybrid retrieval with temporal reasoning. Inspired by Supermemory and Mem0.

It ships in two shapes:

- **Library**: `import { MemCore } from "memcore"` — embed the engine in your own process.
- **Server**: a Fastify HTTP API at `/v1/...` for clients that want a separate service.

Both surface the same operations. The server is a thin wrapper around the library.

## What this is

A backend system that gives AI agents persistent memory across sessions. You feed it conversations and documents; it extracts atomic facts, stores them in a graph that handles updates and contradictions, and serves them back via a search API. Your agent queries this on every turn and gets relevant memories with full source context.

This is **not** a chat app, a vector database, or a RAG library. It is a memory engine that uses retrieval as one component.

## Documentation

Read these in order:

1. **[README.md](./README.md)** — you are here
2. **[AGENTS.md](./AGENTS.md)** — instructions for AI coding agents working in this repo
3. **[DESIGN.md](./DESIGN.md)** — the architectural reasoning
4. **[SPEC.md](./SPEC.md)** — schemas, APIs, configuration (authoritative reference)
5. **[ROADMAP.md](./ROADMAP.md)** — phased build plan
6. **[CONTRIBUTING.md](./CONTRIBUTING.md)** — contribution conventions

## Quickstart (local dev)

Prerequisites: Docker, Node 20+, pnpm.

```bash
# 1. Clone and enter
git clone <repo>
cd MemCore

# 2. Set up environment
cp .env.example .env
# edit .env: set OPENAI_API_KEY (or inject your own embedder programmatically)

# 3. Start dependencies
docker compose up -d  # Postgres + Redis

# 4. Install JS deps
pnpm install

# 5. Apply schema (destructive — drops & recreates every table)
pnpm db:reset

# 6. Run the API
pnpm dev
```

Verify:

```bash
curl http://localhost:8000/v1/health
# {"status":"ok","db":"ok"}
```

## Use as a library

```ts
import { MemCore } from "memcore";

const memcore = new MemCore({
  databaseUrl: process.env.DATABASE_URL!,
  openaiApiKey: process.env.OPENAI_API_KEY,
});

await memcore.add({
  containerTag: "user_42",
  messages: [
    { role: "user", content: "I just moved to Brooklyn last week." },
    { role: "assistant", content: "Congrats on the move!" },
  ],
  externalId: "session-1",
});

const { results } = await memcore.search({
  containerTag: "user_42",
  query: "where does the user live?",
});

await memcore.close();
```

You can also inject your own embedder or LLM client — anything implementing the `Embedder` / `LLMClient` interfaces:

```ts
const memcore = new MemCore({
  databaseUrl: "...",
  embedder: myEmbedder, // satisfies the Embedder interface
});
```

### Using a different embedding provider

The default embedder hits any OpenAI-compatible `/v1/embeddings` endpoint, so most local servers work with one config knob. **LMStudio**:

```ts
import { MemCore, OpenAICompatibleEmbedder } from "memcore";

const memcore = new MemCore({
  databaseUrl: process.env.DATABASE_URL!,
  embeddingBaseUrl: "http://localhost:1234/v1", // LMStudio
  embeddingApiKey: "lm-studio",                 // any string is fine
  embeddingModel: "nomic-embed-text-v1.5",
  embeddingDim: 768,                            // match your model
});
```

Or via env (no code change):

```env
EMBEDDING_BASE_URL=http://localhost:1234/v1
EMBEDDING_API_KEY=lm-studio
EMBEDDING_MODEL=nomic-embed-text-v1.5
EMBEDDING_DIM=768
```

The same shape works for **Ollama** (`http://localhost:11434/v1`), **vLLM**, **llama.cpp's server**, etc. For providers that don't speak the OpenAI shape (Cohere, Voyage), implement the `Embedder` interface directly and pass it via `embedder:`.

### Embedding dimensions past 2000

`chunks.embedding` is stored as pgvector `VECTOR` with no fixed dim, so any model works without a schema change. ANN indexes are dim-capped, and `pnpm db:vector-index` picks the right strategy from `EMBEDDING_DIM`:

| `EMBEDDING_DIM` | Index                                                        |
| --------------- | ------------------------------------------------------------ |
| ≤ 2000          | HNSW over `embedding vector_cosine_ops`                      |
| 2001..4000      | HNSW over `embedding::halfvec(N) halfvec_cosine_ops` (16-bit) |
| > 4000          | HNSW over `binary_quantize(embedding)::bit(N) bit_hamming_ops` + cosine rerank |

Phase 1 ships with no ANN index — sequential scan is fine until the corpus is large. Run `pnpm db:vector-index` once you need it (or before Phase 3 lands hybrid search).

## Use as a server

Add some content:

```bash
curl -X POST http://localhost:8000/v1/add \
  -H "Content-Type: application/json" \
  -d '{
    "container_tag": "test_user",
    "messages": [
      {"role": "user", "content": "I just moved to Brooklyn last week."},
      {"role": "assistant", "content": "Congrats on the move!"}
    ],
    "external_id": "test-session-1"
  }'
```

Search:

```bash
curl -X POST http://localhost:8000/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "container_tag": "test_user",
    "query": "where does the user live?"
  }'
```

## Running the eval suite

The eval suite is how we measure quality. Run it before and after any change to extraction, retrieval, or conflict detection.

```bash
pnpm eval                                       # all categories
pnpm eval -- --category single_session_recall   # one category
pnpm eval -- --output report.json               # write a JSON report
```

Report includes per-category accuracy, latency, and (later) cost.

## Project layout

See `SPEC.md` § Project Structure for the canonical layout. High-level:

```
src/
├── memcore.ts          # the MemCore SDK class
├── api/                # Fastify server (wraps the SDK)
├── ingestion/          # chunk → embed → store (Phase 1); + extract/conflict in later phases
├── retrieval/          # vector search; + keyword/RRF/rerank in Phase 3
├── llm/                # injectable LLMClient + Embedder interfaces, default impls
├── db/                 # postgres.js pool, vector helpers
└── index.ts            # public package entry

db/
├── schema.sql          # single source of truth — applied destructively by `pnpm db:reset`
└── reset.ts

evals/                  # quality measurement harness + JSONL cases
```

We do not run database migrations during pre-production phases — the schema is small and churn is expected. Phase 8 (production hardening) introduces a migration tool.

## Scripts

| Script              | What it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `pnpm dev`          | Start the Fastify API in watch mode (tsx)                     |
| `pnpm build`        | Build the package + server with tsup                          |
| `pnpm db:reset`     | **Destructive.** Drop & recreate all tables from `db/schema.sql` |
| `pnpm db:vector-index` | Build the right HNSW index for the current `EMBEDDING_DIM`     |
| `pnpm test`         | Run vitest unit tests                                          |
| `pnpm typecheck`    | `tsc --noEmit`                                                 |
| `pnpm lint`         | `biome check .`                                                |
| `pnpm lint:fix`     | `biome check --write .`                                        |
| `pnpm eval`         | Run the eval harness                                           |

## Status

**Phase 1 complete (naive RAG baseline).** See [ROADMAP.md](./ROADMAP.md) for what's built, what's next, and where we are.

## License

MIT.
