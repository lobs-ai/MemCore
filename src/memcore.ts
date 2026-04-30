/**
 * MemCore — public SDK class.
 *
 * Embed this in your own process to call ingestion and search directly,
 * without an HTTP hop. The Fastify server in `src/api/` is a thin wrapper
 * around an instance of this class. Both share the same surface area.
 *
 *   const memcore = new MemCore({
 *     databaseUrl: "postgresql://...",
 *     openaiApiKey: process.env.OPENAI_API_KEY,
 *     // optional injection points:
 *     // embedder: myEmbedder,
 *     // llmClient: myLLMClient,
 *   });
 *   await memcore.add({ containerTag: "user_42", content: "..." });
 *   const { results } = await memcore.search({ containerTag: "user_42", query: "..." });
 *   await memcore.close();
 *
 * Phase 2: search runs against memories with source chunks joined back in.
 * Memory extraction during ingestion requires an `LLMClient`. When no LLM is
 * configured, ingestion still runs in chunk-only mode (Phase 1 behaviour) so
 * boot doesn't fail without keys — the `search()` path then returns nothing
 * because no memories exist.
 */

import postgres from "postgres";

import { ValidationError } from "./errors.js";
import { type IngestArgs, type IngestResult, ingest } from "./ingestion/pipeline.js";
import { type LLMClient, TrackedLLMClient } from "./llm/client.js";
import { CostTracker } from "./llm/cost-tracker.js";
import { type Embedder, TrackedEmbedder } from "./llm/embedder.js";
import { OpenAIEmbedder } from "./llm/openai-embedder.js";
import { OpenAILLMClient } from "./llm/openai-llm-client.js";
import { StubEmbedder } from "./llm/stub-embedder.js";
import { getLogger } from "./logging.js";
import {
  type MemoryCategory,
  type MemoryRow,
  type MemoryStatus,
  type FindSimilarArgs as RepoFindSimilarArgs,
  type ListMemoriesArgs as RepoListMemoriesArgs,
  type SimilarMemoryHit,
  archiveMemory,
  findSimilarMemories,
  getMemoryById,
  insertMemory,
  isMemoryCategory,
  listMemories,
  recordMemoryUse,
  updateMemory,
} from "./memories/repository.js";
import { type ProfileRecord, generateProfile, getProfileByContainer } from "./profile/generator.js";
import { isProfileRelevant } from "./profile/relevance.js";
import { type RelatedMemory, expandGraph } from "./retrieval/graph-expander.js";
import { keywordSearchMemories } from "./retrieval/keyword-search.js";
import {
  type MemoryHit,
  fetchMemoriesByIds,
  joinChunksForMemories,
  vectorSearchMemories,
} from "./retrieval/memory-search.js";
import { CohereReranker, PassthroughReranker, type Reranker } from "./retrieval/reranker.js";
import { fuseRanks } from "./retrieval/rrf.js";
import { filterByDateRange } from "./retrieval/temporal-filter.js";
import { type DateRange, parseTemporalScope } from "./retrieval/temporal-parser.js";
import { VERSION } from "./version.js";

const logger = getLogger("memcore");

