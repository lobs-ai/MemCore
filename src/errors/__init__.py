"""Custom exception hierarchy.

Mirrors SPEC.md § Errors. Raise these — never `raise Exception(...)` from
application code. The HTTP layer maps these to status codes in `src/api/main.py`.
"""

from __future__ import annotations

from typing import Any


class MemCoreError(Exception):
    """Base class for every error raised by application code."""

    code: str = "internal_error"
    http_status: int = 500

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class ValidationError(MemCoreError):
    code = "validation_error"
    http_status = 400


class NotFoundError(MemCoreError):
    code = "not_found"
    http_status = 404


class ConfigError(MemCoreError):
    code = "config_error"
    http_status = 500


class IngestionError(MemCoreError):
    code = "ingestion_error"
    http_status = 500


class ChunkingError(IngestionError):
    code = "chunking_error"


class ExtractionError(IngestionError):
    code = "extraction_error"


class EmbeddingError(IngestionError):
    code = "embedding_error"


class RetrievalError(MemCoreError):
    code = "retrieval_error"
    http_status = 500


class LLMError(MemCoreError):
    code = "llm_error"
    http_status = 503


class RateLimitError(LLMError):
    code = "rate_limit"
    http_status = 429


class ProviderError(LLMError):
    code = "provider_error"
    http_status = 503


__all__ = [
    "ChunkingError",
    "ConfigError",
    "EmbeddingError",
    "ExtractionError",
    "IngestionError",
    "LLMError",
    "NotFoundError",
    "ProviderError",
    "RateLimitError",
    "RetrievalError",
    "MemCoreError",
    "ValidationError",
]
