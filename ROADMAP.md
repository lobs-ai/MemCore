# ROADMAP.md

This document defines the phased build plan for **MemCore**. Phases are sequential — do not start phase N+1 until phase N's exit criteria are met.

For *what* to build, see `SPEC.md`. For *why*, see `DESIGN.md`. For *how* to work in this repo, see `AGENTS.md`.

**Current phase: Phase 3 in progress** — contextualizer, hybrid search (vector + tsvector + RRF), reranker, and reingest script landed. Vector index is still opt-in via `pnpm db:vector-index`. Eval delta vs Phase 2 pending an `OPENAI_API_KEY` (and a `COHERE_API_KEY` for the cross-encoder; without it the pipeline falls back to a passthrough reranker and only measures the vector+keyword+RRF improvement).

---

## Phase 0: Bootstrap

Set up the project skeleton. No real functionality yet.

**Tasks:**
- Initialize repo, `package.json`, `tsconfig.json`, dev dependencies (pnpm)
- `docker-compose.yml` with Postgres + pgvector + Redis
- Fastify scaffold with `/v1/health` endpoint
- Database connection (`postgres` driver) — single `db/schema.sql`, no migrations
- `LLMClient` and `Embedder` interfaces in `src/llm/`; default OpenAI embedder via fetch
- `pino` structured logger
- Basic CI: `biome` (lint), `tsc --noEmit` (types), `vitest` (tests)
- `.env.example` with all required vars from `SPEC.md`

**Exit criteria:**
- `docker compose up` brings everything up
- `curl localhost:8000/v1/health` returns 200
- `pnpm test` runs (with zero tests is fine)
- CI is green

---

## Phase 1: Naive RAG baseline

The goal is end-to-end working code with the simplest possible implementation. No memories yet — just chunks and vector search. This is the control we'll measure improvements against.

**Tasks:**
- Add `containers`, `conversations`, `messages`, `chunks` to `db/schema.sql` (no `memories`, `edges`, or `memory_chunks` yet)
- `MemCore.add()` and `POST /v1/add`: accepts content or messages, splits into fixed-size chunks (token-based, no semantic logic), embeds, stores
- `MemCore.search()` and `POST /v1/search`: embeds query, returns top-k chunks by cosine similarity
- Basic eval harness in `evals/runner.ts` with 10–20 hand-written test cases
- A single eval category to start: `single_session_recall`

**Out of scope:** memory extraction, contextual prefixes, hybrid search, reranking, conflict detection, edges, temporal reasoning, async ingestion queue.

**Exit criteria:**
- End-to-end: add content via SDK or API, search and retrieve via SDK or API
- Eval suite runs, produces a baseline number
- Document the baseline number in this file (see "Baselines" section below)

---

## Phase 2: Memories layer

Introduce the chunks-vs-memories split. This is where the system stops being RAG and starts being memory.

**Tasks:**
- Add `memories` and `memory_chunks` tables (schema)
- Implement `src/ingestion/extractor.ts`: LLM call that extracts atomic memories from a chunk
- Write `src/prompts/extraction_v1.txt`
- Update ingestion pipeline: chunk → embed chunk → extract memories → embed memories → store both
- Update `MemCore.search()` / `POST /v1/search`: search runs against memories, joins source chunks in response
- Add `include_chunks` parameter
- Move ingestion behind a Redis/BullMQ queue (sessions become the unit; see DESIGN § 4)
- Eval suite: same cases run against the new path. Measure delta.

**Out of scope:** contextual prefixes, conflict detection, edges, hybrid search.

**Exit criteria:**
- Eval suite shows non-trivial improvement vs Phase 1 baseline (target: +10 points overall)
- Source chunks appear correctly in search responses
- Most chunks produce 0 memories (sanity check; if every chunk produces memories, the extraction prompt is too aggressive)

---

## Phase 3: Contextual retrieval + hybrid search

Improve retrieval quality with two well-known techniques.

