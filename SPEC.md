# SPEC.md

This document is the authoritative reference for **what MemCore does**. Schemas, API contracts, configuration, and project structure are defined here. For *why*, see `DESIGN.md`. For build order, see `ROADMAP.md`.

If the code disagrees with this spec, the spec wins. Update the code, or update the spec deliberately and note it in the changelog at the bottom.

## Tech stack

| Layer                | Choice                                  | Notes                                                  |
| -------------------- | --------------------------------------- | ------------------------------------------------------ |
| Language             | TypeScript (Node 20+)                   | ESM, strict mode, `tsc --noEmit` in CI                 |
| Package manager      | pnpm                                    |                                                        |
| Web framework        | Fastify v5                              | Async-native; Zod schemas via `fastify-type-provider-zod` |
| Validation           | Zod                                     | Request bodies, env config, eval cases                 |
| Database             | Postgres 16+ with `pgvector` extension  | Single store for chunks, memories, embeddings, edges   |
| DB driver            | `postgres` (postgres.js)                | Tagged-template SQL, no ORM                            |
| Search (keyword)     | Postgres `tsvector` + `pg_trgm`         | Sufficient until ~10M memories                         |
| Queue                | Redis + BullMQ                          | Background ingestion jobs (Phase 2+)                   |
| Embedding model      | `text-embedding-3-large` (3072 dim)     | Configurable via `EMBEDDING_MODEL` env var             |
| Tokenizer (chunker)  | `gpt-tokenizer` (cl100k_base)           | Pure JS                                                |
| Extraction LLM       | `claude-haiku-4-5` or `gpt-4o-mini`     | Cheap, fast; configurable                              |
| Conflict detection LLM | `claude-sonnet-4-6` or `gpt-4o`       | Higher reasoning quality needed                        |
| Reranker             | Cohere Rerank v3 (API)                  | `bge-reranker-v2-m3` as fallback for self-hosted       |
| Logger               | `pino`                                  | Structured JSON; pretty in dev                         |
| Lint / format        | `biome`                                 | CI enforced                                            |
| Testing              | `vitest`                                | Co-located test files (`*.test.ts`)                    |
| Bundler              | `tsup`                                  | Builds the SDK + server entry points                   |
| Dev runner           | `tsx`                                   | TypeScript without a build step in dev                 |

### Library and server, one codebase

MemCore ships as a single npm package with two surfaces:

- The **`MemCore` SDK class** (default export). Consumers `new MemCore({...})` and call `add()` / `search()` / `close()` directly. Useful when you want memory in-process with no HTTP hop.
- The **Fastify server** (`./server` subpath, plus the `pnpm dev` / `node dist/api/main.js` entry point). It builds a `MemCore` instance internally and exposes `/v1/...` HTTP endpoints over it.

The server has no logic of its own beyond wire format. Anything callable via HTTP is callable via the class with the same arguments.

### LLM and Embedder are injectable

We ship no provider SDKs. The package exposes two interfaces:

```ts
interface LLMClient { createMessage(params: CreateMessageParams): Promise<LLMResponse>; }
interface Embedder  { embed(args: { texts: string[] }): Promise<EmbeddingResponse>; }
```

The default `Embedder` implementation (`OpenAIEmbedder`, also exported as `OpenAICompatibleEmbedder`) calls any OpenAI-compatible `/v1/embeddings` endpoint via native `fetch`. Set `EMBEDDING_BASE_URL` (e.g. `http://localhost:1234/v1` for LMStudio, `http://localhost:11434/v1` for Ollama) and `EMBEDDING_API_KEY` to point at a local model with no code change. A `StubEmbedder` exists for tests and for boots without an API key. Consumers can pass any object satisfying the interface to the `MemCore` constructor; the type shapes mirror `@agentic/llm` so a thin adapter is all that's needed (Cohere, Voyage, etc.).

## Project structure

