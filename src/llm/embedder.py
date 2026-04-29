"""Embedding client protocol.

Separate from `LLMClient` because the chat and embedding APIs have different
shapes and are usually backed by different services. Like `LLMClient`, this is
an injectable interface — wire a concrete implementation at startup.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from src.llm.cost_tracker import CostTracker
from src.llm.types import EmbeddingResponse


@runtime_checkable
class Embedder(Protocol):
    async def embed(self, *, texts: list[str]) -> EmbeddingResponse: ...


class TrackedEmbedder:
    """Wrap any `Embedder` to record usage on a `CostTracker`."""

    def __init__(self, inner: Embedder, tracker: CostTracker) -> None:
        self._inner = inner
        self.tracker = tracker

    async def embed(self, *, texts: list[str]) -> EmbeddingResponse:
        response = await self._inner.embed(texts=texts)
        self.tracker.record(model=response.model, usage=response.usage)
        return response


__all__ = ["Embedder", "TrackedEmbedder"]