**Tasks:**
- Implement `src/ingestion/contextualizer.ts`: generates a contextual prefix per chunk using the full session as context
- Use prompt caching (Anthropic native, or OpenAI prompt caching) to control cost
- `contextual_prefix` column already exists in `chunks` — populate it
- Re-embed chunks using `contextual_prefix + content`
- Run `pnpm db:vector-index` (`scripts/create-vector-index.ts`) to build the right HNSW index for the configured `EMBEDDING_DIM` (vector / halfvec / bit + rerank — see SPEC § Vector index strategy)
- Implement `src/retrieval/keyword-search.ts` using Postgres `tsvector`
- Implement `src/retrieval/rrf.ts` for reciprocal rank fusion
- Add reranker integration (`src/retrieval/reranker.ts`)
- Update search pipeline to: vector → keyword → RRF → rerank
- Add `scripts/reingest.ts` to regenerate prefixes for existing chunks

**Exit criteria:**
- Eval suite shows further improvement (target: +5 points overall)
- p95 search latency still under 300ms
- Cost per ingestion is documented and acceptable

---

## Phase 4: Graph and conflict detection

Add the typed edge graph. This is the largest phase — handle it carefully.

**Tasks:**
- Add `edges` table (schema)
- Implement `src/ingestion/conflict-detector.ts`: classifies new memories as `new` / `update` / `extend` / `derive` / `duplicate`
- Write `src/prompts/conflict_detector_v1.txt`
- Update ingestion pipeline: after memory extraction, run conflict detection, write edges, update superseded memories' status
- Implement `src/retrieval/graph-expander.ts`: one-hop edge traversal at query time
- Add `expand_graph` query parameter to search
- Add knowledge_update and multi_session eval categories with deliberately contradictory test data
- Document the dedup heuristics and tune the similarity threshold for conflict detection

**Exit criteria:**
- Knowledge-update eval category shows >75% accuracy
- Multi-session eval category shows >65% accuracy
- Manual test: ingest "I love TypeScript", then "I prefer Rust now" — search for "language preference" returns Rust as active and TypeScript as superseded

---

## Phase 5: Temporal grounding

Two-axis time. Distinguishes "when said" from "when happened."

**Tasks:**
- Add `event_date` and `event_date_precision` columns to `memories` (schema)
- Update extraction prompt to extract `event_date` separately
- Implement `src/retrieval/temporal-filter.ts`
- Implement temporal query parsing (`src/prompts/temporal_parser_v1.txt` + `src/retrieval/`)
- Add `date_range` filter to search API
- Add temporal_reasoning eval category

**Exit criteria:**
- Temporal-reasoning eval category shows >70% accuracy
- Manual test: "I'm flying to Tokyo next month" creates a memory with `event_date` ~30 days in the future, not today

---

## Phase 6: User profiles and abstaining

Higher-level abstractions over the memory graph.

**Tasks:**
- Background job that periodically generates a "profile" per container — a stable summary of the user's durable traits
- Inject profile into search results when query is profile-relevant ("what do you know about me?")
- Add `abstain` eval category and ensure the search path can return "no relevant memories" cleanly
- Improve query parser to detect when a question is unanswerable from memory

**Exit criteria:**
- Profile generation works end-to-end
- Abstain eval category shows >80% accuracy (false-positive-free abstaining is more important than false-negative)

---

## Phase 7: Connectors

External data sources beyond the API.

**Tasks:**
- Define connector interface in `src/connectors/base.ts`
- Implement first three connectors: Google Drive, Slack, Notion
- Each connector: OAuth flow, fetch, incremental sync, conversion to chunks
- Connector job scheduler

**Exit criteria:**
- Each connector can do a full initial sync and an incremental update
- Sync errors are surfaced and retryable
- A user can connect Google Drive and search content from a doc within 5 minutes

---

## Phase 8: Production hardening

Get it to "deployable."