```
.
├── AGENTS.md
├── DESIGN.md
├── SPEC.md (this file)
├── ROADMAP.md
├── README.md
├── CONTRIBUTING.md
├── package.json                # pnpm; main = dist/index.js, ./server subpath
├── tsconfig.json
├── tsup.config.ts              # builds dist/index.js + dist/api/server.js + dist/api/main.js
├── biome.json                  # lint + format
├── vitest.config.ts
├── docker-compose.yml          # Postgres + Redis for local dev
├── .env.example
├── db/
│   ├── schema.sql              # single source of truth — destructive `pnpm db:reset`
│   └── reset.ts
├── src/
│   ├── index.ts                # public package surface (MemCore class, types, errors)
│   ├── memcore.ts              # the MemCore SDK class
│   ├── config.ts               # Zod-validated env config
│   ├── errors.ts
│   ├── logging.ts              # pino setup
│   ├── api/
│   │   ├── main.ts             # server entry: builds MemCore + Fastify, listens
│   │   ├── server.ts           # buildServer({ memcore }) — exported under "memcore/server"
│   │   └── routes/
│   │       ├── health.ts       # GET  /v1/health
│   │       ├── add.ts          # POST /v1/add
│   │       ├── search.ts       # POST /v1/search
│   │       └── memories.ts     # CRUD on memories (Phase 2+)
│   ├── ingestion/              # Phase-1 inline pipeline; queue lands in Phase 2
│   │   ├── pipeline.ts
│   │   ├── chunker.ts
│   │   ├── contextualizer.ts   # Phase 3
│   │   ├── extractor.ts        # Phase 2
│   │   ├── conflict-detector.ts # Phase 4
│   │   └── deduplicator.ts
│   ├── retrieval/
│   │   ├── vector-search.ts
│   │   ├── keyword-search.ts   # Phase 3
│   │   ├── rrf.ts              # Phase 3
│   │   ├── reranker.ts         # Phase 3
│   │   ├── temporal-filter.ts  # Phase 5
│   │   └── graph-expander.ts   # Phase 4
│   ├── llm/                    # injectable interfaces + default impls (no SDKs)
│   │   ├── types.ts            # mirrors @agentic/llm shape
│   │   ├── client.ts           # LLMClient interface + TrackedLLMClient
│   │   ├── embedder.ts         # Embedder interface + TrackedEmbedder
│   │   ├── openai-embedder.ts  # default; uses fetch
│   │   ├── stub-embedder.ts    # deterministic, for tests/boot without keys
│   │   ├── cost-tracker.ts
│   │   └── index.ts
│   ├── prompts/                # versioned text files (Phase 2+)
│   │   ├── extraction_v1.txt
│   │   ├── contextualizer_v1.txt
│   │   ├── conflict_detector_v1.txt
│   │   └── temporal_parser_v1.txt
│   ├── connectors/             # external data sources (Phase 7+)
│   │   └── base.ts
│   └── db/
│       ├── pool.ts             # global pool for scripts (the SDK class owns its own)
│       └── vector.ts           # pgvector literal helper
├── evals/
│   ├── runner.ts
│   ├── metrics.ts
│   ├── types.ts
│   └── cases/
│       ├── single_session_recall.jsonl
│       ├── knowledge_update.jsonl    # Phase 4
│       ├── temporal_reasoning.jsonl  # Phase 5
│       ├── multi_session.jsonl       # Phase 4
│       └── abstain.jsonl             # Phase 6
└── scripts/
    ├── smoke.ts                # local end-to-end sanity check
    └── reingest.ts             # re-run extraction with new prompt version (Phase 2+)
```

## Data model

### Tables

#### `containers`
Multi-tenant scope. A container is "user_123", "team_acme", etc.

| Column        | Type        | Notes                          |
| ------------- | ----------- | ------------------------------ |
| id            | UUID PK     |                                |
| tag           | TEXT UNIQUE | The string identifier          |
| created_at    | TIMESTAMPTZ |                                |
| metadata      | JSONB       | Free-form per-container config |

#### `conversations`
Raw archive of conversations.

| Column          | Type        | Notes                                       |
| --------------- | ----------- | ------------------------------------------- |
| id              | UUID PK     |                                             |
| container_id    | UUID FK     | → containers.id                             |
| external_id     | TEXT        | Client-supplied ID for idempotency          |
| started_at      | TIMESTAMPTZ |                                             |
| ended_at        | TIMESTAMPTZ | Null while active                           |
| message_count   | INT         |                                             |
| ingestion_status| TEXT        | `pending` / `processing` / `complete` / `failed` |
| ingested_at     | TIMESTAMPTZ |                                             |
| metadata        | JSONB       |                                             |

