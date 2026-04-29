# DESIGN.md

This document explains the *why* behind **MemCore**. For *what* (schemas, APIs, file layout), see `SPEC.md`. For *when* (build order), see `ROADMAP.md`.

## The problem we are solving

Large language models are stateless. Each conversation begins from scratch. Stuffing prior conversations into the context window is not a real solution: context windows are finite, expensive, and suffer from "lost in the middle" recall failures (Liu et al., 2024). An agent that needs to know its user across weeks or months requires an external memory system.

The naive solution — store every conversation in a vector database and retrieve by similarity — fails in three specific ways that matter:

1. **Ambiguity at retrieval time.** Raw conversation chunks contain pronouns, deictic references ("the project," "next week," "she said"), and conversational filler. A chunk pulled out of context is hard for the LLM to interpret correctly.
2. **No notion of update.** If the user said "I live in Boston" in March and "I just moved to Brooklyn" in November, both chunks match the query "where does the user live?" The system has no way to know one supersedes the other.
3. **No temporal reasoning.** "When was my surgery?" and "When did we discuss my surgery?" are different questions. Vector similarity collapses them. So does most metadata-based filtering.

This system addresses each of these directly. The architecture is not novel in any single component — it borrows from contextual retrieval, knowledge graphs, hybrid search, and temporal databases — but the integration is the contribution.

## Architectural principles

### 1. Two layers, not one

We store two distinct things:

- **Chunks**: raw source material, kept as-is. The archive.
- **Memories**: atomic facts derived from chunks, with all references resolved. The semantic index.

A naive RAG system stores only chunks. A naive summarization-based memory system stores only memories. We store both because they serve different purposes:

- Search runs against memories (high signal, low noise → better precision).
- Answers cite the memory's source chunks (preserves nuance, exact phrasing, surrounding detail).

The trade-off cost is storage (we keep both) and ingestion compute (we generate memories from chunks). Both are acceptable: storage is cheap, and ingestion is asynchronous and one-time per piece of content.

The trade-off benefit is that we never face the dilemma of "lossy summary vs. noisy raw text." We get the precision of one and the fidelity of the other.

### 2. Memory is a graph, not a list

A flat list of memories cannot express that one fact updates another, or that two facts together imply a third. We model memories as nodes and their semantic relationships as typed edges:

- `updates`: state mutation. The target memory is now superseded. Used for corrections and changes ("I changed jobs," "my favorite color is now green").
- `extends`: refinement. The target memory is supplemented with new detail without contradiction ("she got promoted to senior engineer" extends "she works at Acme as an engineer").
- `derives`: inference. The source memory is a second-order conclusion drawn from combining other memories.
- `contradicts`: unresolved conflict. Two memories disagree and the system was unable to determine which is correct. Surfaced to the user or higher-level logic.

The graph is sparse — most memories have zero or one edges. The graph is queried at retrieval time as a one-hop expansion: when a memory matches, its directly-connected memories are also pulled. We deliberately do not implement multi-hop graph traversal. It's expensive at query time and the quality benefit is marginal in our use case.

### 3. Time has two axes

Every memory carries two timestamps:

- `document_date`: when the source was authored (the email was sent, the conversation happened).
- `event_date`: when the event being described actually occurred (which may be in the past, present, or future relative to the document_date).

These are independent. "Yesterday I had surgery" said today has document_date = today and event_date = yesterday. "I'm flying to Tokyo next month" has document_date = today and event_date = next month.

This matters because temporal queries split into two categories. "What did I work on last summer?" is a question about events. "What did we discuss last summer?" is a question about documents. Without two axes, we cannot disambiguate.

### 4. Ingestion is asynchronous and session-scoped

Ingestion is expensive (multiple LLM calls per session) and quality-sensitive (mistakes compound). It does not happen in the request path. It happens in a background queue, triggered by session boundaries.

A session boundary is one of:
- Explicit close (user closed the chat)
- Inactivity timeout (default: 30 minutes)
- Length threshold (default: 20 turns)

The session, not the turn, is the unit of ingestion. This is deliberate. Per-turn extraction has two failure modes:
- **Insufficient context.** A turn referencing "she" cannot resolve the reference without seeing prior turns.
- **Premature commitment.** A user might state something in turn 3 that gets walked back in turn 8. Per-turn extraction would store the wrong fact.

Session-level ingestion sees the whole arc of the conversation and produces better extractions.

### 5. The agent does not decide what to remember

We considered a tool-call architecture where the agent calls `save_memory(content)` during conversation. We rejected it as the primary mechanism for three reasons:

- The agent is biased toward in-the-moment relevance and consistently misses things that matter later.
- Forcing the agent to reason about memorability degrades response quality.
- It is lossy: anything the agent doesn't think to save is gone.

Instead, the full conversation is archived, and a dedicated extraction prompt — focused on the single task of identifying durable facts — runs over it during ingestion. The extraction LLM is unconstrained by the need to also be helpful in real-time. It can be prompted aggressively to filter, and it sees the whole session.

The tool-call channel still exists, but as a complement: explicit user requests like "remember that I'm allergic to peanuts" go through `save_memory`, and explicit forgets go through `forget`. These are user-driven, not agent-driven.

### 6. Hybrid search beats either component alone

Pure vector search is good at semantic similarity but bad at exact-term matches (proper nouns, identifiers, rare terms). Pure keyword search is the inverse. We run both in parallel and fuse the results with Reciprocal Rank Fusion (RRF):

```
score(d) = Σ over each search S: 1 / (k + rank_S(d))
```

