"""
Wiki revisions router — list and rollback wiki page revisions.

Split out from `wiki.py` and registered BEFORE the main `wiki.router` in
`app/main.py` to avoid the greedy `{slug:path}` catchall on
`GET /wiki/pages/{slug:path}` shadowing these endpoints when a slug
contains `/` (e.g. `entity/major-education`).
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.database.models import Employee, WikiPageRevision
from app.routers.wiki import (
    WikiPageDetail,
    WikiRevisionSummary,
    _detail,
    assert_page_read_access,
)
from app.services import wiki_service
from app.services.audit_service import log_audit
from app.services.auth_service import get_current_user, require_permission

router = APIRouter()


@router.get("/wiki/pages/{slug:path}/revisions", response_model=list[WikiRevisionSummary])
async def list_wiki_page_revisions(
    slug: str,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: Employee = require_permission("wiki:read"),
):
    """List revision history for a wiki page (most recent first)."""
    page = await wiki_service.get_page_by_slug_any_scope(db, slug)
    if not page:
        raise HTTPException(404, f"Wiki page not found: {slug}")

    # Revision history can expose full historical content_md, so gate it with
    # the same scope check as reading the page itself.
    await assert_page_read_access(db, user, page)

    from app.database.models import Employee as Emp
    rows = (await db.execute(
        select(WikiPageRevision, Emp.name.label("changed_by_name"))
        .outerjoin(Emp, WikiPageRevision.changed_by_id == Emp.id)
        .where(WikiPageRevision.page_id == page.id)
        .order_by(WikiPageRevision.version.desc())
        .limit(limit)
    )).all()

    return [
        WikiRevisionSummary(
            id=r.WikiPageRevision.id,
            version=r.WikiPageRevision.version,
            change_type=r.WikiPageRevision.change_type,
            changed_by_name=r.changed_by_name,
            change_note=r.WikiPageRevision.change_note,
            created_at=r.WikiPageRevision.created_at.isoformat(),
        )
        for r in rows
    ]


@router.post("/wiki/pages/{slug:path}/revisions/{version}/rollback", response_model=WikiPageDetail)
async def rollback_wiki_page(
    slug: str,
    version: int,
    db: AsyncSession = Depends(get_db),
    user: Employee = Depends(get_current_user),
):
    """Rollback a wiki page to a specific version. Admin only."""
    if user.role != "admin":
        raise HTTPException(403, "Only admins can rollback wiki pages")

    page = await wiki_service.get_page_by_slug_any_scope(db, slug)
    if not page:
        raise HTTPException(404, f"Wiki page not found: {slug}")

    try:
        await wiki_service.rollback_to_revision(db, page, version, user.id)
    except ValueError as e:
        raise HTTPException(404, str(e))

    await log_audit(db, user, "update", "wiki_page", str(page.id), reason=f"rollback to v{version}: {slug}")
    await db.commit()
    await db.refresh(page)

    backlinks = await wiki_service.get_backlinks(db, slug, page.scope_type, page.scope_id)
    outlinks = await wiki_service.get_outlinks(db, slug, page.scope_type or "global", page.scope_id)
    return _detail(page, backlinks, outlinks)
