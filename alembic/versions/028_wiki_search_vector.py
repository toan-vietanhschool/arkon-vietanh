"""Wiki BM25-style lexical search via tsvector

Revision ID: 028
Revises: 027
Create Date: 2026-05-27 12:00:00.000000

Adds a generated tsvector column on `wiki_pages` plus a GIN index so we can
run plainto_tsquery / ts_rank_cd lexical search alongside the existing
pgvector semantic search.

Why `simple` and not a language config:
  * Wiki content is primarily Vietnamese.
  * Postgres ships no built-in Vietnamese dictionary; using `english` would
    apply Porter stemming to Vietnamese tokens and produce garbage.
  * `simple` lowercases and tokenizes by whitespace/punctuation without
    stemming — which is the correct neutral default for Vietnamese.

Weights (A/B/C) prioritise title hits > summary hits > body hits at rank time
without requiring the application to know the weighting scheme.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "028"
down_revision: Union[str, None] = "027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # GENERATED ALWAYS AS ... STORED is maintained by Postgres on every
    # INSERT/UPDATE — no application-level trigger needed.
    op.execute(
        """
        ALTER TABLE wiki_pages
        ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
            setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('simple', coalesce(summary, '')), 'B') ||
            setweight(to_tsvector('simple', coalesce(content_md, '')), 'C')
        ) STORED
        """
    )
    op.execute(
        """
        CREATE INDEX ix_wiki_pages_search_vector
        ON wiki_pages USING GIN (search_vector)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_wiki_pages_search_vector")
    op.execute("ALTER TABLE wiki_pages DROP COLUMN IF EXISTS search_vector")
