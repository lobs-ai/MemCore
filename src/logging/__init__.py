"""Structured logging.

Every log record carries `request_id`, `container_tag`, and `component` (per
AGENTS.md § Code style). Call `configure_logging()` once at process start and
then `get_logger(component=...)` everywhere else.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog

from src.config import get_settings

_configured = False


def configure_logging() -> None:
    """Idempotent logging setup. Safe to call from FastAPI lifespan or tests."""
    global _configured
    if _configured:
        return

    settings = get_settings()
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
    )

    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    if settings.environment == "development":
        renderer: structlog.types.Processor = structlog.dev.ConsoleRenderer(colors=True)
    else:
        renderer = structlog.processors.JSONRenderer()

    structlog.configure(
        processors=[*shared_processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )

    _configured = True


def get_logger(component: str, **initial: Any) -> Any:
    """Return a logger bound to a component. Required fields default to empty strings
    so JSON consumers see a stable schema even when nothing is bound yet.

    Returns `Any` because structlog's bound-logger types are too loose to satisfy
    `mypy --strict` without losing information that matters at call sites."""
    if not _configured:
        configure_logging()
    log: Any = structlog.get_logger()
    return log.bind(
        component=component,
        request_id=initial.pop("request_id", ""),
        container_tag=initial.pop("container_tag", ""),
        **initial,
    )


def bind_request_context(*, request_id: str, container_tag: str = "") -> None:
    """Bind request-scoped fields so every log inside the request inherits them."""
    structlog.contextvars.bind_contextvars(
        request_id=request_id,
        container_tag=container_tag,
    )


def clear_request_context() -> None:
    structlog.contextvars.clear_contextvars()