with k = 60 by convention. This is robust, parameter-light, and consistently outperforms either component alone in our evals.

We rerank the top results with a cross-encoder before returning. The reranker is the most expensive single step in the search path but provides the largest quality lift. It sits at the top of the funnel because cross-encoders are too slow to run over a full index.

### 7. Quality is measured, not assumed

Memory is a search problem, and search quality intuition is unreliable. We maintain an eval suite (`evals/`) modeled on LongMemEval, with categories spanning recall, knowledge update, multi-session reasoning, temporal reasoning, and abstaining. Every change to extraction, retrieval, or conflict detection runs the suite and reports deltas.

The eval suite is a first-class part of the codebase. It is not optional or aspirational. It is how we know whether the system is getting better or worse.

## What we deliberately do not do

**We do not build a chat UI.** This is a backend system with an API. Chat lives elsewhere.

**We do not train custom models.** All LLM calls go to API providers. We can swap providers at the LLM client layer. The differentiator is the architecture and prompts, not weights.

**We do not implement multi-hop graph reasoning.** One-hop edge expansion is the limit. Multi-hop traversal in production memory systems is expensive, error-prone, and rarely beats letting the LLM reason over a one-hop neighborhood.

**We do not use a graph database.** We use Postgres. Edges are a relational table. The graph is small enough that we don't need a graph-native engine, and Postgres lets us keep memories, chunks, embeddings, and edges in one transactional store. Migrating to a dedicated graph database is a Phase 6+ concern, not a foundational decision.

**We do not auto-summarize on demand.** Memories are extracted at ingestion time, not query time. Query-time summarization is a different system (a chat agent with retrieval) and not what we are building.

**We do not store opinions about the user from the assistant's side.** Only what the user said about themselves, or what they explicitly confirmed. The assistant's hypotheses are not facts.

**We do not implement turn-level streaming ingestion.** See § 4. Sessions are the unit.

## Architecture diagram

```
                          ┌──────────────────────────────────┐
                          │       Client Application         │
                          │     (chat app, agent, etc.)      │
                          └────────────────┬─────────────────┘
                                           │
                ┌──────────────────────────┴──────────────────────────┐
                │                                                     │
                ▼                                                     ▼
        ┌───────────────┐                                    ┌────────────────┐
        │   /add API    │                                    │  /search API   │
        │  (writes raw  │                                    │  (queries the  │
        │   conversation│                                    │   memory graph)│
        │   to archive) │                                    │                │
        └───────┬───────┘                                    └───────┬────────┘
                │                                                    │
                │ writes to                                           │
                ▼                                                     ▼
        ┌───────────────┐                                    ┌────────────────┐
        │  conversations│                                    │ Hybrid search  │
        │     table     │                                    │ (vector + BM25 │
        └───────┬───────┘                                    │  → RRF → re-   │
                │                                            │   ranker)      │
                │ session boundary trigger                   └───────┬────────┘
                ▼                                                    │
        ┌───────────────┐                                            │
        │  Ingestion    │                                            │
        │   queue       │                                            │
        └───────┬───────┘                                            │
                │                                                    │
                ▼                                                    │
        ┌────────────────────────────────────┐                       │
        │     Ingestion pipeline (async)     │                       │
        │  1. Semantic chunking              │                       │
        │  2. Contextual prefix generation   │                       │
        │  3. Memory extraction (LLM)        │                       │
        │  4. Embedding (chunks + memories)  │                       │
        │  5. Conflict detection (LLM)       │                       │
        │  6. Edge construction              │                       │
        └────────────────┬───────────────────┘                       │
                         │                                           │
                         ▼                                           │
        ┌────────────────────────────────────┐                       │
        │            Postgres                │ ◄─────────────────────┘
        │   chunks · memories · edges        │
        │   embeddings (pgvector)            │
        │   tsvector indexes (BM25-ish)      │
        └────────────────────────────────────┘
```

## Performance targets

| Metric                    | Target           | Rationale                                     |
| ------------------------- | ---------------- | --------------------------------------------- |
| Search latency (p95)      | < 300ms          | Acceptable for inline use in a chat agent     |
| Ingestion latency (p50)   | < 30s per session| Asynchronous, but should not lag user signals |
| Ingestion cost (per session) | < $0.05 typical | At scale, ingestion cost dominates; controllable via model selection |
| LongMemEval-style overall | > 75% with GPT-4o-class | A meaningful threshold for "actually useful" |

These are targets, not guarantees. They drive design trade-offs.

## Open questions and known limitations

**Memory deduplication is heuristic.** The conflict detector relies on an LLM judgment that two memories refer to the same fact. This is correct most of the time but not always. We accept some duplicate memories as the cost of avoiding false merges (which destroy information).

**The contextual prefix is generated per chunk.** This is expensive at ingestion time. Prompt caching (Anthropic's prompt caching, OpenAI's caching) reduces the cost substantially but doesn't eliminate it. For very long documents, prefix generation is the dominant ingestion cost.

**We do not model uncertainty in memories.** A memory either exists or doesn't. Confidence scores are stored but unused at retrieval time. A future version may weight retrieval by confidence.

**Multi-tenant isolation is by `container_tag`.** This is enforced in application code, not at the database level. A bug in a query could cross tenants. This is acceptable for now but should be hardened (e.g., row-level security in Postgres) before any production multi-tenant deployment.

**The graph is acyclic by convention, not by enforcement.** We do not validate that an `updates` chain never loops. In practice, monotonic time prevents loops; in theory, a bug could create one.