export interface MemCoreOptions {
  /** Postgres connection string. Required. */
  databaseUrl: string;
  /**
   * Embedder implementation. When omitted, MemCore builds the default OpenAI-
   * compatible embedder using `embeddingApiKey` / `openaiApiKey` and
   * `embeddingBaseUrl`. Pass any object satisfying `Embedder` to plug in a
   * different provider.
   */
  embedder?: Embedder;
  /**
   * LLM client used for memory extraction (Phase 2+). When omitted, MemCore
   * builds the default OpenAI-compatible chat client using `openaiApiKey` and
   * `llmBaseUrl`. Pass any object satisfying `LLMClient` to plug in a
   * different provider (Anthropic, etc.).
   *
   * If neither an `llmClient` nor an `openaiApiKey` is provided, ingestion
   * falls back to chunk-only mode. Search still works but returns nothing
   * unless the database has pre-existing memories.
   */
  llmClient?: LLMClient;
  /** Base URL for the default LLM client. Defaults to `https://api.openai.com/v1`. */
  llmBaseUrl?: string;
  /**
   * Base URL for the default embedder. Defaults to `https://api.openai.com/v1`.
   * Set to `http://localhost:1234/v1` for LMStudio, `http://localhost:11434/v1`
   * for Ollama, or any other OpenAI-compatible endpoint.
   */
  embeddingBaseUrl?: string;
  /**
   * API key for the default embedder. Falls back to `openaiApiKey`.
   */
  embeddingApiKey?: string;
  /** Convenience alias for both `embeddingApiKey` and the LLM client API key. */
  openaiApiKey?: string;
  /** Embedding model name for the default OpenAI embedder. */
  embeddingModel?: string;
  /** Embedding vector dimension. Used by the stub embedder; OpenAI ignores it. */
  embeddingDim?: number;
  /** Model name passed to the LLM client for extraction calls. */
  extractionModel?: string;
  /** Model name passed to the LLM client for chunk contextualization. */
  contextualizerModel?: string;
  /** Model name passed to the LLM client for conflict detection (Phase 4). */
  conflictModel?: string;
  /** Model name passed to the LLM client for query-time temporal parsing (Phase 5). */
  temporalParserModel?: string;
  /**
   * Cosine similarity threshold (0..1) above which the conflict detector LLM
   * is invoked. Below it, candidates are classified as `new` without an LLM
   * call. Default 0.75 (see SPEC § Phase 4).
   */
  conflictSimilarityThreshold?: number;
  /** Top-K existing memories considered per candidate during conflict detection. Default 5. */
  conflictTopK?: number;
  /** Chunker target token count. Defaults to 800. */
  chunkMaxTokens?: number;
  /** Chunker minimum token count below which input becomes a single chunk. Defaults to 100. */
  chunkMinTokens?: number;
  /**
   * Reranker for the final stage of search. When omitted and `cohereApiKey`
   * is set, MemCore builds a `CohereReranker`. When neither is provided, the
   * pipeline falls back to a no-op passthrough that preserves RRF order.
   */
  reranker?: Reranker;
  /** API key for the default Cohere reranker. */
  cohereApiKey?: string;
  /** Reranker model name. Defaults to `rerank-v3.5`. */
  rerankerModel?: string;
  /** Model name passed to the LLM client for profile generation (Phase 6). */
  profileGeneratorModel?: string;
  /**
   * Cap on the number of active memories handed to the profile generator in a
   * single call. Default 200. Larger containers truncate to the top-N by the
   * generator's internal ordering (category priority, recency).
   */
  profileMaxMemories?: number;
  /**
   * Phase 6 abstain gate. When the top vector-search cosine similarity is
   * below this floor, `search()` returns `shouldAbstain: true` and an empty
   * results list — the caller can use that to skip the LLM round-trip and
   * answer "I don't have anything on that." Default 0.3 (calibrated to
   * `text-embedding-3-large`); set to 0 to disable.
   */
  abstainSimilarityFloor?: number;
}

export interface AddArgs {
  containerTag: string;
  content?: string;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  sourceType?: string;
  externalId?: string;
  documentDate?: Date;
  metadata?: Record<string, unknown>;
  /**
   * When `false`, MemCore writes the supplied `content` as a single memory
   * row verbatim — no chunking, no LLM extraction, no conflict detection.
   * Use this when the caller already has the finished memory body (e.g. an
   * agent's `memory_save` tool) and doesn't want it split into atoms.
   *
   * Required: `content` (one memory body), `category`. The returned
   * `IngestResult.memories` contains exactly one row whose id the caller can
   * adopt as a stable identifier.
   *
   * Defaults to `true` (the standard extraction pipeline).
   */
  extract?: boolean;
  /**
   * Memory category for the direct-add path (`extract: false`). Required in
   * that case. Ignored when `extract` is `true` — extraction picks the
   * category per memory.
   */
  category?: MemoryCategory;
  /**
   * Confidence (0..1) for the direct-add path. Defaults to 1.0.
   */
  confidence?: number;
}

export interface AddMemoryArgs {
  containerTag: string;
  content: string;
  category: MemoryCategory;
  metadata?: Record<string, unknown>;
  documentDate?: Date | null;
  eventDate?: Date | null;
  eventDatePrecision?: string | null;
  confidence?: number;
}

export interface ListMemoriesArgs {
  containerTag: string;
  filters?: {
    metadata?: Record<string, unknown>;
    status?: MemoryStatus | MemoryStatus[];
    categories?: MemoryCategory[];
  };
  sort?: "recency" | "use_count" | "created_at";
  limit?: number;
  offset?: number;
}

export interface FindSimilarArgs {
  containerTag: string;
  content: string;
  limit?: number;
  threshold?: number;
  statuses?: MemoryStatus[];
}

