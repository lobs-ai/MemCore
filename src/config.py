"""Application configuration loaded from the environment.

All knobs the system exposes live here. New env vars are documented in
SPEC.md § Configuration first, then mirrored in this file and `.env.example`.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, PostgresDsn, RedisDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Storage
    database_url: PostgresDsn
    redis_url: RedisDsn

    # LLM providers (at least one of anthropic/openai must be set in practice).
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    cohere_api_key: str | None = None

    # Models
    embedding_model: str = "text-embedding-3-large"
    embedding_dim: int = 3072
    extraction_model: str = "claude-haiku-4-5"
    conflict_model: str = "claude-sonnet-4-6"
    contextualizer_model: str = "claude-haiku-4-5"
    reranker_provider: Literal["cohere", "local"] = "cohere"

    # Ingestion
    session_inactivity_minutes: int = 30
    session_length_threshold: int = 20
    chunk_min_tokens: int = 100
    chunk_max_tokens: int = 800
    chunk_topic_shift_threshold: float = 0.35

    # Retrieval
    rrf_k: int = 60

    # Logging
    log_level: str = "INFO"

    # Dev
    environment: Literal["development", "test", "production"] = "development"
    api_key_dev: str = Field(default="dev-key", description="Bearer token accepted in dev mode.")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
