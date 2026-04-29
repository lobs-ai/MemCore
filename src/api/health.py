"""GET /v1/health.

Returns 200 if the service is up and the database is reachable, 503 otherwise.
This is the only endpoint expected to work in Phase 0.
"""

from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse
from sqlalchemy import text

from src.db.session import get_session_factory
from src.logging import get_logger

router = APIRouter(tags=["health"])
logger = get_logger("api.health")


@router.get("/health")
async def health() -> JSONResponse:
    db_ok = False
    error: str | None = None
    try:
        factory = get_session_factory()
        async with factory() as session:
            await session.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:  # noqa: BLE001 — health check intentionally surfaces any failure
        error = f"{type(e).__name__}: {e}"
        logger.warning("health_db_check_failed", error=error)

    body: dict[str, object] = {
        "status": "ok" if db_ok else "degraded",
        "db": "ok" if db_ok else "unreachable",
    }
    if error:
        body["error"] = error
    return JSONResponse(
        body,
        status_code=status.HTTP_200_OK if db_ok else status.HTTP_503_SERVICE_UNAVAILABLE,
    )
