"""Sanity test for the cost tracker. Real LLM client tests come in later phases."""

from __future__ import annotations

from src.llm.cost_tracker import CostTracker
from src.llm.types import TokenUsage


def test_records_and_aggregates() -> None:
    tracker = CostTracker()
    tracker.record(model="claude-haiku-4-5", usage=TokenUsage(input_tokens=1000, output_tokens=500))
    tracker.record(model="claude-haiku-4-5", usage=TokenUsage(input_tokens=2000, output_tokens=100))

    assert tracker.total_input_tokens == 3000
    assert tracker.total_output_tokens == 600
    # haiku 4.5: $1.00 in / $5.00 out per 1M tokens
    expected = (3000 * 1.00 + 600 * 5.00) / 1_000_000
    assert abs(tracker.total_cost_usd - expected) < 1e-9


def test_unknown_model_costs_zero() -> None:
    tracker = CostTracker()
    tracker.record(model="not-a-real-model", usage=TokenUsage(input_tokens=1, output_tokens=1))
    assert tracker.total_cost_usd == 0.0
