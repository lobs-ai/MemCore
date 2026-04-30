/**
 * Keyword (BM25-equivalent) search over memories using Postgres tsvector.
 *
 * Phase 3 hybrid retrieval: this is the second leg, fused with vector search
 * via RRF. The query is parsed with `plainto_tsquery` (forgiving, accepts free
 * text) and ranked with `ts_rank_cd`. The GIN index on
 * `to_tsvector('english', content)` is created in db/schema.sql.
 *
 * Returns the same row shape as `vectorSearchMemories` so the fusion layer
 * can dedupe by id without caring which leg the row came from. `score` is
 * `ts_rank_cd` rescaled to a similarity-style 0..1 — informational only,
 * since RRF discards absolute scores in favour of ranks.
 */

import type postgres from "postgres";

export interface KeywordHit {
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
  score: number;
}

export interface KeywordSearchFilters {
  statuses?: string[];
  categories?: string[];
  metadata?: Record<string, unknown>;
}

export interface KeywordSearchArgs {
  containerId: string;
  query: string;
  limit: number;
  filters?: KeywordSearchFilters;
}

interface KeywordSearchRow {
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
  rank: number;
}

export async function keywordSearchMemories(
  sql: postgres.Sql,
  args: KeywordSearchArgs,
): Promise<KeywordHit[]> {
  // `plainto_tsquery` strips punctuation and combines terms with AND. That's
  // a stricter match than what users probably expect, but it's the cheapest
  // good baseline; tuning to OR / websearch_to_tsquery is a Phase 3.x knob if
  // recall complaints surface. Empty queries yield no rows (the query parser
  // will return an empty tsquery).
  const statuses = args.filters?.statuses ?? ["active"];
  const categories = args.filters?.categories;
  const metadata = args.filters?.metadata;

  const statusClause = statuses.length > 0 ? sql`AND status IN ${sql(statuses)}` : sql``;
  const categoryClause =
    categories && categories.length > 0 ? sql`AND category IN ${sql(categories)}` : sql``;
  const metadataClause = metadata ? sql`AND metadata @> ${sql.json(metadata as never)}` : sql``;

  const rows = await sql<KeywordSearchRow[]>`
    SELECT
      id, content, category, status, version, confidence,
      document_date, event_date, event_date_precision,
      prompt_version, extractor_model,
      ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', ${args.query})) AS rank
    FROM memories
    WHERE container_id = ${args.containerId}
      ${statusClause}
      ${categoryClause}
      ${metadataClause}
      AND to_tsvector('english', content) @@ plainto_tsquery('english', ${args.query})
    ORDER BY rank DESC
    LIMIT ${args.limit}
  `;

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
    score: Number(row.rank),
  }));
}