UNIQUE (container_id, external_id) for idempotency.

#### `messages`
Individual turns within conversations.

| Column          | Type        | Notes                          |
| --------------- | ----------- | ------------------------------ |
| id              | UUID PK     |                                |
| conversation_id | UUID FK     | → conversations.id             |
| role            | TEXT        | `user` / `assistant` / `system`|
| content         | TEXT        |                                |
| created_at      | TIMESTAMPTZ |                                |
| position        | INT         | Order within conversation      |

#### `chunks`
Semantic chunks of source material.

| Column          | Type        | Notes                                          |
| --------------- | ----------- | ---------------------------------------------- |
| id              | UUID PK     |                                                |
| container_id    | UUID FK     |                                                |
| conversation_id | UUID FK     | Nullable (chunks may come from non-conversation sources) |
| source_type     | TEXT        | `conversation` / `document` / `webpage` / etc. |
| source_id       | TEXT        | External reference                             |
| content         | TEXT        | Raw chunk text                                 |
| contextual_prefix | TEXT      | Generated context summary                      |
| embedding       | VECTOR(3072)| pgvector column                                |
| content_hash    | TEXT        | SHA-256 of content; for dedup                  |
| position        | INT         | Order within source                            |
| document_date   | TIMESTAMPTZ | When the source was authored                   |
| metadata        | JSONB       |                                                |
| created_at      | TIMESTAMPTZ |                                                |

INDEX on (container_id, content_hash) for dedup.
INDEX on tsvector(content) for keyword search (used from Phase 3 onward).
NO vector index in Phase 1: pgvector's ivfflat/HNSW cap at 2000 dimensions and our default model is 3072. The Phase 1 corpus is small enough that sequential cosine scan meets the latency budget. A halfvec-cast HNSW index lands when hybrid search arrives in Phase 3.

#### `memories`
Atomic facts.

| Column          | Type        | Notes                                          |
| --------------- | ----------- | ---------------------------------------------- |
| id              | UUID PK     |                                                |
| container_id    | UUID FK     |                                                |
| content         | TEXT        | Atomic, self-contained statement               |
| embedding       | VECTOR(3072)|                                                |
| category        | TEXT        | `preference` / `fact` / `goal` / `event` / `relationship` / `constraint` / `opinion` |
| document_date   | TIMESTAMPTZ | When the source was authored                   |
| event_date      | TIMESTAMPTZ | When the described event occurred (nullable)   |
| event_date_precision | TEXT   | `day` / `month` / `year` / `unknown`           |
| status          | TEXT        | `active` / `superseded` / `deleted`            |
| version         | INT         | Increments when this memory is updated         |
| confidence      | FLOAT       | 0.0–1.0 from extractor                         |
| prompt_version  | TEXT        | Which extraction prompt produced this          |
| extractor_model | TEXT        | Which LLM produced this                        |
| created_at      | TIMESTAMPTZ |                                                |
| updated_at      | TIMESTAMPTZ |                                                |

INDEX on (container_id, status).
INDEX on embedding.
INDEX on tsvector(content).
INDEX on (container_id, event_date) for temporal queries.

#### `memory_chunks`
Many-to-many link between memories and the chunks they were derived from.

| Column      | Type    | Notes                              |
| ----------- | ------- | ---------------------------------- |
| memory_id   | UUID FK | → memories.id                      |
| chunk_id    | UUID FK | → chunks.id                        |
| relevance   | FLOAT   | How central this chunk is to the memory |

PRIMARY KEY (memory_id, chunk_id).

#### `edges`
Typed relationships between memories.

| Column            | Type        | Notes                                         |
| ----------------- | ----------- | --------------------------------------------- |
| id                | UUID PK     |                                               |
| source_memory_id  | UUID FK     |                                               |
| target_memory_id  | UUID FK     |                                               |
| relationship_type | TEXT        | `updates` / `extends` / `derives` / `contradicts` |
| confidence        | FLOAT       |                                               |
| created_at        | TIMESTAMPTZ |                                               |

INDEX on source_memory_id.
INDEX on target_memory_id.
UNIQUE (source_memory_id, target_memory_id, relationship_type).

## API

