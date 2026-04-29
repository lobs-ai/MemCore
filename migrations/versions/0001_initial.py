"""initial empty migration — installs the pgvector extension only

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-29 00:00:00.000000

The schema itself lands in Phase 1 (chunks/conversations/messages) and Phase 2
(memories/edges). This migration exists so `alembic upgrade head` is a valid
no-op against a fresh database and the pgvector extension is available before
any later migration adds VECTOR columns.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")


def downgrade() -> None:
    # Extensions are intentionally not dropped — they may be shared with other schemas.
    pass
