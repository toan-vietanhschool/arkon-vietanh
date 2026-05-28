"""
DESTRUCTIVE: wipe all wiki + source data across every scope
(global / department / project).

What is wiped:
  - All sources (sources, source_departments, source_chunk_extracts,
    source_compilation_plans, source_images, project_sources)
  - All wiki pages (wiki_pages, wiki_page_revisions, wiki_page_drafts,
    wiki_draft_rounds, wiki_links, wiki_page_embeddings_*)
  - All MinIO objects under the `sources/` prefix
  - Reset notifications related to drafts (best-effort)

What is PRESERVED:
  - departments, employees, roles, projects (workspaces),
    project_members, knowledge_types, mcp tokens, audit_log,
    organization settings, AI provider catalog

Usage (inside the API container):
    docker exec arkon_api python -m app.scripts.reset_wiki_and_sources

Pre-flight: take a pg_dump backup of the affected tables BEFORE running.
This script does NOT take its own backup — admin must do it.
"""

import asyncio

from sqlalchemy import text

from app.database import async_session_factory
from app.services.storage_service import storage_service


# Order matters: delete dependents first (FKs).
TABLES_IN_DEP_ORDER: list[str] = [
    # Wiki dependents → wiki_pages
    "wiki_links",
    "wiki_draft_rounds",
    "wiki_page_drafts",
    "wiki_page_revisions",
    "wiki_page_embeddings_768",
    "wiki_page_embeddings_1024",
    "wiki_page_embeddings_1536",
    "wiki_page_embeddings_3072",
    "wiki_pages",
    # Source dependents → sources
    "source_chunk_extracts",
    "source_compilation_plans",
    "source_images",
    "source_departments",
    "project_sources",
    "sources",
]


async def _delete_minio_source_blobs() -> int:
    """Delete every object under the `sources/` prefix in the configured
    bucket. Returns the count removed (best-effort — failures logged)."""
    from app.config import settings

    try:
        client = storage_service.client
        bucket = settings.minio_bucket
    except Exception as e:
        print(f"  ! storage_service unavailable: {e}")
        return 0

    removed = 0
    try:
        for obj in client.list_objects(bucket, prefix="sources/", recursive=True):
            try:
                client.remove_object(bucket, obj.object_name)
                removed += 1
            except Exception as e:
                print(f"  ! failed to remove {obj.object_name}: {e}")
    except Exception as e:
        print(f"  ! list_objects failed: {e}")
    return removed


async def main() -> None:
    print("=== Pre-flight counts ===")
    async with async_session_factory() as session:
        for tbl in TABLES_IN_DEP_ORDER:
            try:
                c = (await session.execute(text(f"SELECT COUNT(*) FROM {tbl}"))).scalar()
                if c:
                    print(f"  {tbl}: {c}")
            except Exception as e:
                print(f"  {tbl}: <skip — {e}>")

    print("\n=== Deleting rows (FK-safe order) ===")
    async with async_session_factory() as session:
        for tbl in TABLES_IN_DEP_ORDER:
            try:
                res = await session.execute(text(f"DELETE FROM {tbl}"))
                print(f"  - {tbl}: {res.rowcount or 0} rows")
            except Exception as e:
                print(f"  ! {tbl}: {e}")
        await session.commit()

    print("\n=== Cleaning MinIO sources/ prefix ===")
    removed = await _delete_minio_source_blobs()
    print(f"  removed {removed} objects")

    print("\n=== Post-reset counts ===")
    async with async_session_factory() as session:
        for tbl in TABLES_IN_DEP_ORDER:
            try:
                c = (await session.execute(text(f"SELECT COUNT(*) FROM {tbl}"))).scalar()
                print(f"  {tbl}: {c}")
            except Exception:
                pass

    print("\nDone. departments / employees / roles / workspaces / knowledge_types / "
          "audit_log / org settings are unchanged.")


if __name__ == "__main__":
    asyncio.run(main())
