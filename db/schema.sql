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
-- Phase 2 will add memories, memory_chunks, edges. They go in this same file.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
