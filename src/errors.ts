/**
 * Custom error hierarchy.
 *
 * Mirrors SPEC.md § Errors. Throw these — never `throw new Error(...)` from
 * application code. The HTTP layer maps them to status codes in the Fastify
 * error handler.
 */

export class MemCoreError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details ?? {};
    this.code = "internal_error";
    this.httpStatus = 500;
  }
}

function err(code: string, httpStatus: number) {
  return class extends MemCoreError {
    constructor(message: string, details?: Record<string, unknown>) {
      super(message, details);
      (this as { code: string }).code = code;
      (this as { httpStatus: number }).httpStatus = httpStatus;
    }
  };
}

export class ValidationError extends err("validation_error", 400) {}
export class NotFoundError extends err("not_found", 404) {}
export class ConfigError extends err("config_error", 500) {}
export class IngestionError extends err("ingestion_error", 500) {}
export class ChunkingError extends err("chunking_error", 500) {}
export class ExtractionError extends err("extraction_error", 500) {}
export class EmbeddingError extends err("embedding_error", 500) {}
export class RetrievalError extends err("retrieval_error", 500) {}
export class LLMError extends err("llm_error", 503) {}
export class RateLimitError extends err("rate_limit", 429) {}
export class ProviderError extends err("provider_error", 503) {}
