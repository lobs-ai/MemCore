# ROADMAP.md

This document defines the phased build plan for **MemCore**. Phases are sequential — do not start phase N+1 until phase N's exit criteria are met.

For *what* to build, see `SPEC.md`. For *why*, see `DESIGN.md`. For *how* to work in this repo, see `AGENTS.md`.

**Current phase: Phase 1** (Phase 0 complete)

---

## Phase 0: Bootstrap

Set up the project skeleton. No real functionality yet.

**Tasks:**
- Initialize repo, `pyproject.toml`, dev dependencies
- `docker-compose.yml` with Postgres + pgvector + Redis
- FastAPI scaffold with `/v1/health` endpoint
- Database connection, Alembic config, initial empty migration
- LLM client wrapper (`src/llm/client.py`) with Anthropic and OpenAI providers, retry logic, cost tracking
- Embedding client wrapper
- Structured logger
- Basic CI: lint (ruff), type check (mypy), test (pytest)
- `.env.example` with all required vars from `SPEC.md`

**Exit criteria:**
- `docker-compose up` brings everything up
- `curl localhost:8000/v1/health` returns 200
- `pytest` runs (with zero tests is fine)
- CI is green

---

## Phase 1: Naive RAG baseline

The goal is end-to-end working code with the simplest possible implementation. No memories yet — just chunks and vector search. This is the control we'll measure improvements against.

**Tasks:**
- Implement schemas for `containers`, `conversations`, `messages`, `chunks` (no `memories`, `edges`, or `memory_chunks` yet)
- `POST /v1/add`: accepts content or messages, splits into fixed-size chunks (token-based, no semantic logic), embeds, stores
- `POST /v1/search`: embeds query, returns top-k chunks by cosine similarity
- Basic eval harness in `evals/runner.py` with 10–20 hand-written test cases
- A single eval category to start: `single_session_recall`

**Out of scope:** memory extraction, contextual prefixes, hybrid search, reranking, conflict detection, edges, temporal reasoning.

**Exit criteria:**
- End-to-end: add content via API, search and retrieve via API
- Eval suite runs, produces a baseline number
- Document the baseline number in this file (see "Baselines" section below)

---

## Phase 2: Memories layer

Introduce the chunks-vs-memories split. This is where the system stops being RAG and starts being memory.

**Tasks:**
- Add `memories` and `memory_chunks` tables (migration)
- Implement `src/ingestion/extractor.py`: LLM call that extracts atomic memories from a chunk
- Write `src/prompts/extraction_v1.txt`
- Update ingestion pipeline: chunk → embed chunk → extract memories → embed memories → store both
- Update `POST /v1/search`: search runs against memories, joins source chunks in response
- Add `include_chunks` query parameter
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
- Implement `src/ingestion/contextualizer.py`: generates a contextual prefix per chunk using the full session as context
- Use prompt caching (Anthropic native, or OpenAI prompt caching) to control cost
- Add `contextual_prefix` column to `chunks`
- Re-embed chunks using `contextual_prefix + content`
- Implement `src/retrieval/keyword_search.py` using Postgres `tsvector`
- Implement `src/retrieval/rrf.py` for reciprocal rank fusion
- Add reranker integration (`src/retrieval/reranker.py`)
- Update search pipeline to: vector → keyword → RRF → rerank
- Add migration script (`scripts/reingest.py`) to regenerate prefixes for existing chunks

**Exit criteria:**
- Eval suite shows further improvement (target: +5 points overall)
- p95 search latency still under 300ms
- Cost per ingestion is documented and acceptable

---

## Phase 4: Graph and conflict detection

Add the typed edge graph. This is the largest phase — handle it carefully.

**Tasks:**
- Add `edges` table (migration)
- Implement `src/ingestion/conflict_detector.py`: classifies new memories as `new` / `update` / `extend` / `derive` / `duplicate`
- Write `src/prompts/conflict_detector_v1.txt`
- Update ingestion pipeline: after memory extraction, run conflict detection, write edges, update superseded memories' status
- Implement `src/retrieval/graph_expander.py`: one-hop edge traversal at query time
- Add `expand_graph` query parameter to search
- Add knowledge_update and multi_session eval categories with deliberately contradictory test data
- Document the dedup heuristics and tune the similarity threshold for conflict detection

**Exit criteria:**
- Knowledge-update eval category shows >75% accuracy
- Multi-session eval category shows >65% accuracy
- Manual test: ingest "I love Python", then "I prefer Rust now" — search for "language preference" returns Rust as active and Python as superseded

---

## Phase 5: Temporal grounding

Two-axis time. Distinguishes "when said" from "when happened."

**Tasks:**
- Add `event_date` and `event_date_precision` columns to `memories` (migration)
- Update extraction prompt to extract `event_date` separately
- Implement `src/retrieval/temporal_filter.py`
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
- Define connector interface in `src/connectors/base.py`
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
| 1     | TBD  | —            | —                     | n/a              | n/a      | n/a           | Naive RAG |
| 2     | TBD  | —            | —                     | n/a              | n/a      | n/a           | + memories layer |
| 3     | TBD  | —            | —                     | n/a              | n/a      | n/a           | + contextual + hybrid + rerank |
| 4     | TBD  | —            | —                     | —                | n/a      | —             | + graph + conflict detection |
| 5     | TBD  | —            | —                     | —                | —        | —             | + temporal |

---

## Decision log

When a non-obvious decision is made during implementation, record it here with the date and reasoning.

- (none yet)
