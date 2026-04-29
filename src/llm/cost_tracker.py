"""Per-call usage and cost accounting.

Phase 0 keeps this minimal: token counts and a coarse $/1M-token estimate per
model. Real billing comes from the provider; this exists for ingestion-cost
budgeting (DESIGN.md § Performance targets) and per-request observability.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock

from src.llm.types import TokenUsage

# USD per 1M tokens. (input, output) for chat; (input, 0) for embeddings.
# Update as prices change. Unknown models incur 0 — log a warning at call site
# rather than guessing here.
_RATES: dict[str, tuple[float, float]] = {
    # Anthropic
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-opus-4-7": (15.00, 75.00),
    # OpenAI
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    # Embeddings
    "text-embedding-3-large": (0.13, 0.0),
    "text-embedding-3-small": (0.02, 0.0),
}


@dataclass(frozen=True)
class CostRecord:
    model: str
    usage: TokenUsage

    @property
    def cost_usd(self) -> float:
        rates = _RATES.get(self.model)
        if rates is None:
            return 0.0
        in_rate, out_rate = rates
        # Cache reads/writes are billed differently in practice, but for a
        # rough estimate we treat them as input tokens.
        billed_input = (
            self.usage.input_tokens + self.usage.cache_read_tokens + self.usage.cache_write_tokens
        )
        return (billed_input * in_rate + self.usage.output_tokens * out_rate) / 1_000_000


@dataclass
class CostTracker:
    """Aggregates per-call usage. Thread-safe; one instance per request or job."""

    records: list[CostRecord] = field(default_factory=list)
    _lock: Lock = field(default_factory=Lock, repr=False)

    def record(self, *, model: str, usage: TokenUsage) -> None:
        with self._lock:
            self.records.append(CostRecord(model=model, usage=usage))

    @property
    def total_cost_usd(self) -> float:
        return sum(r.cost_usd for r in self.records)

    @property
    def total_input_tokens(self) -> int:
        return sum(r.usage.input_tokens for r in self.records)

    @property
    def total_output_tokens(self) -> int:
        return sum(r.usage.output_tokens for r in self.records)
