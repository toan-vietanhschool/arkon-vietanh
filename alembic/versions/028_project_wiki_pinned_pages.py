"""project_wiki_pages — pin global/external wiki pages into a workspace

Revision ID: 028
Revises: 027
Create Date: 2026-05-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "028"
down_revision: Union[str, None] = "027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "project_wiki_pages",
        sa.Column("project_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("page_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "pinned_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("pinned_by_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
        sa.PrimaryKeyConstraint("project_id", "page_id"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["page_id"], ["wiki_pages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["pinned_by_id"], ["employees.id"], ondelete="SET NULL"),
    )
    op.create_index(
        "ix_project_wiki_pages_page_id",
        "project_wiki_pages",
        ["page_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_project_wiki_pages_page_id", table_name="project_wiki_pages")
    op.drop_table("project_wiki_pages")
