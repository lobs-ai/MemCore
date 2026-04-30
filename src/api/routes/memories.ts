/**
 * /v1/memories — caller-driven CRUD for the memories table.
 *
 * Mirrors the SDK `MemCore.get/list/update/archive/findSimilar` surface plus
 * the direct-create path (`POST /v1/memories` with `extract: false` semantics).
 * The chunk-and-extract pipeline still goes through `POST /v1/add`.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

// Categories are caller-defined strings. The default extraction pipeline uses
// a fixed set ("preference" / "fact" / ...), but typed-memory callers route on
// their own values (e.g. "user" / "feedback" / "project"). Validation here is
// minimal — non-empty, capped length — so the column does the routing work.
const Category = z.string().min(1).max(64);

const Status = z.enum(["active", "superseded", "deleted", "archived"]);

const MemoryRowResponse = z.object({
  id: z.string().uuid(),
  container_id: z.string().uuid(),
  content: z.string(),
  category: z.string(),
  status: z.string(),
  version: z.number(),
  confidence: z.number(),
  document_date: z.string().datetime().nullable(),
  event_date: z.string().datetime().nullable(),
  event_date_precision: z.string().nullable(),
  prompt_version: z.string(),
  extractor_model: z.string(),
  metadata: z.record(z.unknown()),
  use_count: z.number(),
  last_used_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

interface MemoryRowDomain {
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

function toMemoryEnvelope(row: MemoryRowDomain): z.infer<typeof MemoryRowResponse> {
  return {
    id: row.id,
    container_id: row.containerId,
    content: row.content,
    category: row.category,
    status: row.status,
    version: row.version,
    confidence: row.confidence,
    document_date: row.documentDate ? row.documentDate.toISOString() : null,
    event_date: row.eventDate ? row.eventDate.toISOString() : null,
    event_date_precision: row.eventDatePrecision,
    prompt_version: row.promptVersion,
    extractor_model: row.extractorModel,
    metadata: row.metadata,
    use_count: row.useCount,
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const CreateRequest = z.object({
  container_tag: z.string().min(1),
  content: z.string().min(1),
  category: Category,
  metadata: z.record(z.unknown()).optional(),
  document_date: z.coerce.date().optional(),
  event_date: z.coerce.date().nullable().optional(),
  event_date_precision: z.enum(["day", "month", "year", "unknown"]).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ListQuery = z.object({
  container_tag: z.string().min(1),
  status: z.union([Status, z.array(Status)]).optional(),
  categories: z.array(Category).optional(),
  metadata: z.string().optional(), // JSON-encoded for GET
  sort: z.enum(["recency", "use_count", "created_at"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const UpdateRequest = z.object({
  container_tag: z.string().min(1),
  content: z.string().min(1).optional(),
  category: Category.optional(),
  metadata: z.record(z.unknown()).optional(),
  event_date: z.coerce.date().nullable().optional(),
  event_date_precision: z.enum(["day", "month", "year", "unknown"]).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const ArchiveRequest = z.object({
  container_tag: z.string().min(1),
});

const FindSimilarRequest = z.object({
  container_tag: z.string().min(1),
  content: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
  threshold: z.number().min(0).max(1).optional(),
  statuses: z.array(Status).optional(),
});

const FindSimilarResponse = z.object({
  matches: z.array(
    z.object({
      id: z.string().uuid(),
      content: z.string(),
      category: z.string(),
      status: z.string(),
      similarity: z.number(),
      metadata: z.record(z.unknown()),
      document_date: z.string().datetime().nullable(),
    }),
  ),
});

const RecordUseRequest = z.object({
  container_tag: z.string().min(1),
  ids: z.union([z.string().uuid(), z.array(z.string().uuid())]),
});

export function registerMemoriesRoutes(app: FastifyInstance): void {
  // POST /v1/memories — direct create (no extraction).
  app.route({
    method: "POST",
    url: "/memories",
    schema: { body: CreateRequest, response: { 201: MemoryRowResponse } },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof CreateRequest>;
      const result = await app.memcore.add({
        containerTag: body.container_tag,
        content: body.content,
        category: body.category,
        extract: false,
        ...(body.metadata ? { metadata: body.metadata } : {}),
        ...(body.document_date ? { documentDate: body.document_date } : {}),
        ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
      });
      const inserted = result.memories[0];
      if (!inserted) throw new Error("direct add did not return a row");
      const full = await app.memcore.get({ containerTag: body.container_tag, id: inserted.id });
      if (!full) throw new Error("inserted row missing on read-back");
      return reply.status(201).send(toMemoryEnvelope(full));
    },
  });

  // GET /v1/memories — list by filter.
  app.route({
    method: "GET",
    url: "/memories",
    schema: {
      querystring: ListQuery,
      response: { 200: z.object({ memories: z.array(MemoryRowResponse) }) },
    },
    handler: async (req) => {
      const q = req.query as z.infer<typeof ListQuery>;
      let metadataFilter: Record<string, unknown> | undefined;
      if (q.metadata) {
        try {
          metadataFilter = JSON.parse(q.metadata) as Record<string, unknown>;
        } catch {
          throw new Error("metadata query param must be valid JSON");
        }
      }
      const rows = await app.memcore.list({
        containerTag: q.container_tag,
        ...(q.sort ? { sort: q.sort } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
        ...(q.status || q.categories || metadataFilter
          ? {
              filters: {
                ...(q.status ? { status: q.status } : {}),
                ...(q.categories ? { categories: q.categories } : {}),
                ...(metadataFilter ? { metadata: metadataFilter } : {}),
              },
            }
          : {}),
      });
      return { memories: rows.map(toMemoryEnvelope) };
    },
  });

  // GET /v1/memories/:id
  app.route({
    method: "GET",
    url: "/memories/:id",
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({ container_tag: z.string().min(1) }),
      response: { 200: MemoryRowResponse, 404: z.object({ error: z.unknown() }) },
    },
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const { container_tag } = req.query as { container_tag: string };
      const row = await app.memcore.get({ containerTag: container_tag, id });
      if (!row) {
        return reply.status(404).send({
          error: { code: "not_found", message: `memory '${id}' not found`, details: {} },
        });
      }
      return toMemoryEnvelope(row);
    },
  });

  // PATCH /v1/memories/:id — partial update; re-embeds when content changes.
  app.route({
    method: "PATCH",
    url: "/memories/:id",
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateRequest,
      response: { 200: MemoryRowResponse },
    },
    handler: async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof UpdateRequest>;
      const updated = await app.memcore.update({
        containerTag: body.container_tag,
        id,
        ...(body.content !== undefined ? { content: body.content } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(body.event_date !== undefined ? { eventDate: body.event_date } : {}),
        ...(body.event_date_precision !== undefined
          ? { eventDatePrecision: body.event_date_precision }
          : {}),
        ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
      });
      return toMemoryEnvelope(updated);
    },
  });

  // DELETE /v1/memories/:id — soft archive.
  app.route({
    method: "DELETE",
    url: "/memories/:id",
    schema: {
      params: z.object({ id: z.string().uuid() }),
      body: ArchiveRequest,
      response: { 200: MemoryRowResponse },
    },
    handler: async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof ArchiveRequest>;
      const archived = await app.memcore.archive({ containerTag: body.container_tag, id });
      return toMemoryEnvelope(archived);
    },
  });

  // POST /v1/memories/find-similar
  app.route({
    method: "POST",
    url: "/memories/find-similar",
    schema: { body: FindSimilarRequest, response: { 200: FindSimilarResponse } },
    handler: async (req) => {
      const body = req.body as z.infer<typeof FindSimilarRequest>;
      const matches = await app.memcore.findSimilar({
        containerTag: body.container_tag,
        content: body.content,
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
        ...(body.statuses ? { statuses: body.statuses } : {}),
      });
      return {
        matches: matches.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          status: m.status,
          similarity: m.similarity,
          metadata: m.metadata,
          document_date: m.documentDate ? m.documentDate.toISOString() : null,
        })),
      };
    },
  });

  // POST /v1/memories/record-use
  app.route({
    method: "POST",
    url: "/memories/record-use",
    schema: { body: RecordUseRequest, response: { 204: z.null() } },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof RecordUseRequest>;
      await app.memcore.recordUse({ containerTag: body.container_tag, ids: body.ids });
      return reply.status(204).send();
    },
  });
}