export interface UpdateMemoryArgs {
  containerTag: string;
  id: string;
  content?: string;
  metadata?: Record<string, unknown>;
  category?: MemoryCategory;
  eventDate?: Date | null;
  eventDatePrecision?: string | null;
  confidence?: number;
}

export interface SearchArgs {
  containerTag: string;
  query: string;
  limit?: number;
  /** When true, include source chunks for each memory hit. Defaults to true. */
  includeChunks?: boolean;
  /**
   * When true, pull one-hop edge neighbours for each top hit and return them
   * under `relatedMemories`. Defaults to false — the caller opts in because
   * graph expansion adds a join and a small amount of payload.
   */
  expandGraph?: boolean;
  /**
   * Phase 5: explicit temporal filter. When provided, the search restricts
   * candidates to memories whose document_date or event_date falls inside the
   * window. Use `from` / `to` as `null` for an open bound. Memories with a
   * null event_date are kept (they're "timeless") when filtering on event_date.
   *
   * If omitted and the SDK has an LLM client configured, MemCore runs the
   * temporal parser against the query and applies any inferred range. Pass
   * `null` to disable both the parser and any auto-detected range.
   */
  dateRange?: DateRange | null;
  /**
   * Phase 6: when true (the default), MemCore checks whether the query is
   * profile-relevant ("what do you know about me?") and, if a profile row
   * exists for the container, attaches it to the response under `profile`.
   * Pass false to skip the heuristic and never inject the profile.
   */
  includeProfile?: boolean;
  /**
   * Server-side filters applied to the candidate pool before rerank.
   * `metadata` is a JSONB containment filter (`@>`), `status` restricts to
   * the given lifecycle states (default `["active"]`), `categories` whitelists
   * memory categories. Use these to support typed-memory queries like "all
   * active feedback memories tagged team=growth" without overfetching.
   */
  filters?: {
    metadata?: Record<string, unknown>;
    status?: MemoryStatus | MemoryStatus[];
    categories?: MemoryCategory[];
  };
  /**
   * When true (the default), MemCore bumps `use_count` and `last_used_at` on
   * every memory it returns. Set false for read-only inspection paths that
   * shouldn't influence usage stats.
   */
  recordUse?: boolean;
}

export interface SearchProfileEnvelope {
  content: string;
  version: number;
  generatedAt: Date;
  sourceMemoryCount: number;
}

export interface SearchResult {
  memory: MemoryHit;
  score: number;
  /** Populated when the search was called with `expandGraph: true`; otherwise []. */
  relatedMemories: RelatedMemory[];
}

export interface SearchResponse {
  results: SearchResult[];
  /**
   * Profile envelope, populated when the query was profile-relevant and a
   * profile row exists for the container. Null otherwise. The profile is a
   * narrative summary of the user's durable traits — see Phase 6 in ROADMAP.
   */
  profile?: SearchProfileEnvelope | null;
  queryMetadata: {
    totalCandidates: number;
    latencyMs: number;
    /** Range that was applied to the candidate set, if any. */
    dateRange?: DateRange | null;
    /**
     * True when MemCore decided the query is unanswerable from memory: either
     * no candidates survived RRF / temporal filtering, or the strongest
     * vector-search hit's cosine similarity was below `abstainSimilarityFloor`.
     * Callers should treat this as "no relevant memories" and answer the user
     * directly rather than fabricating from a thin context.
     */
    shouldAbstain: boolean;
    /**
     * The reason for `shouldAbstain`. `null` when shouldAbstain is false.
     * `"no_candidates"` when nothing survived candidate generation /
     * filtering. `"low_similarity"` when the top vector hit was below the
     * abstain floor. Useful for telemetry and tuning.
     */
    abstainReason: "no_candidates" | "low_similarity" | null;
    /** True when the profile-relevance heuristic fired on this query. */
    profileRelevant: boolean;
  };
}

const DEFAULT_EXTRACTION_MODEL = "gpt-4o-mini";
const DEFAULT_CONTEXTUALIZER_MODEL = "gpt-4o-mini";
const DEFAULT_CONFLICT_MODEL = "gpt-4o-mini";
const DEFAULT_TEMPORAL_PARSER_MODEL = "gpt-4o-mini";
const DEFAULT_PROFILE_GENERATOR_MODEL = "gpt-4o-mini";
const DEFAULT_RERANKER_MODEL = "rerank-v3.5";
const DEFAULT_ABSTAIN_SIMILARITY_FLOOR = 0.3;

