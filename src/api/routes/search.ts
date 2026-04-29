/**
 * POST /v1/search — query memory.
 *
 * Phase 1 returns chunk-level vector search results. SPEC.md's response shape
 * uses memories with attached source chunks; until memories exist, we return
 * the chunks directly under the same `results[].chunks` shape so clients can
 * keep their parsing stable across phases.
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
});

const SearchResponse = z.object({
  results: z.array(
    z.object({
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
          score: r.score,
          chunks: [
            {
              id: r.chunk.id,
              content: r.chunk.content,
              contextual_prefix: r.chunk.contextualPrefix,
              position: r.chunk.position,
              conversation_id: r.chunk.conversationId,
              source_type: r.chunk.sourceType,
              source_id: r.chunk.sourceId,
              document_date: r.chunk.documentDate ? r.chunk.documentDate.toISOString() : null,
            },
          ],
        })),
        query_metadata: {
          total_candidates: result.queryMetadata.totalCandidates,
          latency_ms: result.queryMetadata.latencyMs,
        },
      };
    },
  });
}
