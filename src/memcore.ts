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

    const [vectorHits, keywordHits, profileRow] = await Promise.all([
      vectorSearchMemories(this.sql, {
        containerId,
        queryVector,
        limit: HYBRID_VECTOR_TOPK,
        includeChunks: false,
      }),
      keywordSearchMemories(this.sql, {
        containerId,
        query: args.query,
        limit: HYBRID_KEYWORD_TOPK,
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