const HYBRID_VECTOR_TOPK = 50;
const HYBRID_KEYWORD_TOPK = 50;
const HYBRID_FUSED_TOPK = 30;

export class MemCore {
  /** SDK version, sourced from package.json. Bump in package.json, not here. */
  static readonly version: string = VERSION;
  /** Instance accessor mirroring `MemCore.version` so server / client code can log it. */
  readonly version: string = VERSION;
  readonly costTracker: CostTracker;
  private readonly sql: postgres.Sql;
  private readonly embedder: Embedder;
  private readonly llmClient: LLMClient | null;
  private readonly extractionModel: string;
  private readonly contextualizerModel: string;
  private readonly conflictModel: string;
  private readonly temporalParserModel: string;
  private readonly conflictSimilarityThreshold: number | undefined;
  private readonly conflictTopK: number | undefined;
  private readonly reranker: Reranker;
  private readonly chunkOptions: { targetTokens: number; minTokens: number };
  private readonly profileGeneratorModel: string;
  private readonly profileMaxMemories: number | undefined;
  private readonly abstainSimilarityFloor: number;

  constructor(opts: MemCoreOptions) {
    if (!opts.databaseUrl) throw new ValidationError("databaseUrl is required");

    this.sql = postgres(opts.databaseUrl, {
      onnotice: () => {},
    });

    this.costTracker = new CostTracker();

    const apiKey = opts.embeddingApiKey ?? opts.openaiApiKey;
    const baseUrl = opts.embeddingBaseUrl;

    const baseEmbedder: Embedder =
      opts.embedder ??
      (apiKey
        ? new OpenAIEmbedder({
            apiKey,
            model: opts.embeddingModel ?? "text-embedding-3-large",
            ...(baseUrl ? { baseUrl } : {}),
          })
        : new StubEmbedder(opts.embeddingDim ?? 3072));

    if (!opts.embedder && !apiKey) {
      logger.warn(
        "No embedder injected and no embedding API key set; falling back to " +
          "StubEmbedder. Retrieval results will be meaningless. Set " +
          "OPENAI_API_KEY or EMBEDDING_API_KEY (with EMBEDDING_BASE_URL for " +
          "self-hosted endpoints like LMStudio).",
      );
    }

    this.embedder = new TrackedEmbedder(baseEmbedder, this.costTracker);

    this.extractionModel = opts.extractionModel ?? DEFAULT_EXTRACTION_MODEL;
    this.contextualizerModel = opts.contextualizerModel ?? DEFAULT_CONTEXTUALIZER_MODEL;
    this.conflictModel = opts.conflictModel ?? DEFAULT_CONFLICT_MODEL;
    this.temporalParserModel = opts.temporalParserModel ?? DEFAULT_TEMPORAL_PARSER_MODEL;
    this.profileGeneratorModel = opts.profileGeneratorModel ?? DEFAULT_PROFILE_GENERATOR_MODEL;
    this.profileMaxMemories = opts.profileMaxMemories;
    this.abstainSimilarityFloor = opts.abstainSimilarityFloor ?? DEFAULT_ABSTAIN_SIMILARITY_FLOOR;
    this.conflictSimilarityThreshold = opts.conflictSimilarityThreshold;
    this.conflictTopK = opts.conflictTopK;

    const llmKey = opts.openaiApiKey;
    if (opts.llmClient) {
      this.llmClient = new TrackedLLMClient(opts.llmClient, this.costTracker);
    } else if (llmKey) {
      const inner = new OpenAILLMClient({
        apiKey: llmKey,
        defaultModel: this.extractionModel,
        ...(opts.llmBaseUrl ? { baseUrl: opts.llmBaseUrl } : {}),
      });
      this.llmClient = new TrackedLLMClient(inner, this.costTracker);
    } else {
      logger.warn(
        "No LLM client injected and no OPENAI_API_KEY set; ingestion will " +
          "run in chunk-only mode and no memories will be extracted. Search " +
          "will return nothing until memories exist.",
      );
      this.llmClient = null;
    }

    this.chunkOptions = {
      targetTokens: opts.chunkMaxTokens ?? 800,
      minTokens: opts.chunkMinTokens ?? 100,
    };

    if (opts.reranker) {
      this.reranker = opts.reranker;
    } else if (opts.cohereApiKey) {
      this.reranker = new CohereReranker({
        apiKey: opts.cohereApiKey,
        model: opts.rerankerModel ?? DEFAULT_RERANKER_MODEL,
      });
    } else {
      this.reranker = new PassthroughReranker();
    }
  }