All endpoints return JSON. Authentication is `Authorization: Bearer <api_key>`. The API key resolves to a default `container_tag` but every request can override.

Base path: `/v1`

### `POST /v1/add`

Add content to memory. Returns immediately; ingestion is async.

**Request body:**
```json
{
  "container_tag": "user_123",
  "content": "Free text content (for documents, web pages, etc.)",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "source_type": "conversation",
  "external_id": "session_abc123",
  "document_date": "2026-04-28T15:00:00Z",
  "metadata": {}
}
```

Either `content` or `messages` is required. Both is an error.

**Response (202 Accepted):**
```json
{
  "id": "uuid",
  "ingestion_status": "pending"
}
```

### `POST /v1/search`

Search memories.

**Request body:**
```json
{
  "container_tag": "user_123",
  "query": "what does the user prefer for breakfast?",
  "limit": 10,
  "filters": {
    "categories": ["preference", "fact"],
    "date_range": {
      "axis": "event_date",
      "from": "2025-01-01T00:00:00Z",
      "to": "2026-12-31T23:59:59Z"
    },
    "include_superseded": false
  },
  "include_chunks": true,
  "expand_graph": true
}
```

**Response:**
```json
{
  "results": [
    {
      "memory": {
        "id": "uuid",
        "content": "User prefers oatmeal with berries for breakfast",
        "category": "preference",
        "document_date": "2026-03-15T08:30:00Z",
        "event_date": null,
        "version": 2,
        "confidence": 0.92
      },
      "score": 0.847,
      "chunks": [
        {
          "id": "uuid",
          "content": "...raw conversation excerpt...",
          "contextual_prefix": "..."
        }
      ],
      "related_memories": [
        {
          "memory": {"...": "..."},
          "edge_type": "extends"
        }
      ]
    }
  ],
  "query_metadata": {
    "total_candidates": 47,
    "latency_ms": 142
  }
}
```

### `GET /v1/memories/:id`

Fetch a single memory with its source chunks and edges.

### `PATCH /v1/memories/:id`

Update memory metadata (status, etc.). Cannot edit `content` directly — use the conflict detection path.

### `DELETE /v1/memories/:id`

Mark a memory as deleted (soft delete). Set `status = 'deleted'`. Removed from search results but retained for audit.

### `POST /v1/memories`

Manually create a memory. Used for the explicit `save_memory` tool path.

```json
{
  "container_tag": "user_123",
  "content": "User is allergic to peanuts",
  "category": "constraint",
  "source": "user_explicit"
}
```

This bypasses chunking and extraction but still runs through conflict detection.

### `GET /v1/conversations/:id`

Fetch a conversation and its ingestion status.

### `GET /v1/health`

Health check. Returns 200 if the service is up and the database is reachable.

## Ingestion pipeline

Triggered by:
1. `POST /v1/add` for non-conversation content (immediate enqueue)
2. Conversation session boundary detection (see below)

### Session boundary detection

A background job runs every 5 minutes and finds conversations where:
- `ingestion_status = 'pending'` AND
- (`ended_at IS NOT NULL` OR `last_message_at < NOW() - INTERVAL '30 minutes'` OR `message_count >= 20`)

These are enqueued for ingestion. Configurable thresholds via env vars: `SESSION_INACTIVITY_MINUTES`, `SESSION_LENGTH_THRESHOLD`.

### Pipeline stages

For each session:

1. **Load.** Pull all messages, ordered by position.
2. **Semantic chunk.** Split into chunks of 3–8 turns, breaking on topic shifts (cosine drop between consecutive turn embeddings > 0.35) or hard turn-count cap (8).
3. **Contextualize.** For each chunk, generate a 1–2 sentence contextual prefix using the full session as cached context.
4. **Embed chunks.** Generate embeddings for `contextual_prefix + content`.
5. **Extract memories.** For each chunk, call the extraction LLM. Most chunks return `[]`. Output is structured JSON.
6. **Embed memories.** Generate embeddings for memory `content`.
7. **Detect conflicts.** For each new memory, similarity search against existing memories (top-5) within the same `container_id`. Batch through the conflict detector LLM. Output: `new` / `update` / `extend` / `derive` / `duplicate` per memory.
8. **Write.** In a single transaction:
   - Insert chunks
   - Insert memories
   - Insert memory_chunks links
   - Insert edges
   - Update superseded memories' status
   - Mark conversation `ingestion_status = 'complete'`

