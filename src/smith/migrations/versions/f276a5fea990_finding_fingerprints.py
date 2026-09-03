"""finding fingerprints

Revision ID: f276a5fea990
Revises: 9920f3db8eaf
Create Date: 2026-08-15 07:56:34.035425
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'f276a5fea990'
down_revision: str | None = '9920f3db8eaf'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The default is only there to fill the rows written before fingerprints existed; the model has
    # no default of its own, so it is dropped again straight away.
    op.add_column(
        "findings",
        sa.Column("fingerprint", sa.String(length=40), nullable=False, server_default=""),
    )
    op.alter_column("findings", "fingerprint", server_default=None)
    op.create_index(
        "ix_findings_review_fingerprint", "findings", ["review_id", "fingerprint"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_findings_review_fingerprint", table_name="findings")
    op.drop_column("findings", "fingerprint")
