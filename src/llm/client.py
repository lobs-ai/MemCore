"""LLM client protocol.

This module defines the *contract* every caller depends on. Implementations
live outside this package — typically a thin adapter around the user's
`@agentic/llm` client, a fake for tests, etc. — and are injected at wiring
time. There is no singleton, no env-driven construction, no provider SDK
import in this module.

AGENTS.md says "all LLM calls go through `src/llm/client.py`" — that means
through this protocol. Application code should depend on `LLMClient`, not on
a concrete provider.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from src.llm.cost_tracker import CostTracker
from src.llm.types import (
    CreateMessageParams,
    LLMResponse,
    TokenUsage,
)
from src.logging import get_logger

logger = get_logger("llm.client")


@runtime_checkable
class LLMClient(Protocol):
    """Provider-agnostic chat client.

    `create_message` is required. `stream_message` is optional; callers should
    fall back to `create_message` when streaming is not implemented.
    """

    async def create_message(self, params: CreateMessageParams) -> LLMResponse: ...


class TrackedLLMClient:
    """Composable wrapper that records per-call usage on a `CostTracker`.

    Use this at the wiring layer to add observability to any `LLMClient` without
    touching the underlying implementation:

        client = TrackedLLMClient(my_agentic_adapter, tracker)
    """

    def __init__(self, inner: LLMClient, tracker: CostTracker) -> None:
        self._inner = inner
        self.tracker = tracker

    async def create_message(self, params: CreateMessageParams) -> LLMResponse:
        logger.debug("llm_call", model=params.model, message_count=len(params.messages))
        response = await self._inner.create_message(params)
        self.tracker.record(model=params.model, usage=response.usage)
        return response


__all__ = ["LLMClient", "TokenUsage", "TrackedLLMClient"]
