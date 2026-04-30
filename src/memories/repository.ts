/**
 * Memory repository — caller-driven CRUD for the `memories` table.
 *
 * The ingestion pipeline (chunk → extract → conflict-detect → write) is the
 * primary write path. This module is the *secondary* path: callers (such as
 * a typed-memory agent) that already have a finished memory body and want to
 * persist it, edit it, or archive it without going through extraction.
 *
 * All functions take a postgres handle so they compose with transactions in
 * tests and migrations. They are scoped by container_tag everywhere — the
 * MemCore SDK never lets a caller cross containers.
 */

import type postgres from "postgres";

import { vectorLiteral } from "../db/vector.js";
import { NotFoundError, ValidationError } from "../errors.js";

const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "goal",
  "event",
  "relationship",
  "constraint",
  "opinion",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const MEMORY_STATUSES = ["active", "superseded", "deleted", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === "string" && (MEMORY_STATUSES as readonly string[]).includes(value);
}

export interface MemoryRow {
  id: string;
  containerId: string;
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
}

interface DbMemoryRow {
  id: string;
  container_id: string;
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

const COLUMNS = `
  id, container_id, content, category, status, version, confidence,
  document_date, event_date, event_date_precision,
  prompt_version, extractor_model, metadata,
  use_count, last_used_at, created_at, updated_at
`;

function mapRow(row: DbMemoryRow): MemoryRow {
  return {
    id: row.id,
    containerId: row.container_id,
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
  };
}

export async function resolveContainerId(
  sql: postgres.Sql,
  containerTag: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM containers WHERE tag = ${containerTag} LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

async function getOrCreateContainer(
  sql: postgres.TransactionSql | postgres.Sql,
  tag: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO containers (tag) VALUES (${tag})
    ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error(`container '${tag}' missing after upsert`);
  return row.id;
}

export interface InsertMemoryArgs {
  containerTag: string;
  content: string;
  embedding: number[];
  category: string;
  documentDate?: Date | null;
  eventDate?: Date | null;
  eventDatePrecision?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown>;
  promptVersion: string;
  extractorModel: string;
}

/**
 * Insert one memory row directly. Used by the manual / direct-add path
 * (`MemCore.add({ extract: false })`). Returns the full row.
 *
 * Conflict detection is *not* run here — the caller decides whether to call
 * `findSimilarMemories` first (`MemCore.findSimilar`). This keeps the path
 * predictable for callers that bring their own dedup logic.
 */
export async function insertMemory(sql: postgres.Sql, args: InsertMemoryArgs): Promise<MemoryRow> {
  if (!args.content.trim()) throw new ValidationError("content is required");
  if (!args.embedding.length) throw new ValidationError("embedding is required");

  return await sql.begin(async (tx) => {
    const containerId = await getOrCreateContainer(tx, args.containerTag);
    const inserted = await tx<DbMemoryRow[]>`
      INSERT INTO memories (
        container_id, content, embedding, category,
        document_date, event_date, event_date_precision,
        confidence, prompt_version, extractor_model, metadata
      ) VALUES (
        ${containerId}, ${args.content},
        ${vectorLiteral(args.embedding)}::vector,
        ${args.category},
        ${args.documentDate ?? null},
        ${args.eventDate ?? null},
        ${args.eventDatePrecision ?? null},
        ${args.confidence ?? 1.0},
        ${args.promptVersion},
        ${args.extractorModel},
        ${tx.json((args.metadata ?? {}) as never)}
      )
      RETURNING ${tx.unsafe(COLUMNS)}
    `;
    const row = inserted[0];
    if (!row) throw new Error("memory insert returned no row");
    return mapRow(row);
  });
}

export async function getMemoryById(
  sql: postgres.Sql,
  containerTag: string,
  id: string,
): Promise<MemoryRow | null> {
  const containerId = await resolveContainerId(sql, containerTag);
  if (!containerId) return null;
  const rows = await sql<DbMemoryRow[]>`
    SELECT ${sql.unsafe(COLUMNS)}
    FROM memories
    WHERE container_id = ${containerId} AND id = ${id}
    LIMIT 1
  `;
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export interface ListMemoriesArgs {
  containerTag: string;
  filters?: {
    metadata?: Record<string, unknown>;
    status?: MemoryStatus | MemoryStatus[];
    categories?: string[];
  };
  /** Default `recency`. */
  sort?: "recency" | "use_count" | "created_at";
  limit?: number;
  offset?: number;
}

/**
 * Return all memories matching a filter. Used to build "eager blocks" for an
 * agent prompt (e.g. all active user+feedback memories tagged X). Recency
 * is the default sort because that's the common eager-block need.
 */
export async function listMemories(
  sql: postgres.Sql,
  args: ListMemoriesArgs,
): Promise<MemoryRow[]> {
  const containerId = await resolveContainerId(sql, args.containerTag);
  if (!containerId) return [];

  const limit = Math.min(args.limit ?? 200, 1000);
  const offset = Math.max(args.offset ?? 0, 0);
  const sort = args.sort ?? "recency";

  const statusFilter = args.filters?.status;
  const statusArray = statusFilter
    ? Array.isArray(statusFilter)
      ? statusFilter
      : [statusFilter]
    : null;
  const categories = args.filters?.categories ?? null;
  const metadata = args.filters?.metadata ?? null;

  const orderBy = sql.unsafe(
    sort === "use_count"
      ? "use_count DESC, updated_at DESC"
      : sort === "created_at"
        ? "created_at DESC"
        : "updated_at DESC",
  );

  const filters: postgres.PendingQuery<postgres.Row[]>[] = [];
  if (statusArray) filters.push(sql`AND status IN ${sql(statusArray)}`);
  if (categories && categories.length > 0) {
    filters.push(sql`AND category IN ${sql(categories)}`);
  }
  if (metadata) filters.push(sql`AND metadata @> ${sql.json(metadata as never)}`);

  let whereTail = sql``;
  for (const f of filters) whereTail = sql`${whereTail} ${f}`;

  const rows = await sql<DbMemoryRow[]>`
    SELECT ${sql.unsafe(COLUMNS)}
    FROM memories
    WHERE container_id = ${containerId} ${whereTail}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(mapRow);
}

export interface UpdateMemoryArgs {
  containerTag: string;
  id: string;
  content?: string;
  /** When set, the new embedding to write alongside `content`. Required if `content` is set. */
  embedding?: number[];
  /** When set, *replaces* the metadata blob. Use a merged object if you want a partial update. */
  metadata?: Record<string, unknown>;
  category?: string;
  eventDate?: Date | null;
  eventDatePrecision?: string | null;
  confidence?: number;
}

/**
 * Edit a single memory row. When `content` changes we re-embed and bump
 * `version`; metadata-only edits leave the embedding alone and don't bump
 * version (the body is unchanged, so old version tags still apply).
 */
export async function updateMemory(sql: postgres.Sql, args: UpdateMemoryArgs): Promise<MemoryRow> {
  if (
    args.content === undefined &&
    args.metadata === undefined &&
    args.category === undefined &&
    args.eventDate === undefined &&
    args.eventDatePrecision === undefined &&
    args.confidence === undefined
  ) {
    throw new ValidationError("update requires at least one field");
  }
  if (args.content !== undefined && (!args.embedding || !args.embedding.length)) {
    throw new ValidationError("content edit requires a new embedding");
  }

  const containerId = await resolveContainerId(sql, args.containerTag);
  if (!containerId) throw new NotFoundError(`container '${args.containerTag}' not found`);

  const contentChanged = args.content !== undefined;

  // Run each field update as its own SQL fragment so we can mix bound params,
  // raw casts (vector), and conditional re-embed without fighting the driver.
  const sets: postgres.PendingQuery<postgres.Row[]>[] = [];
  if (args.content !== undefined) sets.push(sql`content = ${args.content}`);
  if (contentChanged && args.embedding) {
    sets.push(sql`embedding = ${vectorLiteral(args.embedding)}::vector`);
  }
  if (args.category !== undefined) sets.push(sql`category = ${args.category}`);
  if (args.eventDate !== undefined) sets.push(sql`event_date = ${args.eventDate ?? null}`);
  if (args.eventDatePrecision !== undefined) {
    sets.push(sql`event_date_precision = ${args.eventDatePrecision ?? null}`);
  }
  if (args.confidence !== undefined) sets.push(sql`confidence = ${args.confidence}`);
  if (args.metadata !== undefined) {
    sets.push(sql`metadata = ${sql.json(args.metadata as never)}`);
  }
  if (contentChanged) sets.push(sql`version = version + 1`);
  sets.push(sql`updated_at = NOW()`);

  // postgres.js doesn't expose a "join fragments" helper, so reduce by
  // wrapping pairs in `sql`fragment, fragment` chains.
  const first = sets[0];
  if (!first) throw new ValidationError("update requires at least one field");
  let setClause: postgres.PendingQuery<postgres.Row[]> = first;
  for (let i = 1; i < sets.length; i += 1) {
    const next = sets[i];
    if (!next) continue;
    setClause = sql`${setClause}, ${next}`;
  }

  const rows = await sql<DbMemoryRow[]>`
    UPDATE memories SET ${setClause}
    WHERE container_id = ${containerId} AND id = ${args.id}
    RETURNING ${sql.unsafe(COLUMNS)}
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError(`memory '${args.id}' not found`);
  return mapRow(row);
}

/** Flip a memory's status to `archived`. Removed from search results. */
export async function archiveMemory(
  sql: postgres.Sql,
  containerTag: string,
  id: string,
): Promise<MemoryRow> {
  const containerId = await resolveContainerId(sql, containerTag);
  if (!containerId) throw new NotFoundError(`container '${containerTag}' not found`);
  const rows = await sql<DbMemoryRow[]>`
    UPDATE memories
    SET status = 'archived', updated_at = NOW()
    WHERE container_id = ${containerId} AND id = ${id}
    RETURNING ${sql.unsafe(COLUMNS)}
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError(`memory '${id}' not found`);
  return mapRow(row);
}

/**
 * Increment use_count and stamp last_used_at for one or more memories. Used
 * by `MemCore.search` to track which memories actually got returned, and by
 * the public `recordUse(id)` SDK method.
 */
export async function recordMemoryUse(
  sql: postgres.Sql,
  containerTag: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const containerId = await resolveContainerId(sql, containerTag);
  if (!containerId) return;
  await sql`
    UPDATE memories
    SET use_count = use_count + 1, last_used_at = NOW()
    WHERE container_id = ${containerId} AND id IN ${sql(ids)}
  `;
}

export interface SimilarMemoryHit {
  id: string;
  content: string;
  category: string;
  status: string;
  similarity: number;
  metadata: Record<string, unknown>;
  documentDate: Date | null;
}

export interface FindSimilarArgs {
  containerTag: string;
  embedding: number[];
  limit?: number;
  /** Cosine similarity (0..1). Default 0. */
  threshold?: number;
  /** Default `["active"]`. Pass `[]` to include all statuses. */
  statuses?: MemoryStatus[];
}

/**
 * Pre-write duplicate / near-duplicate lookup. Embed the candidate content,
 * run vector search, return the matches above the threshold without writing
 * anything. Callers can use the result to decide whether to insert or to
 * update an existing row.
 */
export async function findSimilarMemories(
  sql: postgres.Sql,
  args: FindSimilarArgs,
): Promise<SimilarMemoryHit[]> {
  const containerId = await resolveContainerId(sql, args.containerTag);
  if (!containerId) return [];
  const limit = Math.min(args.limit ?? 5, 50);
  const threshold = args.threshold ?? 0;
  const statuses = args.statuses ?? ["active"];
  const literal = vectorLiteral(args.embedding);
  const statusFilter = statuses.length > 0 ? sql`AND status IN ${sql(statuses)}` : sql``;
  const rows = await sql<
    {
      id: string;
      content: string;
      category: string;
      status: string;
      metadata: Record<string, unknown> | null;
      document_date: Date | null;
      distance: number;
    }[]
  >`
    SELECT id, content, category, status, metadata, document_date,
           embedding <=> ${literal}::vector AS distance
    FROM memories
    WHERE container_id = ${containerId}
      AND embedding IS NOT NULL
      ${statusFilter}
    ORDER BY embedding <=> ${literal}::vector ASC
    LIMIT ${limit}
  `;
  return rows
    .map((row) => ({
      id: row.id,
      content: row.content,
      category: row.category,
      status: row.status,
      similarity: Math.max(0, 1 - Number(row.distance)),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      documentDate: row.document_date,
    }))
    .filter((hit) => hit.similarity >= threshold);
}
