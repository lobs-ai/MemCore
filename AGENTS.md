# AGENTS.md

This file gives AI coding agents (Claude Code, Cursor, etc.) the context they need to work effectively in this repository.

## What this project is

We are building a **memory layer for AI agents** — a system that ingests conversations and documents, extracts atomic facts, stores them in a graph with typed relationships, and serves them back via a search API. Think of it as a from-scratch implementation of Supermemory or Mem0.

The system is **not** a vector database. It is a memory engine that uses a vector database as one of several components. The distinction matters: we store both raw chunks (archive) and atomic memories (semantic index), connected by a typed graph that handles updates, contradictions, and inferences over time.

Read `DESIGN.md` for the architectural reasoning. Read `SPEC.md` for the concrete schemas and APIs. Read `ROADMAP.md` for the phased build plan and what's currently in scope.

## Core concepts you must internalize before writing code

**Chunks vs memories.** A chunk is a piece of raw source material (a section of a conversation, a document fragment). A memory is an atomic fact extracted from one or more chunks, with all references resolved. They are separate tables, linked many-to-many. Most chunks produce zero memories — that is correct behavior, not a bug.

**Memories are durable; chunks are archival.** Search queries hit memories first. The matched memory's source chunks are joined into the response so the LLM sees both the clean fact and the original context. Never collapse this two-layer model into one.

**Edges are typed.** Relationships between memories are not generic "related" links. They are `updates`, `extends`, `derives`, or `contradicts`. The type determines query-time behavior — an `updates` edge means the older memory is superseded, an `extends` edge means both should be returned together.

**Time has two axes.** Every memory has `document_date` (when the source was authored) and `event_date` (when the described event actually happened or will happen). Queries can filter on either. Do not conflate them.

**Session-based ingestion.** Conversations are ingested as whole sessions, not turn-by-turn. The session boundary is what gives the extractor enough context to disambiguate references. Do not add per-turn extraction.

## What this project is NOT

- It is not a chat application. We do not build a UI. We expose an API.
- It is not a generic RAG library. We do not optimize for arbitrary document Q&A. We optimize for long-term agent memory: recall, knowledge update, and temporal reasoning.
- It is not a wrapper around a single LLM provider. The extraction and conflict-detection prompts are first-class components and can run against multiple providers.

## How to work in this repository

### Before making changes

1. **Read the relevant section of `SPEC.md`** for the component you're touching. The schemas and API contracts there are authoritative.
2. **Check `ROADMAP.md`** to confirm the change is in the current phase. Do not implement Phase 4 features while Phase 2 is still incomplete.
3. **Run the eval harness** (`pnpm eval` or `python -m evals.runner`) before and after your change. We track quality, not just correctness.

### When writing code

- **Match the existing structure.** Module layout is in `SPEC.md` § Project Structure. Don't introduce new top-level directories without updating the spec.
- **Type everything.** TypeScript: strict mode, no `any` without a comment explaining why. Python: full type hints, validated by `mypy --strict`.
- **Database changes go through migrations.** Never hand-edit the schema. Create a migration file, test it forwards and backwards.
- **LLM calls are versioned.** Prompts live in `src/prompts/` and are versioned (e.g., `extraction_v3.txt`). When you change a prompt, bump the version and update the schema's `prompt_version` field. Old memories keep their version tag so we can re-extract if needed.
- **Idempotent ingestion.** Re-ingesting the same content must not produce duplicates. Use content hashes as deduplication keys.

### When you don't know something

- Don't guess at schemas — read `SPEC.md`.
- Don't guess at architecture — read `DESIGN.md`.
- Don't guess at what's in scope — read `ROADMAP.md`.
- If a doc disagrees with the code, the doc is wrong; flag it explicitly and ask the user before proceeding.

### Things that will get a PR rejected

- Adding a new top-level dependency without justifying it in the PR description
- LLM calls outside `src/llm/` — all model interaction goes through the LLM client wrapper for retries, logging, and cost tracking
- Changing prompts in place without bumping the version
- Catching exceptions just to log and re-raise — let them propagate or handle them meaningfully
- Synchronous LLM calls in API request handlers — ingestion is always async
- Tests that mock the LLM with hardcoded responses without an integration test alongside
- Skipping the eval suite on changes to extraction, retrieval, or conflict detection

## Code style quick reference

- **Naming**: `snake_case` for Python files and DB columns, `camelCase` for TypeScript variables, `PascalCase` for types and classes. DB tables are plural (`memories`, `chunks`).
- **Comments**: Explain *why*, not *what*. The code shows what. Reserve comments for non-obvious decisions.
- **Errors**: Custom exception classes in `src/errors/`. No raw `raise Exception("...")`.
- **Logging**: Structured logging only. Use the logger in `src/logging/`. Include `request_id`, `container_tag`, and component name on every log.
- **Tests**: Co-located. `foo.py` → `foo_test.py`. Or `foo.ts` → `foo.test.ts`. Don't put tests in a separate `tests/` tree.

## Operational guidance

- **Cost is real.** Every LLM call costs money. Before adding one, ask: can this be batched? Can it use a cheaper model? Is it cached? The ingestion pipeline calls LLMs many times per session — small inefficiencies compound fast.
- **Latency is real.** Search must complete in under 300ms p95. If a change adds a new step to the search path, profile it. If it adds more than 50ms, it needs to be justified or moved to ingestion time.
- **Quality is measured.** We have an eval suite (`evals/`). Changes to extraction, retrieval, conflict detection, or temporal reasoning must run the suite and report deltas in the PR description.

## Common tasks and how to approach them

**"Add a new memory category."** Update the extraction prompt schema in `src/prompts/extraction_vN.txt`, bump the version, update the `Memory` type in `src/models/memory.py`, write a migration if storage changes, run the eval suite. Don't add a category just because it sounds useful — categories should reflect retrieval-time filters that actually exist.

**"Improve retrieval quality."** Don't tweak the retrieval code first. Run the eval suite to find which categories are weak. Add failing test cases. Then experiment. The order matters because retrieval is a search problem and intuition is unreliable here.

**"Add a new connector."** Connectors live in `src/connectors/`. Each implements a common interface (`fetch`, `incremental_sync`, `to_chunks`). Don't add connector-specific logic to the ingestion pipeline — the connector's job ends at producing standardized chunks.

**"Fix a bug in extraction."** First reproduce it as an eval case. Add it to `evals/cases/`. Confirm the eval fails. Then fix. Don't fix and add the eval after — you'll never know if your fix actually addresses the underlying problem or just the specific input.

## When to ask the user vs. proceed

**Proceed without asking when:**
- The task is clearly scoped and the spec has the answer
- You're following an existing pattern in the codebase
- The change is reversible and you can describe what you did clearly

**Ask first when:**
- The task implies a schema change
- The task implies a new dependency
- The spec and the code disagree
- The task crosses a phase boundary in `ROADMAP.md`
- You're about to delete or rewrite more than ~100 lines

## Memory model: a one-paragraph reminder

A user says something. It goes into the conversation log (raw archive). When their session ends, an ingestion job chunks the session semantically, contextualizes each chunk against the session, extracts atomic memories (most chunks produce zero), runs each candidate memory against existing memories to detect conflicts, and writes chunks plus memories plus edges. At query time, hybrid search runs over memories (vector + keyword fused with RRF), the top results are reranked, edges are traversed one hop to pull related memories, source chunks are joined, and the result is filtered by container tag and temporal constraints. The LLM answering the query sees the clean memories *and* their original chunks. That is the whole system.
