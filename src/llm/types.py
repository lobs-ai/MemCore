"""Shared types for the LLM and embedding clients.

The shape mirrors the `@agentic/llm` TypeScript package so a thin adapter
around that client satisfies the `LLMClient` protocol with no field renames.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    thinking_tokens: int = 0


@dataclass(frozen=True)
class LLMMessage:
    role: Literal["user", "assistant"]
    content: str


@dataclass(frozen=True)
class TextBlock:
    text: str
    type: Literal["text"] = "text"


@dataclass(frozen=True)
class ToolUseBlock:
    id: str
    name: str
    input: dict[str, object]
    type: Literal["tool_use"] = "tool_use"


ContentBlock = TextBlock | ToolUseBlock
StopReason = Literal["end_turn", "tool_use", "max_tokens", "stop"]


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, object]


@dataclass(frozen=True)
class CreateMessageParams:
    model: str
    system: str
    messages: list[LLMMessage]
    max_tokens: int
    tools: list[ToolDefinition] = field(default_factory=list)
    temperature: float = 0.0


@dataclass(frozen=True)
class LLMResponse:
    content: list[ContentBlock]
    stop_reason: StopReason
    usage: TokenUsage
    thinking_content: str | None = None

    @property
    def text(self) -> str:
        """Convenience: concatenate text blocks. Tool-only responses return ''."""
        return "".join(b.text for b in self.content if isinstance(b, TextBlock))


@dataclass(frozen=True)
class EmbeddingResponse:
    vectors: list[list[float]]
    model: str
    usage: TokenUsage
