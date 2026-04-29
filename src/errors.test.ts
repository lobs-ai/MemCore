import { describe, expect, it } from "vitest";
import {
  ChunkingError,
  ConfigError,
  EmbeddingError,
  ExtractionError,
  IngestionError,
  LLMError,
  MemCoreError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  RetrievalError,
  ValidationError,
} from "./errors.js";

describe("MemCoreError hierarchy", () => {
  it("base error carries default code/status and merges details", () => {
    const err = new MemCoreError("boom", { reason: "x" });
    expect(err.message).toBe("boom");
    expect(err.code).toBe("internal_error");
    expect(err.httpStatus).toBe(500);
    expect(err.details).toEqual({ reason: "x" });
    expect(err.name).toBe("MemCoreError");
    expect(err instanceof Error).toBe(true);
  });

  it("defaults details to {} when omitted", () => {
    expect(new MemCoreError("oops").details).toEqual({});
  });

  it.each([
    [ValidationError, "validation_error", 400, "ValidationError"],
    [NotFoundError, "not_found", 404, "NotFoundError"],
    [ConfigError, "config_error", 500, "ConfigError"],
    [IngestionError, "ingestion_error", 500, "IngestionError"],
    [ChunkingError, "chunking_error", 500, "ChunkingError"],
    [ExtractionError, "extraction_error", 500, "ExtractionError"],
    [EmbeddingError, "embedding_error", 500, "EmbeddingError"],
    [RetrievalError, "retrieval_error", 500, "RetrievalError"],
    [LLMError, "llm_error", 503, "LLMError"],
    [RateLimitError, "rate_limit", 429, "RateLimitError"],
    [ProviderError, "provider_error", 503, "ProviderError"],
  ])("%p maps to %s/%i and is a MemCoreError", (Cls, code, status, name) => {
    const err = new Cls("msg", { k: 1 });
    expect(err).toBeInstanceOf(MemCoreError);
    expect(err.code).toBe(code);
    expect(err.httpStatus).toBe(status);
    expect(err.details).toEqual({ k: 1 });
    expect(err.name).toBe(name);
  });
});
