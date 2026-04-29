-- MemCore schema (single source of truth).
--
-- This file is destructive: db:reset drops every table and recreates it.
-- We do not run migrations during pre-production phases — schema churn is
-- expected and a migration history would be cargo-culted noise. Once the
-- system is being deployed with real data behind it (Phase 8), we'll
-- introduce a migration tool against a frozen baseline.
--
-- Phase 1 tables:
--   containers      multi-tenant scope
--   conversations   raw archive
--   messages        individual turns
--   chunks          chunked source material with embeddings
--
-- Phase 2 tables (added):
--   memories        atomic facts extracted from chunks
--   memory_chunks   many-to-many link memory ↔ source chunks
--
-- Phase 4 tables (added):
--   edges           typed memory→memory relationships (updates / extends /
--                   derives / contradicts), built by the conflict detector
--                   during ingestion and traversed one-hop at query time.
--
-- Phase 6 tables (added):
--   profiles        per-container summary of the user's durable traits, built
--                   from the active memories. One row per container; rebuilt
--                   on demand (or on a schedule) and injected into search
--                   responses for profile-relevant queries.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS edges CASCADE;
DROP TABLE IF EXISTS memory_chunks CASCADE;
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS chunks CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS containers CASCADE;

CREATE TABLE containers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag         TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_containers_tag ON containers(tag);

CREATE TABLE conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id      UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  external_id       TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  message_count     INTEGER NOT NULL DEFAULT 0,
  ingestion_status  TEXT NOT NULL DEFAULT 'pending',
  ingested_at       TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT uq_conversations_container_external UNIQUE (container_id, external_id)
);
CREATE INDEX ix_conversations_container_id ON conversations(container_id);
CREATE INDEX ix_conversations_ingestion_status ON conversations(ingestion_status);

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  position         INTEGER NOT NULL
);
CREATE INDEX ix_messages_conversation_id ON messages(conversation_id);

-- chunks.embedding is `VECTOR` (no fixed dim) so we can switch embedding
-- models without a schema change. Phase 1 has no ANN index — sequential
-- cosine scan is fine for small corpora and dodges pgvector's per-op-class
-- dimensionality caps. When you need an index, run `pnpm db:vector-index`
-- (`scripts/create-vector-index.ts`) which picks the right strategy from
-- `EMBEDDING_DIM`:
--
--   ≤ 2000       HNSW over (embedding::vector(N) vector_cosine_ops)
--   2001..4000   HNSW over (embedding::halfvec(N) halfvec_cosine_ops)
--   > 4000       HNSW over (binary_quantize(embedding)::bit(N) bit_hamming_ops)
--                  + exact-cosine rerank stage
--
-- See scripts/create-vector-index.ts for the full table of caps and the
-- queries each tier requires.
CREATE TABLE chunks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id       UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  conversation_id    UUID REFERENCES conversations(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL,
  source_id          TEXT,
  content            TEXT NOT NULL,
  contextual_prefix  TEXT,
  embedding          VECTOR,
  content_hash       VARCHAR(64) NOT NULL,
  position           INTEGER NOT NULL,
  document_date      TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_chunks_container_hash UNIQUE (container_id, content_hash)
);
CREATE INDEX ix_chunks_container_id ON chunks(container_id);
CREATE INDEX ix_chunks_conversation_id ON chunks(conversation_id);
CREATE INDEX ix_chunks_content_tsv ON chunks USING GIN (to_tsvector('english', content));

-- memories: atomic, self-contained facts extracted from chunks. Search hits
-- this table; raw chunks are joined back in for context. Like chunks, the
-- embedding column is unbounded VECTOR — index strategy is deferred to
-- pnpm db:vector-index (lands with hybrid search in Phase 3).
--
-- event_date and event_date_precision are populated starting in Phase 5
-- (temporal grounding). Schema includes them now to avoid a re-reset later.
CREATE TABLE memories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id          UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  content               TEXT NOT NULL,
  embedding             VECTOR,
  category              TEXT NOT NULL,
  document_date         TIMESTAMPTZ,
  event_date            TIMESTAMPTZ,
  event_date_precision  TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  version               INTEGER NOT NULL DEFAULT 1,
  confidence            REAL NOT NULL DEFAULT 1.0,
  prompt_version        TEXT NOT NULL,
  extractor_model       TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_memories_container_status ON memories(container_id, status);
CREATE INDEX ix_memories_content_tsv ON memories USING GIN (to_tsvector('english', content));
CREATE INDEX ix_memories_container_event_date ON memories(container_id, event_date);

CREATE TABLE memory_chunks (
  memory_id   UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  chunk_id    UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  relevance   REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (memory_id, chunk_id)
);
CREATE INDEX ix_memory_chunks_chunk_id ON memory_chunks(chunk_id);

-- edges: typed memory→memory relationships built by the conflict detector
-- during ingestion (Phase 4). Traversed one-hop at query time when the search
-- request sets `expand_graph: true`.
--
-- relationship_type values:
--   updates       — source supersedes target; target.status flips to 'superseded'
--   extends       — source refines target without contradiction; both stay active
--   derives       — source is a second-order conclusion drawn from target(s)
--   contradicts   — both stay active but disagree; surfaced for higher-level logic
CREATE TABLE edges (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id   UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id   UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relationship_type  TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 1.0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_edges_source_target_type UNIQUE (source_memory_id, target_memory_id, relationship_type)
);
CREATE INDEX ix_edges_source_memory_id ON edges(source_memory_id);
CREATE INDEX ix_edges_target_memory_id ON edges(target_memory_id);

-- profiles: a stable summary of the user's durable traits, generated from the
-- active memories in a container. One row per container (ON CONFLICT upserts).
-- Built on demand via MemCore.buildProfile() and injected into search results
-- when the query is profile-relevant ("what do you know about me?", etc.).
--
-- source_memory_ids records which memory ids fed the generation so the caller
-- can attribute (and detect when the underlying memories have shifted enough
-- to warrant a rebuild). version increments on every regeneration.
CREATE TABLE profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id        UUID NOT NULL UNIQUE REFERENCES containers(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  source_memory_ids   UUID[] NOT NULL DEFAULT '{}',
  source_memory_count INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  prompt_version      TEXT NOT NULL,
  generator_model     TEXT NOT NULL,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_profiles_container_id ON profiles(container_id);
