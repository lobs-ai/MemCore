/**
 * Cosine vector search over memories, with optional source-chunk join.
 *
 * Phase 2: search runs against `memories` (status='active'). Source chunks
 * are joined back in via `memory_chunks` when the caller asks for them. This
 * is the two-layer model from DESIGN.md — atomic facts for matching, raw
 * chunks for context.
 *
 * Phase 3: this module is the "vector leg" of hybrid retrieval. The pipeline
 * runs vector and keyword searches in parallel, fuses the rankings via RRF,
 * reranks the top fused candidates, and only then joins source chunks. The
 * `joinChunksForMemories` helper handles that last step.
 */

import type postgres from "postgres";
import { vectorLiteral } from "../db/vector.js";

export interface MemoryHit {
  id: string;
  content: string;
  category: string;
  status: string;
  version: number;
  confidence: number;
  documentDate: Date | null;
  eventDate: Date | null;
  eventDatePrecision: string | null;
  promptVersion: string;
  extractorModel: string;
  metadata: Record<string, unknown>;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  score: number;
  chunks: ChunkRef[];
}

export interface ChunkRef {
  id: string;
  content: string;
  contextualPrefix: string | null;
  position: number;
  conversationId: string | null;
  sourceType: string;
  sourceId: string | null;
  documentDate: Date | null;
  relevance: number;
}

export interface MemorySearchFilters {
  /** Status whitelist. Default `["active"]`. Pass `[]` to disable. */
  statuses?: string[];
  categories?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemorySearchArgs {
  containerId: string;
  queryVector: number[];
  limit: number;
  includeChunks: boolean;
  filters?: MemorySearchFilters;
}

interface MemorySearchRow {
  id: string;
  content: string;
  category: string;
  status: string;
  version: number;
  confidence: number;
  document_date: Date | null;
  event_date: Date | null;
  event_date_precision: string | null;
  prompt_version: string;
  extractor_model: string;
  metadata: Record<string, unknown> | null;
  use_count: number;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
  distance: number;
}

interface ChunkJoinRow {
  memory_id: string;
  chunk_id: string;
  relevance: number;
  content: string;
  contextual_prefix: string | null;
  position: number;
  conversation_id: string | null;
  source_type: string;
  source_id: string | null;
  document_date: Date | null;
}

export async function vectorSearchMemories(
  sql: postgres.Sql,
  args: MemorySearchArgs,
): Promise<MemoryHit[]> {
  const queryLiteral = vectorLiteral(args.queryVector);
  const statuses = args.filters?.statuses ?? ["active"];
  const categories = args.filters?.categories;
  const metadata = args.filters?.metadata;

  const statusClause = statuses.length > 0 ? sql`AND status IN ${sql(statuses)}` : sql``;
  const categoryClause =
    categories && categories.length > 0 ? sql`AND category IN ${sql(categories)}` : sql``;
  const metadataClause = metadata ? sql`AND metadata @> ${sql.json(metadata as never)}` : sql``;

  const rows = await sql<MemorySearchRow[]>`
    SELECT
      id, content, category, status, version, confidence,
      document_date, event_date, event_date_precision,
      prompt_version, extractor_model, metadata,
      use_count, last_used_at, created_at, updated_at,
      embedding <=> ${queryLiteral}::vector AS distance
    FROM memories
    WHERE container_id = ${args.containerId}
      ${statusClause}
      ${categoryClause}
      ${metadataClause}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${queryLiteral}::vector ASC
    LIMIT ${args.limit}
  `;

  if (rows.length === 0) return [];

  const memoryIds = rows.map((r) => r.id);
  const chunkMap = new Map<string, ChunkRef[]>();
  if (args.includeChunks) {
    const joinRows = await sql<ChunkJoinRow[]>`
      SELECT
        mc.memory_id, mc.chunk_id, mc.relevance,
        c.content, c.contextual_prefix, c.position, c.conversation_id,
        c.source_type, c.source_id, c.document_date
      FROM memory_chunks mc
      JOIN chunks c ON c.id = mc.chunk_id
      WHERE mc.memory_id IN ${sql(memoryIds)}
      ORDER BY mc.relevance DESC
    `;
    for (const row of joinRows) {
      const list = chunkMap.get(row.memory_id) ?? [];
      list.push({
        id: row.chunk_id,
        content: row.content,
        contextualPrefix: row.contextual_prefix,
        position: row.position,
        conversationId: row.conversation_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        documentDate: row.document_date,
        relevance: Number(row.relevance),
      });
      chunkMap.set(row.memory_id, list);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    category: row.category,
    status: row.status,
    version: row.version,
    confidence: Number(row.confidence),
    documentDate: row.document_date,
    eventDate: row.event_date,
    eventDatePrecision: row.event_date_precision,
    promptVersion: row.prompt_version,
    extractorModel: row.extractor_model,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score: Math.max(0, 1 - Number(row.distance)),
    chunks: chunkMap.get(row.id) ?? [],
  }));
}

/**
 * Hydrate memory rows by id, preserving the caller's order. Used by the
 * hybrid pipeline after RRF + rerank when we already have the winning ids.
 */
export async function fetchMemoriesByIds(
  sql: postgres.Sql,
  containerId: string,
  ids: string[],
): Promise<Map<string, Omit<MemoryHit, "score" | "chunks">>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<Omit<MemorySearchRow, "distance">[]>`
    SELECT
      id, content, category, status, version, confidence,
      document_date, event_date, event_date_precision,
      prompt_version, extractor_model, metadata,
      use_count, last_used_at, created_at, updated_at
    FROM memories
    WHERE container_id = ${containerId} AND id IN ${sql(ids)}
  `;
  const out = new Map<string, Omit<MemoryHit, "score" | "chunks">>();
  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      content: row.content,
      category: row.category,
      status: row.status,
      version: row.version,
      confidence: Number(row.confidence),
      documentDate: row.document_date,
      eventDate: row.event_date,
      eventDatePrecision: row.event_date_precision,
      promptVersion: row.prompt_version,
      extractorModel: row.extractor_model,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return out;
}

/**
 * Pull source chunks for a set of memory ids, returning a map keyed by
 * memory id. Order within each list follows `memory_chunks.relevance` desc.
 */
export async function joinChunksForMemories(
  sql: postgres.Sql,
  memoryIds: string[],
): Promise<Map<string, ChunkRef[]>> {
  const out = new Map<string, ChunkRef[]>();
  if (memoryIds.length === 0) return out;
  const rows = await sql<ChunkJoinRow[]>`
    SELECT
      mc.memory_id, mc.chunk_id, mc.relevance,
      c.content, c.contextual_prefix, c.position, c.conversation_id,
      c.source_type, c.source_id, c.document_date
    FROM memory_chunks mc
    JOIN chunks c ON c.id = mc.chunk_id
    WHERE mc.memory_id IN ${sql(memoryIds)}
    ORDER BY mc.relevance DESC
  `;
  for (const row of rows) {
    const list = out.get(row.memory_id) ?? [];
    list.push({
      id: row.chunk_id,
      content: row.content,
      contextualPrefix: row.contextual_prefix,
      position: row.position,
      conversationId: row.conversation_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      documentDate: row.document_date,
      relevance: Number(row.relevance),
    });
    out.set(row.memory_id, list);
  }
  return out;
}
