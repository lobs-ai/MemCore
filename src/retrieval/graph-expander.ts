/**
 * One-hop graph expansion at query time.
 *
 * Phase 4: after rerank, the top memories are passed here to pull in their
 * directly-connected neighbours from the `edges` table. We deliberately stop
 * at one hop (DESIGN § 2): multi-hop traversal is expensive, error-prone,
 * and rarely beats letting the LLM reason over a one-hop neighbourhood.
 *
 * Both directions are followed:
 *   - outgoing edges (where the matched memory is `source_memory_id`)
 *   - incoming edges (where the matched memory is `target_memory_id`)
 *
 * The neighbour memory's `status` is preserved (`active` / `superseded`) so
 * the caller can render an "old answer (superseded)" badge on top of the
 * current memory when an `updates` chain shows up.
 */

import type postgres from "postgres";

import type { MemoryHit } from "./memory-search.js";

export type EdgeType = "updates" | "extends" | "derives" | "contradicts";

/** Direction of an edge relative to the matched ("seed") memory. */
export type EdgeDirection = "outgoing" | "incoming";

export interface RelatedMemory {
  /** The neighbour memory pulled in by the edge. Score is 0 — neighbours weren't ranked. */
  memory: Omit<MemoryHit, "score" | "chunks">;
  edgeType: EdgeType;
  /** Direction of the edge from the seed memory's point of view. */
  direction: EdgeDirection;
  /** Stored confidence on the edge itself (0..1). */
  edgeConfidence: number;
}

interface EdgeRow {
  source_memory_id: string;
  target_memory_id: string;
  relationship_type: EdgeType;
  edge_confidence: number;
  // neighbour columns (mirrors memories projection in memory-search.ts)
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
}

/**
 * For each seed memory id, return its one-hop neighbours via the `edges` table.
 * The returned map uses the seed id as the key. Neighbours within `seedIds`
 * itself are excluded so we don't echo top-k results back to themselves.
 */
export async function expandGraph(
  sql: postgres.Sql,
  containerId: string,
  seedIds: string[],
): Promise<Map<string, RelatedMemory[]>> {
  const out = new Map<string, RelatedMemory[]>();
  if (seedIds.length === 0) return out;

  const seedSet = new Set(seedIds);

  const rows = await sql<EdgeRow[]>`
    SELECT
      e.source_memory_id, e.target_memory_id, e.relationship_type,
      e.confidence AS edge_confidence,
      m.id, m.content, m.category, m.status, m.version, m.confidence,
      m.document_date, m.event_date, m.event_date_precision,
      m.prompt_version, m.extractor_model, m.metadata,
      m.use_count, m.last_used_at, m.created_at, m.updated_at
    FROM edges e
    JOIN memories m
      ON m.id = CASE
        WHEN e.source_memory_id IN ${sql(seedIds)} THEN e.target_memory_id
        ELSE e.source_memory_id
      END
    WHERE m.container_id = ${containerId}
      AND (e.source_memory_id IN ${sql(seedIds)} OR e.target_memory_id IN ${sql(seedIds)})
  `;

  for (const row of rows) {
    const sourceIsSeed = seedSet.has(row.source_memory_id);
    const seedId = sourceIsSeed ? row.source_memory_id : row.target_memory_id;
    const direction: EdgeDirection = sourceIsSeed ? "outgoing" : "incoming";

    // Skip neighbours that are themselves in the seed set — the caller
    // already has them as ranked hits.
    if (seedSet.has(row.id)) continue;

    const list = out.get(seedId) ?? [];
    list.push({
      memory: {
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
      },
      edgeType: row.relationship_type,
      direction,
      edgeConfidence: Number(row.edge_confidence),
    });
    out.set(seedId, list);
  }

  return out;
}
