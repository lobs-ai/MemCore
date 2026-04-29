/**
 * POST /v1/search — query memory.
 *
 * Phase 2 returns memory-level results, with source chunks joined back in
 * when `include_chunks` is true. Response shape mirrors SPEC § /v1/search:
 *   { results: [{ memory, score, chunks }], query_metadata }
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const SearchRequest = z.object({
  container_tag: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(10),
  include_chunks: z.boolean().default(true),
});

const ChunkResponse = z.object({
  id: z.string().uuid(),
  content: z.string(),
  contextual_prefix: z.string().nullable(),
  position: z.number(),
  conversation_id: z.string().uuid().nullable(),
  source_type: z.string(),
  source_id: z.string().nullable(),
  document_date: z.string().datetime().nullable(),
  relevance: z.number(),
});

const MemoryResponse = z.object({
  id: z.string().uuid(),
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
});

const SearchResponse = z.object({
  results: z.array(
    z.object({
      memory: MemoryResponse,
      score: z.number(),
      chunks: z.array(ChunkResponse),
    }),
  ),
  query_metadata: z.object({
    total_candidates: z.number(),
    latency_ms: z.number(),
  }),
});

export function registerSearchRoute(app: FastifyInstance): void {
  app.route({
    method: "POST",
    url: "/search",
    schema: {
      body: SearchRequest,
      response: { 200: SearchResponse },
    },
    handler: async (req) => {
      const body = req.body as z.infer<typeof SearchRequest>;
      const result = await app.memcore.search({
        containerTag: body.container_tag,
        query: body.query,
        limit: body.limit,
        includeChunks: body.include_chunks,
      });

      return {
        results: result.results.map((r) => ({
          memory: {
            id: r.memory.id,
            content: r.memory.content,
            category: r.memory.category,
            status: r.memory.status,
            version: r.memory.version,
            confidence: r.memory.confidence,
            document_date: r.memory.documentDate ? r.memory.documentDate.toISOString() : null,
            event_date: r.memory.eventDate ? r.memory.eventDate.toISOString() : null,
            event_date_precision: r.memory.eventDatePrecision,
            prompt_version: r.memory.promptVersion,
            extractor_model: r.memory.extractorModel,
          },
          score: r.score,
          chunks: r.memory.chunks.map((c) => ({
            id: c.id,
            content: c.content,
            contextual_prefix: c.contextualPrefix,
            position: c.position,
            conversation_id: c.conversationId,
            source_type: c.sourceType,
            source_id: c.sourceId,
            document_date: c.documentDate ? c.documentDate.toISOString() : null,
            relevance: c.relevance,
          })),
        })),
        query_metadata: {
          total_candidates: result.queryMetadata.totalCandidates,
          latency_ms: result.queryMetadata.latencyMs,
        },
      };
    },
  });
}
