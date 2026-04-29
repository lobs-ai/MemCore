/**
 * MemCore public package surface.
 *
 * Two integration shapes:
 *
 *   1. Embed the SDK directly:
 *        import { MemCore } from "memcore";
 *        const memcore = new MemCore({ databaseUrl, openaiApiKey });
 *        await memcore.add({ ... });
 *
 *   2. Run the HTTP server (Fastify on /v1/...):
 *        node dist/api/main.js  // or `pnpm dev`
 *
 * Both paths share the same SDK class — the server is just a thin Fastify
 * wrapper.
 */

export { MemCore } from "./memcore.js";
export type {
  MemCoreOptions,
  AddArgs,
  SearchArgs,
  SearchResult,
  SearchResponse,
} from "./memcore.js";

// LLM-side surface so callers can plug their own embedder/LLM.
export type { Embedder } from "./llm/embedder.js";
export type { LLMClient } from "./llm/client.js";
export type {
  TokenUsage,
  LLMMessage,
  LLMResponse,
  CreateMessageParams,
  EmbeddingResponse,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  StopReason,
  ToolDefinition,
} from "./llm/types.js";
export { OpenAIEmbedder, OpenAICompatibleEmbedder } from "./llm/openai-embedder.js";
export type {
  OpenAIEmbedderOptions,
  OpenAICompatibleEmbedderOptions,
} from "./llm/openai-embedder.js";
export { OpenAILLMClient, OpenAICompatibleLLMClient } from "./llm/openai-llm-client.js";
export type {
  OpenAILLMClientOptions,
  OpenAICompatibleLLMClientOptions,
} from "./llm/openai-llm-client.js";
export { TrackedLLMClient } from "./llm/client.js";
export { TrackedEmbedder } from "./llm/embedder.js";
export { StubEmbedder } from "./llm/stub-embedder.js";
export { CostTracker, type CostRecord } from "./llm/cost-tracker.js";

// Errors callers may want to catch.
export {
  MemCoreError,
  ValidationError,
  NotFoundError,
  ConfigError,
  IngestionError,
  ChunkingError,
  ExtractionError,
  EmbeddingError,
  RetrievalError,
  LLMError,
  RateLimitError,
  ProviderError,
} from "./errors.js";

// Retrieval result shapes.
export type { ChunkHit } from "./retrieval/vector-search.js";
export type { MemoryHit, ChunkRef } from "./retrieval/memory-search.js";
export type { ExtractedMemory, MemoryCategory } from "./ingestion/extractor.js";