If any stage fails, the conversation is marked `failed` with the error in metadata. Retry with backoff up to 3 times.

### Idempotency

- Conversations: `(container_id, external_id)` is unique. Re-adding is a no-op.
- Chunks: `(container_id, content_hash)` is unique. Re-extracting from a re-ingested conversation reuses chunks.
- Memories: deduplicated by the conflict detector during ingestion.

### Cost controls

- Use prompt caching for the contextualizer (the full session is the cached prefix).
- Batch memory extraction: process N chunks in one LLM call when possible.
- Batch conflict detection: process N candidate memories in one LLM call.
- Skip contextualization for very short chunks (< 50 tokens) — they don't need it.
- Track per-session cost in conversation metadata for observability.

## Retrieval pipeline

For each `/v1/search` request:

1. **Parse temporal intent** (LLM call, ~50ms with cached prompt). Output: filters on `document_date` vs `event_date` if the query implies a temporal scope.
2. **Embed query.** Single embedding call.
3. **Vector search.** Top 50 by cosine similarity over memories within `container_id`.
4. **Keyword search.** Top 50 by BM25-equivalent over memories within `container_id`.
5. **Fuse with RRF.** `score(d) = Σ 1 / (60 + rank_S(d))`. Take top 30.
6. **Filter.** Apply `category`, `status`, and date filters from the request and the temporal parser.
7. **Rerank.** Cross-encoder over top 30 → top `limit` (default 10).
8. **Expand graph.** For each top result, pull edges and related memories (one hop only).
9. **Join chunks.** Pull source chunks for each memory if `include_chunks: true`.
10. **Return.**

Latency budget:
- Steps 1–2: ~80ms (parallelized)
- Steps 3–4: ~30ms (parallelized)
- Step 5: < 5ms
- Step 7: ~120ms (the dominant cost)
- Steps 8–9: ~20ms
- Total target: < 300ms p95

## Vector index strategy

`chunks.embedding` is stored as pgvector `VECTOR` with no fixed dim, so any embedding model fits without a schema change. ANN indexes have per-op-class dimensionality caps, so the index strategy depends on `EMBEDDING_DIM`. The `pnpm db:vector-index` script picks the right one and drops the prior index.

| `EMBEDDING_DIM` | Index                                                                          | Query operator                                              | Recall vs. exact |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------- |
| ≤ 2000          | `HNSW(embedding vector_cosine_ops)`                                            | `embedding <=> $vec::vector`                                | exact            |
| 2001..4000      | `HNSW((embedding::halfvec(N)) halfvec_cosine_ops)`                             | `embedding::halfvec(N) <=> $vec::halfvec(N)`                | <1pp lower (16-bit floats) |
| > 4000          | `HNSW((binary_quantize(embedding)::bit(N)) bit_hamming_ops)` + exact rerank    | `binary_quantize(embedding)::bit(N) <~> ...` then `embedding <=> ...` on top-200 | depends on rerank N; ~0–3pp |

In practice the bottom row applies only to research-grade embeddings. The current main-line models (`text-embedding-3-large` 3072, `text-embedding-3-small` 1536, Cohere `embed-english-v3.0` 1024, `nomic-embed-text-v1.5` 768) all fit comfortably in the first or second tier.

Phase 1 ships with no ANN index — sequential cosine scan meets the latency budget for the small-corpus baseline. Phase 3 runs `pnpm db:vector-index` as part of the hybrid-search rollout.

## Configuration

All config via environment variables, validated with Zod (`src/config.ts`).

