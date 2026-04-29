/**
 * POST /v1/search — query memory.
 *
 * Phase 2 returns memory-level results, with source chunks joined back in
 * when `include_chunks` is true. Response shape mirrors SPEC § /v1/search:
 *   { results: [{ memory, score, chunks }], query_metadata }
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

const DateRangeRequest = z.object({
  axis: z.enum(["event_date", "document_date"]),
  from: z.string().datetime().nullable().optional(),
  to: z.string().datetime().nullable().optional(),
});

const SearchRequest = z.object({
  container_tag: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(10),
  include_chunks: z.boolean().default(true),
  expand_graph: z.boolean().default(false),
  include_profile: z.boolean().default(true),
  filters: z
    .object({
      date_range: DateRangeRequest.nullable().optional(),
    })
    .optional(),
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

const RelatedMemoryResponse = z.object({
  memory: MemoryResponse,
  edge_type: z.enum(["updates", "extends", "derives", "contradicts"]),
  direction: z.enum(["outgoing", "incoming"]),
  edge_confidence: z.number(),
});

const DateRangeResponse = z.object({
  axis: z.enum(["event_date", "document_date"]),
  from: z.string().datetime().nullable(),
  to: z.string().datetime().nullable(),
});

const ProfileEnvelopeResponse = z.object({
  content: z.string(),
  version: z.number(),
  generated_at: z.string().datetime(),
  source_memory_count: z.number(),
});

const SearchResponse = z.object({
  results: z.array(
    z.object({
      memory: MemoryResponse,
      score: z.number(),
      chunks: z.array(ChunkResponse),
      related_memories: z.array(RelatedMemoryResponse),
    }),
  ),
  profile: ProfileEnvelopeResponse.nullable(),
  query_metadata: z.object({
    total_candidates: z.number(),
    latency_ms: z.number(),
    date_range: DateRangeResponse.nullable().optional(),
    should_abstain: z.boolean(),
    abstain_reason: z.enum(["no_candidates", "low_similarity"]).nullable(),
    profile_relevant: z.boolean(),
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
      // `filters.date_range: null` is meaningful — it disables the LLM-driven
      // temporal parser. `undefined` (no filters block) leaves auto-parse on.
      const rawDateRange =
        body.filters && "date_range" in body.filters ? body.filters.date_range : undefined;
      const dateRange =
        rawDateRange === undefined
          ? undefined
          : rawDateRange === null
            ? null
            : {
                axis: rawDateRange.axis,
                from: rawDateRange.from ? new Date(rawDateRange.from) : null,
                to: rawDateRange.to ? new Date(rawDateRange.to) : null,
              };
      const result = await app.memcore.search({
        containerTag: body.container_tag,
        query: body.query,
        limit: body.limit,
        includeChunks: body.include_chunks,
        expandGraph: body.expand_graph,
        includeProfile: body.include_profile,
        ...(dateRange === undefined ? {} : { dateRange }),
      });

      const memoryEnvelope = (m: {
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
      }) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        status: m.status,
        version: m.version,
        confidence: m.confidence,
        document_date: m.documentDate ? m.documentDate.toISOString() : null,
        event_date: m.eventDate ? m.eventDate.toISOString() : null,
        event_date_precision: m.eventDatePrecision,
        prompt_version: m.promptVersion,
        extractor_model: m.extractorModel,
      });

      return {
        results: result.results.map((r) => ({
          memory: memoryEnvelope(r.memory),
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
          related_memories: r.relatedMemories.map((rm) => ({
            memory: memoryEnvelope(rm.memory),
            edge_type: rm.edgeType,
            direction: rm.direction,
            edge_confidence: rm.edgeConfidence,
          })),
        })),
        profile: result.profile
          ? {
              content: result.profile.content,
              version: result.profile.version,
              generated_at: result.profile.generatedAt.toISOString(),
              source_memory_count: result.profile.sourceMemoryCount,
            }
          : null,
        query_metadata: {
          total_candidates: result.queryMetadata.totalCandidates,
          latency_ms: result.queryMetadata.latencyMs,
          date_range: result.queryMetadata.dateRange
            ? {
                axis: result.queryMetadata.dateRange.axis,
                from: result.queryMetadata.dateRange.from
                  ? result.queryMetadata.dateRange.from.toISOString()
                  : null,
                to: result.queryMetadata.dateRange.to
                  ? result.queryMetadata.dateRange.to.toISOString()
                  : null,
              }
            : null,
          should_abstain: result.queryMetadata.shouldAbstain,
          abstain_reason: result.queryMetadata.abstainReason,
          profile_relevant: result.queryMetadata.profileRelevant,
        },
      };
    },
  });
}