  /** Ingest content into memory. Returns the conversation id and ingestion status. */
  async add(args: AddArgs): Promise<IngestResult> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (args.content == null && args.messages == null) {
      throw new ValidationError("either 'content' or 'messages' is required");
    }
    if (args.content != null && args.messages != null) {
      throw new ValidationError("provide only one of 'content' or 'messages'");
    }

    // Direct-add path: caller already has a finished memory body and doesn't
    // want extraction. Skip chunking, extraction, and conflict detection;
    // write a single row and return it. The id in the returned `memories` is
    // stable — callers can adopt it as their primary key.
    if (args.extract === false) {
      if (args.content == null) {
        throw new ValidationError("'content' is required when extract:false");
      }
      if (!args.category) {
        throw new ValidationError("'category' is required when extract:false");
      }
      if (!isMemoryCategory(args.category)) {
        throw new ValidationError(`unknown category: ${args.category}`);
      }
      const embeddingResponse = await this.embedder.embed({ texts: [args.content] });
      const vector = embeddingResponse.vectors[0];
      if (!vector) throw new ValidationError("embedder returned no vector");
      const inserted = await insertMemory(this.sql, {
        containerTag: args.containerTag,
        content: args.content,
        embedding: vector,
        category: args.category,
        documentDate: args.documentDate ?? null,
        confidence: args.confidence ?? 1.0,
        metadata: args.metadata ?? {},
        promptVersion: "manual",
        extractorModel: "manual",
      });
      return {
        conversationId: "",
        ingestionStatus: "complete",
        chunksWritten: 0,
        memoriesWritten: 1,
        edgesWritten: 0,
        memoriesSuperseded: 0,
        duplicatesSkipped: 0,
        memories: [
          {
            id: inserted.id,
            content: inserted.content,
            category: inserted.category,
            status: inserted.status,
            confidence: inserted.confidence,
          },
        ],
      };
    }

    const ingestArgs: IngestArgs = {
      containerTag: args.containerTag,
      sourceType: args.sourceType ?? (args.messages ? "conversation" : "document"),
      content: args.content ?? "",
      externalId: args.externalId,
      documentDate: args.documentDate,
      messages: args.messages,
      metadata: args.metadata,
    };