| Variable                      | Default                       | Notes                                  |
| ----------------------------- | ----------------------------- | -------------------------------------- |
| `DATABASE_URL`                | (required)                    | Postgres connection string             |
| `REDIS_URL`                   | (required)                    | For job queue (Phase 2+)               |
| `PORT`                        | `8000`                        | HTTP server port                       |
| `ANTHROPIC_API_KEY`           | (optional)                    | Required if using Anthropic models     |
| `OPENAI_API_KEY`              | (optional)                    | Required if using OpenAI models        |
| `COHERE_API_KEY`              | (optional)                    | For reranker                           |
| `EMBEDDING_BASE_URL`          | (optional)                    | Override the OpenAI-compat endpoint (LMStudio: `http://localhost:1234/v1`, Ollama: `http://localhost:11434/v1`). |
| `EMBEDDING_API_KEY`           | (optional)                    | Overrides `OPENAI_API_KEY` for the embedder. LMStudio accepts any string. |
| `EMBEDDING_MODEL`             | `text-embedding-3-large`      |                                        |
| `EMBEDDING_DIM`               | `3072`                        | Must match model. See § Vector index strategy for ANN limits. |
| `EXTRACTION_MODEL`            | `claude-haiku-4-5`            |                                        |
| `CONFLICT_MODEL`              | `claude-sonnet-4-6`           |                                        |
| `CONTEXTUALIZER_MODEL`        | `claude-haiku-4-5`            |                                        |
| `RERANKER_PROVIDER`           | `cohere`                      | Or `local`                             |
| `SESSION_INACTIVITY_MINUTES`  | `30`                          |                                        |
| `SESSION_LENGTH_THRESHOLD`    | `20`                          |                                        |
| `CHUNK_MIN_TOKENS`            | `100`                         |                                        |
| `CHUNK_MAX_TOKENS`            | `800`                         |                                        |
| `CHUNK_TOPIC_SHIFT_THRESHOLD` | `0.35`                        | Cosine drop                            |
| `RRF_K`                       | `60`                          |                                        |
| `LOG_LEVEL`                   | `info`                        | pino level                             |
| `ENVIRONMENT`                 | `development`                 | `development` / `test` / `production`  |
| `API_KEY_DEV`                 | `dev-key`                     | Bearer token accepted in dev mode      |

## Prompts

All prompts are stored as text files in `src/prompts/`, versioned by filename suffix (`_v1`, `_v2`, etc.). The active version is selected by config:

```ts
export const EXTRACTION_PROMPT_VERSION = "v1";
```

Memories store the version they were extracted with (`prompt_version` column) so we can identify which memories need re-extraction when prompts change.

Prompt files use `{variable}` placeholders, rendered with a small `format` helper (no `eval`, no template literals — keep prompts inert text).

## Errors

Custom exception hierarchy in `src/errors/`:

```
MemCoreError (base)
├── ValidationError       # bad input
├── NotFoundError         # missing resource
├── IngestionError        # pipeline failure
│   ├── ChunkingError
│   ├── ExtractionError
│   └── EmbeddingError
├── RetrievalError
├── LLMError
│   ├── RateLimitError
│   └── ProviderError
└── ConfigError
```

API errors return:
```json
{
  "error": {
    "code": "validation_error",
    "message": "Either 'content' or 'messages' must be provided",
    "details": {}
  }
}
```

HTTP status codes: 400 for validation, 401 for auth, 404 for not found, 429 for rate limits, 500 for internal, 503 for provider failures.

## Eval suite

Located in `evals/`. Cases are JSONL files, one record per line:

```json
{
  "case_id": "ssr_001",
  "category": "single_session_recall",
  "setup": [
    {"role": "user", "content": "I just adopted a golden retriever named Biscuit"}
  ],
  "question": "What's the user's pet's name?",
  "expected_answer": "Biscuit",
  "scoring": "contains"
}
```

Categories mirror LongMemEval:
- `single_session_recall`: facts within one session
- `knowledge_update`: handling contradictions (Phase 4)
- `temporal_reasoning`: when did X happen (Phase 5)
- `multi_session`: facts across sessions (Phase 4)
- `abstain`: refuse to answer when info is missing (Phase 6)

Run with `pnpm eval -- --output report.json`. Report includes per-category accuracy and latency. Cost reporting lands in Phase 2 once we have memory extraction calling the LLM during ingestion.

The runner ingests every case's setup into a single shared container so cases compete at retrieval time. Without that, top-k = "the only chunk you ingested" and accuracy is trivially 100%.

## Versioning

This spec follows semantic versioning. Major version increments on breaking API or schema changes. Minor on additive changes. Patch on doc-only fixes.

**Current version: 0.1.0**

## Changelog

- **0.1.0** (initial): Schema, API, and pipeline defined for Phase 1–2 scope.
