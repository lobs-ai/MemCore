"""FastAPI application entry point.

`uvicorn src.api.main:app --reload` for local dev. Routers under `/v1`.
Application errors (`MemCoreError`) are mapped to JSON via the handler in
this module so route handlers can `raise` rather than build responses by hand.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from src.api.health import router as health_router
from src.config import get_settings
from src.db.session import dispose_engine
from src.errors import MemCoreError
from src.logging import bind_request_context, clear_request_context, configure_logging, get_logger

logger = get_logger("api.main")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    settings = get_settings()
    logger.info("api_startup", environment=settings.environment)
    try:
        yield
    finally:
        await dispose_engine()
        logger.info("api_shutdown")


app = FastAPI(
    title="MemCore",
    version="0.1.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    container_tag = request.headers.get("x-container-tag", "")
    bind_request_context(request_id=request_id, container_tag=container_tag)
    try:
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        return response
    finally:
        clear_request_context()


@app.exception_handler(MemCoreError)
async def handle_app_error(_: Request, exc: MemCoreError) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
        status_code=exc.http_status,
    )


app.include_router(health_router, prefix="/v1")