    return ingest(
      {
        sql: this.sql,
        embedder: this.embedder,
        chunkOptions: this.chunkOptions,
        ...(this.llmClient
          ? {
              extractor: { llm: this.llmClient, model: this.extractionModel },
              contextualizer: { llm: this.llmClient, model: this.contextualizerModel },
              conflictDetector: {
                llm: this.llmClient,
                model: this.conflictModel,
                ...(this.conflictTopK !== undefined ? { topK: this.conflictTopK } : {}),
                ...(this.conflictSimilarityThreshold !== undefined
                  ? { similarityThreshold: this.conflictSimilarityThreshold }
                  : {}),
              },
            }
          : {}),
      },
      ingestArgs,
    );
  }

  /**
   * Search memory. Phase 6 pipeline:
   *   0. Parse temporal scope (skipped when an explicit dateRange is supplied
   *      or the caller passed `null` to opt out, or no LLM is configured).
   *      In parallel, run the profile-relevance heuristic on the query.
   *   1. Embed the query.
   *   2. Vector search (top 50) and keyword search (top 50) in parallel.
   *   3. Fuse with RRF; take top 30.
   *   4. Apply temporal filter (when active).
   *   5. Cross-encoder rerank to top `limit`.
   *   6. Join source chunks if requested.
   *   7. If the query was profile-relevant, attach the container's profile.
   *   8. Compute `shouldAbstain` from the candidate pool and the top vector
   *      similarity.
   */
  async search(args: SearchArgs): Promise<SearchResponse> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (!args.query?.trim()) throw new ValidationError("query is required");
    const limit = args.limit ?? 10;
    const includeChunks = args.includeChunks ?? true;
    const includeGraph = args.expandGraph ?? false;
    const includeProfile = args.includeProfile ?? true;
    // Caller passed an explicit `null` — disable both auto-parse and any range.
    const callerDisabledTemporal = args.dateRange === null;
    const callerProvidedRange = args.dateRange ?? null;

    const profileMatch = isProfileRelevant(args.query);

    const start = performance.now();

    const containerRow = await this.sql<{ id: string }[]>`
      SELECT id FROM containers WHERE tag = ${args.containerTag} LIMIT 1
    `;
    if (!containerRow[0]) {
      return {
        results: [],
        profile: null,
        queryMetadata: {
          totalCandidates: 0,
          latencyMs: Math.round(performance.now() - start),
          shouldAbstain: true,
          abstainReason: "no_candidates",
          profileRelevant: profileMatch.isRelevant,
        },
      };
    }
    const containerId = containerRow[0].id;

    // Embed the query and (optionally) parse temporal scope in parallel. The
    // explicit caller-supplied range always wins; the parser only runs when
    // there's none and the caller didn't opt out and we have an LLM.
    const shouldParseTemporal =
      !callerDisabledTemporal && callerProvidedRange === null && this.llmClient !== null;

    const [embeddingResponse, parsedRange] = await Promise.all([
      this.embedder.embed({ texts: [args.query] }),
      shouldParseTemporal && this.llmClient
        ? parseTemporalScope(
            { llm: this.llmClient, model: this.temporalParserModel },
            { query: args.query },
          )
        : Promise.resolve(null),
    ]);
    const queryVector = embeddingResponse.vectors[0];
    if (!queryVector) throw new ValidationError("embedder returned no vector for query");

    const activeRange: DateRange | null = callerProvidedRange ?? parsedRange ?? null;

    const filterStatuses = (() => {
      const s = args.filters?.status;
      if (!s) return undefined;
      return Array.isArray(s) ? s : [s];
    })();
    const searchFilters = args.filters
      ? {
          ...(filterStatuses ? { statuses: filterStatuses } : {}),
          ...(args.filters.categories ? { categories: args.filters.categories } : {}),
          ...(args.filters.metadata ? { metadata: args.filters.metadata } : {}),
        }
      : undefined;

    const [vectorHits, keywordHits, profileRow] = await Promise.all([
      vectorSearchMemories(this.sql, {
        containerId,
        queryVector,
        limit: HYBRID_VECTOR_TOPK,
        includeChunks: false,
        ...(searchFilters ? { filters: searchFilters } : {}),
      }),
      keywordSearchMemories(this.sql, {
        containerId,
        query: args.query,
        limit: HYBRID_KEYWORD_TOPK,
        ...(searchFilters ? { filters: searchFilters } : {}),
      }),
      includeProfile && profileMatch.isRelevant
        ? getProfileByContainer(this.sql, containerId)
        : Promise.resolve(null),
    ]);

    const topVectorSimilarity = vectorHits[0]?.score ?? 0;
    const profileEnvelope: SearchProfileEnvelope | null = profileRow
      ? {
          content: profileRow.content,
          version: profileRow.version,
          generatedAt: profileRow.generatedAt,
          sourceMemoryCount: profileRow.sourceMemoryCount,
        }
      : null;

    // Track content per memory id so the reranker has text to score against
    // without a second round-trip.
    const contentById = new Map<string, string>();
    for (const h of vectorHits) contentById.set(h.id, h.content);
    for (const h of keywordHits) contentById.set(h.id, h.content);

    const fused = fuseRanks([vectorHits.map((h) => h.id), keywordHits.map((h) => h.id)], {
      limit: HYBRID_FUSED_TOPK,
    });

    if (fused.length === 0) {
      return {
        results: [],
        profile: profileEnvelope,
        queryMetadata: {
          totalCandidates: 0,
          latencyMs: Math.round(performance.now() - start),
          dateRange: activeRange,
          shouldAbstain: true,
          abstainReason: "no_candidates",
          profileRelevant: profileMatch.isRelevant,
        },
      };
    }

    // Apply the temporal filter post-RRF, pre-rerank: rerank is the dominant
    // cost and we want to feed it only the candidates that survived the date
    // window. Memories with NULL event_date are kept for event_date filters
    // (timeless facts). See temporal-filter.ts for the full rule.
    let surviving = fused.map((f) => f.id);
    if (activeRange) {
      surviving = await filterByDateRange(this.sql, {
        containerId,
        candidateIds: surviving,
        range: activeRange,
      });
    }

    if (surviving.length === 0) {
      return {
        results: [],
        profile: profileEnvelope,
        queryMetadata: {
          totalCandidates: fused.length,
          latencyMs: Math.round(performance.now() - start),
          dateRange: activeRange,
          shouldAbstain: true,
          abstainReason: "no_candidates",
          profileRelevant: profileMatch.isRelevant,
        },
      };
    }

    // Cross-encoder rerank.
    const rerankInput = surviving.map((id) => ({
      id,
      text: contentById.get(id) ?? "",
    }));
    const reranked = await this.reranker.rerank({
      query: args.query,
      documents: rerankInput,
      topN: limit,
    });

    if (reranked.length === 0) {
      return {
        results: [],
        profile: profileEnvelope,
        queryMetadata: {
          totalCandidates: fused.length,
          latencyMs: Math.round(performance.now() - start),
          dateRange: activeRange,
          shouldAbstain: true,
          abstainReason: "no_candidates",
          profileRelevant: profileMatch.isRelevant,
        },
      };
    }

    // Hydrate full memory rows + chunks for the survivors. Graph expansion
    // runs in parallel with the chunk join — both touch independent tables.
    const winnerIds = reranked.map((r) => r.id);
    const [memoryMap, chunkMap, relatedMap] = await Promise.all([
      fetchMemoriesByIds(this.sql, containerId, winnerIds),
      includeChunks ? joinChunksForMemories(this.sql, winnerIds) : Promise.resolve(new Map()),
      includeGraph
        ? expandGraph(this.sql, containerId, winnerIds)
        : Promise.resolve(new Map<string, RelatedMemory[]>()),
    ]);

    const results: SearchResult[] = [];
    for (const r of reranked) {
      const m = memoryMap.get(r.id);
      if (!m) continue;
      const memory: MemoryHit = {
        ...m,
        score: r.score,
        chunks: chunkMap.get(r.id) ?? [],
      };
      results.push({
        memory,
        score: r.score,
        relatedMemories: relatedMap.get(r.id) ?? [],
      });
    }

    // Phase 6 abstain: even with non-empty results, the answer may be junk
    // when the strongest vector hit is far from the query. The threshold is
    // tuned to OpenAI embeddings (~0.3 = "vaguely related"); set to 0 in
    // options to disable this gate. Profile-relevant queries skip the floor —
    // the profile itself is the relevant return, regardless of how the
    // memory pool scored.
    const lowSimilarity =
      this.abstainSimilarityFloor > 0 &&
      topVectorSimilarity < this.abstainSimilarityFloor &&
      !profileMatch.isRelevant;

    // Bump use_count + last_used_at on the rows we're about to return. Fire
    // and forget — a tracking failure must not block the search response.
    if ((args.recordUse ?? true) && !lowSimilarity && results.length > 0) {
      const idsToBump = results.map((r) => r.memory.id);
      recordMemoryUse(this.sql, args.containerTag, idsToBump).catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : err }, "record_memory_use_failed");
      });
    }

    return {
      results: lowSimilarity ? [] : results,
      profile: profileEnvelope,
      queryMetadata: {
        totalCandidates: fused.length,
        latencyMs: Math.round(performance.now() - start),
        dateRange: activeRange,
        shouldAbstain: lowSimilarity,
        abstainReason: lowSimilarity ? "low_similarity" : null,
        profileRelevant: profileMatch.isRelevant,
      },
    };
  }

  /**
   * Build (or rebuild) the profile for a container. Pulls every active memory,
   * runs the profile prompt, and upserts a single `profiles` row. Returns null
   * when the container has no memories yet, or when no LLM client is
   * configured (the profile generator needs an LLM round-trip).
   *
   * Intended to run on a schedule (cron, BullMQ repeat job, etc.) rather than
   * inline with each search — generation is the dominant cost. Callers can
   * trigger it manually after a long ingestion to refresh the profile sooner.
   */
  async buildProfile(args: { containerTag: string; now?: Date }): Promise<ProfileRecord | null> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (!this.llmClient) {
      logger.warn({ containerTag: args.containerTag }, "build_profile_skipped_no_llm_client");
      return null;
    }
    const containerRow = await this.sql<{ id: string }[]>`
      SELECT id FROM containers WHERE tag = ${args.containerTag} LIMIT 1
    `;
    if (!containerRow[0]) return null;
    const containerId = containerRow[0].id;
    return generateProfile(
      this.sql,
      {
        llm: this.llmClient,
        model: this.profileGeneratorModel,
        ...(this.profileMaxMemories !== undefined ? { maxMemories: this.profileMaxMemories } : {}),
      },
      { containerId, ...(args.now ? { now: args.now } : {}) },
    );
  }

  /** Fetch the stored profile for a container, or null if none has been built. */
  async getProfile(args: { containerTag: string }): Promise<ProfileRecord | null> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    const containerRow = await this.sql<{ id: string }[]>`
      SELECT id FROM containers WHERE tag = ${args.containerTag} LIMIT 1
    `;
    if (!containerRow[0]) return null;
    return getProfileByContainer(this.sql, containerRow[0].id);
  }

  /**
   * Fetch a single memory by id, scoped to a container. Returns `null` when
   * the id doesn't exist or doesn't belong to that container.
   */
  async get(args: { containerTag: string; id: string }): Promise<MemoryRow | null> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (!args.id) throw new ValidationError("id is required");
    return getMemoryById(this.sql, args.containerTag, args.id);
  }

  /**
   * Return memories matching a filter. No query string — this is the eager-
   * block / typed-memory-list path. Default sort is recency (most recently
   * updated first), which is what an agent prompt usually wants.
   */
  async list(args: ListMemoriesArgs): Promise<MemoryRow[]> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    const repoArgs: RepoListMemoriesArgs = {
      containerTag: args.containerTag,
      ...(args.filters ? { filters: args.filters } : {}),
      ...(args.sort ? { sort: args.sort } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    };
    return listMemories(this.sql, repoArgs);
  }

  /**
   * Pre-write duplicate detection. Embeds the candidate content, runs vector
   * search against the container's memories, and returns matches above the
   * threshold without writing anything. Use this before calling
   * `add({ extract: false })` if the caller wants to dedupe.
   */
  async findSimilar(args: FindSimilarArgs): Promise<SimilarMemoryHit[]> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (!args.content?.trim()) throw new ValidationError("content is required");
    const embeddingResponse = await this.embedder.embed({ texts: [args.content] });
    const vector = embeddingResponse.vectors[0];
    if (!vector) throw new ValidationError("embedder returned no vector");
    const repoArgs: RepoFindSimilarArgs = {
      containerTag: args.containerTag,
      embedding: vector,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
      ...(args.statuses ? { statuses: args.statuses } : {}),
    };
    return findSimilarMemories(this.sql, repoArgs);
  }

  /**
   * Edit a single memory row. When `content` changes the row is re-embedded
   * and `version` is bumped. Metadata-only edits leave the embedding alone.
   * Throws `NotFoundError` when the id doesn't exist in the container.
   */
  async update(args: UpdateMemoryArgs): Promise<MemoryRow> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (!args.id) throw new ValidationError("id is required");

    let embedding: number[] | undefined;
    if (args.content !== undefined) {
      const embeddingResponse = await this.embedder.embed({ texts: [args.content] });
      const vector = embeddingResponse.vectors[0];
      if (!vector) throw new ValidationError("embedder returned no vector");
      embedding = vector;
    }
    return updateMemory(this.sql, {
      containerTag: args.containerTag,
      id: args.id,
      ...(args.content !== undefined ? { content: args.content } : {}),
      ...(embedding ? { embedding } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      ...(args.category !== undefined ? { category: args.category } : {}),
      ...(args.eventDate !== undefined ? { eventDate: args.eventDate } : {}),
      ...(args.eventDatePrecision !== undefined
        ? { eventDatePrecision: args.eventDatePrecision }
        : {}),
      ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
    });
  }

  /**
   * Soft-archive a memory: flips `status` to `archived`. Removed from search
   * results but the row is retained for audit. Throws `NotFoundError` when
   * the id doesn't exist in the container.
   */
  async archive(args: { containerTag: string; id: string }): Promise<MemoryRow> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (!args.id) throw new ValidationError("id is required");
    return archiveMemory(this.sql, args.containerTag, args.id);
  }

  /**
   * Bump `use_count` and stamp `last_used_at` for the given memory id(s).
   * Called automatically by `search()` for returned hits unless the caller
   * passes `recordUse: false`. Useful for callers who consume memories
   * outside the search path (e.g. a system-prompt eager block) and still
   * want usage stats to reflect actual use.
   */
  async recordUse(args: { containerTag: string; ids: string | string[] }): Promise<void> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    const ids = Array.isArray(args.ids) ? args.ids : [args.ids];
    if (ids.length === 0) return;
    await recordMemoryUse(this.sql, args.containerTag, ids);
  }

  /** Health check. Resolves with `true` when the database is reachable. */
  async ping(): Promise<boolean> {
    const rows = await this.sql<{ ok: number }[]>`SELECT 1 AS ok`;
    return rows[0]?.ok === 1;
  }

  /** Tear down the connection pool. Call on process shutdown. */
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
