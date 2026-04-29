/**
 * MemCore — public SDK class.
 *
 * Embed this in your own process to call ingestion and search directly,
 * without an HTTP hop. The Fastify server in `src/api/` is a thin wrapper
 * around an instance of this class. Both share the same surface area.
 *
 *   const memcore = new MemCore({
 *     databaseUrl: "postgresql://...",
 *     embedder: myEmbedder, // optional — defaults to OpenAI from env
 *   });
 *   await memcore.add({ containerTag: "user_42", content: "..." });
 *   const { results } = await memcore.search({ containerTag: "user_42", query: "..." });
 *   await memcore.close();
 */

import postgres from "postgres";

import { ValidationError } from "./errors.js";
import { type IngestArgs, type IngestResult, ingest } from "./ingestion/pipeline.js";
import { CostTracker } from "./llm/cost-tracker.js";
import { type Embedder, TrackedEmbedder } from "./llm/embedder.js";
import { OpenAIEmbedder } from "./llm/openai-embedder.js";
import { StubEmbedder } from "./llm/stub-embedder.js";
import { getLogger } from "./logging.js";
import { type ChunkHit, vectorSearchChunks } from "./retrieval/vector-search.js";

const logger = getLogger("memcore");

export interface MemCoreOptions {
  /** Postgres connection string. Required. */
  databaseUrl: string;
  /**
   * Embedder implementation. When omitted, MemCore builds the default OpenAI-
   * compatible embedder using `embeddingApiKey` / `openaiApiKey` and
   * `embeddingBaseUrl`. Pass any object satisfying `Embedder` to plug in a
   * different provider (Cohere via custom adapter, a local model, etc.).
   */
  embedder?: Embedder;
  /**
   * Base URL for the default embedder. Defaults to `https://api.openai.com/v1`.
   * Set to `http://localhost:1234/v1` for LMStudio, `http://localhost:11434/v1`
   * for Ollama, or any other OpenAI-compatible endpoint.
   */
  embeddingBaseUrl?: string;
  /**
   * API key for the default embedder. Falls back to `openaiApiKey`. LMStudio
   * accepts any string; OpenAI requires a real key.
   */
  embeddingApiKey?: string;
  /** Convenience alias for `embeddingApiKey` when the provider is OpenAI proper. */
  openaiApiKey?: string;
  /** Embedding model name for the default OpenAI embedder. */
  embeddingModel?: string;
  /** Embedding vector dimension. Used by the stub embedder; OpenAI ignores it. */
  embeddingDim?: number;
  /** Chunker target token count. Defaults to 800. */
  chunkMaxTokens?: number;
  /** Chunker minimum token count below which input becomes a single chunk. Defaults to 100. */
  chunkMinTokens?: number;
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
  /** When true, include chunk objects in each result. Defaults to true (Phase 1). */
  includeChunks?: boolean;
}

export interface SearchResult {
  chunk: ChunkHit;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  queryMetadata: {
    totalCandidates: number;
    latencyMs: number;
  };
}

export class MemCore {
  readonly costTracker: CostTracker;
  private readonly sql: postgres.Sql;
  private readonly embedder: Embedder;
  private readonly chunkOptions: { targetTokens: number; minTokens: number };

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

    this.chunkOptions = {
      targetTokens: opts.chunkMaxTokens ?? 800,
      minTokens: opts.chunkMinTokens ?? 100,
    };
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
      { sql: this.sql, embedder: this.embedder, chunkOptions: this.chunkOptions },
      ingestArgs,
    );
  }

  /** Search memory by similarity. Phase 1: chunk-level vector search. */
  async search(args: SearchArgs): Promise<SearchResponse> {
    if (!args.containerTag) throw new ValidationError("containerTag is required");
    if (!args.query?.trim()) throw new ValidationError("query is required");
    const limit = args.limit ?? 10;

    const start = performance.now();

    const containerRow = await this.sql<{ id: string }[]>`
      SELECT id FROM containers WHERE tag = ${args.containerTag} LIMIT 1
    `;
    if (!containerRow[0]) {
      // Unknown container is not an error — just no results.
      return {
        results: [],
        queryMetadata: { totalCandidates: 0, latencyMs: Math.round(performance.now() - start) },
      };
    }

    const embeddingResponse = await this.embedder.embed({ texts: [args.query] });
    const queryVector = embeddingResponse.vectors[0];
    if (!queryVector) throw new ValidationError("embedder returned no vector for query");

    const hits = await vectorSearchChunks(this.sql, {
      containerId: containerRow[0].id,
      queryVector,
      limit,
    });

    return {
      results: hits.map((chunk) => ({ chunk, score: chunk.score })),
      queryMetadata: {
        totalCandidates: hits.length,
        latencyMs: Math.round(performance.now() - start),
      },
    };
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
