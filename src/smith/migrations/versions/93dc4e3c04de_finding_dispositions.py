"""finding dispositions

Revision ID: 93dc4e3c04de
Revises: f276a5fea990
Create Date: 2026-08-15 08:02:42.366778
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '93dc4e3c04de'
down_revision: str | None = 'f276a5fea990'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('finding_dispositions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('project_id', sa.Integer(), nullable=False),
    sa.Column('fingerprint', sa.String(length=40), nullable=False),
    sa.Column('disposition', sa.String(length=20), nullable=False),
    sa.Column('reason', sa.Text(), nullable=False),
    sa.Column('set_by', sa.Integer(), nullable=False),
    sa.Column('set_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['set_by'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_dispositions_project_fingerprint', 'finding_dispositions', ['project_id', 'fingerprint'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_dispositions_project_fingerprint', table_name='finding_dispositions')
    op.drop_table('finding_dispositions')
