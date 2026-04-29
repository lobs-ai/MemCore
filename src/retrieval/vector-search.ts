/**
 * Cosine vector search over chunks.
 *
 * Phase 1 runs the search directly against `chunks` — there are no memories
 * yet. When Phase 2 introduces the memories table, the same shape applies,
 * just with a different query target.
 *
 * No embedding index in Phase 1: 3072-dim vectors exceed pgvector's
 * ivfflat/HNSW dim cap (see db/schema.sql). Sequential cosine scan is fine
 * for the small Phase 1 corpus. Phase 3 adds an HNSW index over halfvec.
 */

import type postgres from "postgres";
import { vectorLiteral } from "../db/vector.js";

export interface ChunkHit {
  id: string;
  content: string;
  conversationId: string | null;
  sourceType: string;
  sourceId: string | null;
  position: number;
  documentDate: Date | null;
  contextualPrefix: string | null;
  score: number;
}

export interface VectorSearchArgs {
  containerId: string;
  queryVector: number[];
  limit: number;
}

interface ChunkSearchRow {
  id: string;
  content: string;
  conversation_id: string | null;
  source_type: string;
  source_id: string | null;
  position: number;
  document_date: Date | null;
  contextual_prefix: string | null;
  distance: number;
}

export async function vectorSearchChunks(
  sql: postgres.Sql,
  args: VectorSearchArgs,
): Promise<ChunkHit[]> {
  const queryLiteral = vectorLiteral(args.queryVector);
  // pgvector's `<=>` is cosine distance (1 - similarity). We project both
  // distance and similarity-friendly score so callers don't have to flip it.
  const rows = await sql<ChunkSearchRow[]>`
    SELECT
      id, content, conversation_id, source_type, source_id, position,
      document_date, contextual_prefix,
      embedding <=> ${queryLiteral}::vector AS distance
    FROM chunks
    WHERE container_id = ${args.containerId}
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${queryLiteral}::vector ASC
    LIMIT ${args.limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    conversationId: row.conversation_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    position: row.position,
    documentDate: row.document_date,
    contextualPrefix: row.contextual_prefix,
    score: Math.max(0, 1 - Number(row.distance)),
  }));
}