**Tasks:**
- Introduce a real migration tool (likely `node-pg-migrate` or hand-rolled SQL versions). Freeze `db/schema.sql` as the v1 baseline; from this point forward, `pnpm db:reset` is dev-only and prod gets migrations.
- Multi-tenant security review: enforce `container_id` at every query path
- Postgres row-level security
- Rate limiting per API key
- Per-container usage tracking and quotas
- Soft deletes and right-to-be-forgotten flow
- SOC 2 / GDPR documentation
- Observability: per-stage tracing, latency histograms, cost dashboards
- Load testing
- Self-host deployment guide

**Exit criteria:**
- Documented in a separate `OPERATIONS.md`
- Pen test or security review completed

---

## Baselines

This section is updated as phases complete. Track quality over time.

| Phase | Date | Eval overall | Single-session-recall | Knowledge-update | Temporal | Multi-session | Notes |
| ----- | ---- | ------------ | --------------------- | ---------------- | -------- | ------------- | ----- |
| 1 (stub embedder) | 2026-04-29 | 13.3% | 13.3% (2/15) | n/a | n/a | n/a | Naive RAG; `StubEmbedder` for plumbing only — number is noise (random baseline). |
| 1 (OpenAI emb.)   | TBD        | —     | —             | n/a | n/a | n/a | Re-run with `OPENAI_API_KEY` set to lock in the real Phase 1 baseline. |
| 2 (stub, no LLM)  | 2026-04-29 | 0%    | 0% (0/15)     | n/a | n/a | n/a | Plumbing run only. No `OPENAI_API_KEY` → no extraction → memories table empty → search returns nothing. Confirms the Phase 2 search path is wired correctly (memory-first, no fallback to chunks). |
| 2 (real LLM)      | TBD        | —     | —             | n/a | n/a | n/a | Re-run with `OPENAI_API_KEY` and `EXTRACTION_MODEL=gpt-4o-mini` (or inject an Anthropic `LLMClient` for `claude-haiku-4-5`). Target ≥+10 points over Phase 1. |
| 3     | TBD  | —            | —                     | n/a              | n/a      | n/a           | + contextual + hybrid + rerank |
| 4     | TBD  | —            | —                     | —                | n/a      | —             | + graph + conflict detection |
| 5     | TBD  | —            | —                     | —                | —        | —             | + temporal |

---

## Decision log

When a non-obvious decision is made during implementation, record it here with the date and reasoning.

- **2026-04-29**: Switched the implementation language from Python to TypeScript and reshaped the project as both an installable package (`MemCore` SDK class) and a Fastify server. Reason: the user's existing `@agentic/llm` client is TS, and shipping a class lets them embed memory in-process without an HTTP hop.
- **2026-04-29**: Dropped Alembic / migrations during pre-production phases. `db/schema.sql` is the single source of truth; `pnpm db:reset` is destructive. Reason: schema churn is expected through Phase 7 and a migration history would be cargo-cult noise. A real migration tool lands in Phase 8.
- **2026-04-29**: No vector index in Phase 1. pgvector's ivfflat/HNSW cap at 2000 dimensions and our default `text-embedding-3-large` is 3072. Sequential cosine scan meets the latency budget at Phase 1 corpus sizes. A halfvec-cast HNSW index lands in Phase 3 alongside hybrid search.
- **2026-04-29**: `chunks.embedding` is unbounded `VECTOR` (no fixed dim). Index choice is deferred to a separate `pnpm db:vector-index` script that picks vector / halfvec / binary-quantize+rerank by `EMBEDDING_DIM`. Reason: we want to support models past 2000 (and even past 4000) dims without a schema change, and pgvector's per-op-class limits leave no single index that covers everything.
- **2026-04-29**: Default embedder is OpenAI-shaped but provider-agnostic — pointed at any `/v1/embeddings` server via `EMBEDDING_BASE_URL`. LMStudio, Ollama, vLLM, llama.cpp all work without code. Non-OpenAI-shaped providers (Cohere, Voyage) implement `Embedder` directly and get passed via `embedder:`.
