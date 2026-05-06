"""
Arkon MCP Tools — LLM Wiki + raw source drill-down for Claude.

The wiki layer is the primary surface: Claude searches and reads markdown
pages compiled from sources. Raw-source tools (PageIndex-style) act as a
fallback for precise citations or text the wiki has paraphrased away.

All tools verify the employee's MCP token and enforce knowledge_type scope:
  - search_wiki / read_wiki_page / list_wiki_pages: filter by
    `knowledge_type_slugs && allowed_knowledge_types` (Postgres ARRAY overlap).
  - get_source / get_source_outline / get_source_pages / list_sources /
    get_knowledge_type_docs: enforce per-source scope via apply_scope_filter.
"""

from typing import Optional

from fastmcp import FastMCP


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

async def _get_identity():
    """Resolve the bearer token to a ResolvedIdentity, or return an error string."""
    from fastmcp.server.dependencies import get_http_request
    from app.database import async_session_factory
    from app.services.mcp_auth_service import MCPAuthService

    try:
        request = get_http_request()
        auth_header = request.headers.get("authorization", "")
        token = auth_header.removeprefix("Bearer ").strip()
    except RuntimeError:
        return None, "No HTTP request context available."

    if not token:
        return None, (
            "Authentication required. Configure your MCP token in Claude Desktop:\n"
            '{"mcpServers": {"arkon": {"url": "...", '
            '"headers": {"Authorization": "Bearer <your-token>"}}}}'
        )

    async with async_session_factory() as session:
        auth_svc = MCPAuthService(session)
        identity = await auth_svc.verify_token(token)
        if identity is None:
            return None, "Invalid or inactive MCP token. Contact your administrator."
        await session.commit()

    return identity, None


async def _get_allowed_source_ids(identity) -> Optional[set[str]]:
    """Allowed source UUID strings, or None when access is unrestricted."""
    if identity.is_admin:
        return None
    if identity.allowed_source_ids is None and identity.allowed_knowledge_types is None:
        return None

    from sqlalchemy import select
    from app.database import async_session_factory
    from app.database.models import Source
    from app.services.mcp_auth_service import apply_scope_filter

    async with async_session_factory() as session:
        stmt = select(Source.id).where(Source.status == "ready")
        stmt = apply_scope_filter(stmt, identity)
        result = await session.execute(stmt)
        return {str(r[0]) for r in result.all()}


# ---------------------------------------------------------------------------
# Tool registration
# ---------------------------------------------------------------------------

def register_tools(mcp: FastMCP):
    """Register all KB tools on the MCP server."""

    # =========================================================================
    # Wiki layer — synthesized markdown pages compiled from sources
    # =========================================================================

    @mcp.tool()
    async def search_wiki(query: str, top_k: int = 10) -> str:
        """
        Semantic search over the synthesized wiki pages.

        Use this FIRST when answering a question about the organization. Wiki
        pages are persistent, interlinked summaries compiled from many sources,
        so they often answer cross-document questions in one read.

        Args:
            query: Natural language search query.
            top_k: Maximum number of pages to return (default: 10).

        Returns:
            A ranked list of page slugs with titles, summaries, and similarity.
            Read the full page with `read_wiki_page(slug)`.
        """
        identity, err = await _get_identity()
        if err:
            return err

        from app.ai.registry import ProviderRegistry
        from app.database import async_session_factory
        from app.services import wiki_service

        async with async_session_factory() as session:
            registry = ProviderRegistry(session)
            embedding_provider = await registry.get_embedding(task="search_query")
            query_embedding = await embedding_provider.embed(query)

            hits = await wiki_service.search_pages_semantic(
                session,
                query_embedding=query_embedding,
                top_k=top_k,
                allowed_kt_slugs=identity.allowed_knowledge_types,
            )

        if not hits:
            return f"No wiki pages found for: \"{query}\""

        lines = [f"**Wiki search — {len(hits)} result(s) for: \"{query}\"**\n"]
        for page, sim in hits:
            similarity_pct = f"{sim:.0%}"
            summary = page.summary or ""
            kt_label = (
                f" [{', '.join(page.knowledge_type_slugs)}]"
                if page.knowledge_type_slugs else ""
            )
            entry = (
                f"- `{page.slug}` ({page.page_type}){kt_label} — {similarity_pct}\n"
                f"  **{page.title}**"
            )
            if summary:
                entry += f" — {summary}"
            lines.append(entry)

        lines.append("\n_Use `read_wiki_page(slug)` to read the full markdown._")
        return "\n".join(lines)

    @mcp.tool()
    async def read_wiki_index() -> str:
        """
        Read the wiki catalog (`_index` page).

        The index lists every wiki page grouped by type, with one-line
        summaries. Use this to discover the shape of the wiki before drilling
        into specific pages.
        """
        identity, err = await _get_identity()
        if err:
            return err

        from app.database import async_session_factory
        from app.services import wiki_service

        async with async_session_factory() as session:
            page = await wiki_service.get_page_by_slug(session, wiki_service.INDEX_SLUG)

        if not page:
            return "_(wiki index not initialized yet)_"
        return page.content_md

    @mcp.tool()
    async def read_wiki_page(slug: str) -> str:
        """
        Read a specific wiki page by slug, plus its backlinks.

        Args:
            slug: The page slug, e.g. "entity/jane-doe", "concept/onboarding".
                  Use `search_wiki` or `list_wiki_pages` to find slugs.

        Returns:
            Markdown content of the page, plus a "Backlinks" section listing
            other pages that link to this one. Wikilinks `[[slug]]` in the
            content can be followed with another `read_wiki_page` call.
        """
        identity, err = await _get_identity()
        if err:
            return err

        from app.database import async_session_factory
        from app.services import wiki_service

        async with async_session_factory() as session:
            page = await wiki_service.get_page_by_slug(
                session, slug, allowed_kt_slugs=identity.allowed_knowledge_types,
            )
            if not page:
                return f"Wiki page not found or out of scope: `{slug}`"
            backlinks = await wiki_service.get_backlinks(session, slug)

        body = page.content_md or ""
        if backlinks:
            body = body.rstrip() + "\n\n## Backlinks\n" + "\n".join(
                f"- `{s}`" for s in sorted(backlinks)
            )
        return body

    @mcp.tool()
    async def list_wiki_pages(
        page_type: Optional[str] = None,
        knowledge_type: Optional[str] = None,
        limit: int = 50,
    ) -> str:
        """
        Browse wiki pages with filters. Reserved pages (`_index`, `_log`) are excluded.

        Args:
            page_type: Filter by type — "entity", "concept", "topic", "source".
            knowledge_type: Filter by KnowledgeType slug.
            limit: Max pages to return (default: 50).

        Returns:
            Slug, title, summary, type, and KnowledgeType slugs for each page.
        """
        identity, err = await _get_identity()
        if err:
            return err

        from app.database import async_session_factory
        from app.services import wiki_service

        async with async_session_factory() as session:
            pages = await wiki_service.list_pages(
                session,
                page_type=page_type,
                knowledge_type_slug=knowledge_type,
                allowed_kt_slugs=identity.allowed_knowledge_types,
                limit=limit,
            )

        if not pages:
            return "No wiki pages match the filters."

        lines = [f"**Wiki pages — {len(pages)} result(s)**\n"]
        for p in pages:
            kt_label = f" [{', '.join(p.knowledge_type_slugs)}]" if p.knowledge_type_slugs else ""
            line = f"- `{p.slug}` ({p.page_type}){kt_label} — **{p.title}**"
            if p.summary:
                line += f" — {p.summary}"
            lines.append(line)
        return "\n".join(lines)

    # =========================================================================
    # Raw source drill-down (PageIndex-inspired)
    # =========================================================================

    @mcp.tool()
    async def get_source(source_id: str) -> str:
        """
        Metadata for a raw source document — title, knowledge type, page count,
        contributor, status. Use this before reading source pages.

        Args:
            source_id: The source UUID.
        """
        import uuid as uuid_mod
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload
        from app.database import async_session_factory
        from app.database.models import Source

        identity, err = await _get_identity()
        if err:
            return err
        try:
            sid = uuid_mod.UUID(source_id)
        except ValueError:
            return f"Invalid source ID: {source_id}"

        async with async_session_factory() as session:
            stmt = (
                select(Source).where(Source.id == sid)
                .options(selectinload(Source.knowledge_type), selectinload(Source.contributor))
            )
            source = (await session.execute(stmt)).scalar_one_or_none()
            if not source:
                return f"Source not found: {source_id}"

            allowed_ids = await _get_allowed_source_ids(identity)
            if allowed_ids is not None and str(sid) not in allowed_ids:
                return "Access denied: this source is outside your knowledge scope."

        page_count = len(source.page_offsets or [])
        kt_label = source.knowledge_type.name if source.knowledge_type else "Uncategorized"
        contributor_label = source.contributor.name if source.contributor else "(admin upload)"

        lines = [
            f"# {source.title or source.file_name or 'Untitled Source'}",
            f"- **ID:** `{source.id}`",
            f"- **Type:** {source.source_type or 'file'}",
            f"- **Knowledge type:** {kt_label}",
            f"- **Status:** {source.status}",
            f"- **Pages:** {page_count}" if page_count else "- **Pages:** (single block)",
            f"- **Contributed by:** {contributor_label}",
        ]
        if source.file_name:
            lines.append(f"- **File:** {source.file_name}")
        if source.url:
            lines.append(f"- **URL:** {source.url}")
        if source.created_at:
            lines.append(f"- **Added:** {source.created_at.strftime('%Y-%m-%d %H:%M')}")
        return "\n".join(lines)

    @mcp.tool()
    async def get_source_outline(source_id: str) -> str:
        """
        Heading-based outline (table of contents) of a raw source.

        Use this to navigate long documents by structure instead of guessing
        page numbers. Each entry shows title, level, page, and char range.
        Pass char_start/char_end downstream is not needed — use the page
        number with `get_source_pages` for the actual text.

        Args:
            source_id: The source UUID.
        """
        import uuid as uuid_mod
        from app.database import async_session_factory
        from app.database.models import Source

        identity, err = await _get_identity()
        if err:
            return err
        try:
            sid = uuid_mod.UUID(source_id)
        except ValueError:
            return f"Invalid source ID: {source_id}"

        async with async_session_factory() as session:
            source = await session.get(Source, sid)
            if not source:
                return f"Source not found: {source_id}"
            allowed_ids = await _get_allowed_source_ids(identity)
            if allowed_ids is not None and str(sid) not in allowed_ids:
                return "Access denied: this source is outside your knowledge scope."

        outline = source.outline_json or []
        if not outline:
            return "_(no outline — this document has no detectable headings)_"

        lines = ["# Outline\n"]
        def _walk(nodes: list[dict]):
            for n in nodes:
                indent = "  " * (max(0, n.get("level", 1) - 1))
                page = n.get("page")
                page_label = f" (page {page})" if page else ""
                lines.append(f"{indent}- {n.get('title', '')}{page_label}")
                if n.get("children"):
                    _walk(n["children"])
        _walk(outline)
        return "\n".join(lines)

    @mcp.tool()
    async def get_source_pages(source_id: str, pages: str) -> str:
        """
        Read raw text of specific pages from a source.

        Args:
            source_id: The source UUID.
            pages: Page range — examples: "5-7", "3,8", "12", "1-3,9".

        Returns:
            Concatenated page text with `--- page N ---` separators. Use this
            for precise citations when the wiki summary has paraphrased away
            details you need.
        """
        import uuid as uuid_mod
        from app.database import async_session_factory
        from app.database.models import Source
        from app.services.source_outline import parse_page_range, slice_pages_by_range

        identity, err = await _get_identity()
        if err:
            return err
        try:
            sid = uuid_mod.UUID(source_id)
        except ValueError:
            return f"Invalid source ID: {source_id}"

        page_nums = parse_page_range(pages)
        if not page_nums:
            return f"Invalid page range: {pages!r}. Use formats like '5-7', '3,8', '12'."

        async with async_session_factory() as session:
            source = await session.get(Source, sid)
            if not source:
                return f"Source not found: {source_id}"
            allowed_ids = await _get_allowed_source_ids(identity)
            if allowed_ids is not None and str(sid) not in allowed_ids:
                return "Access denied: this source is outside your knowledge scope."

        full_text = source.full_text or ""
        offsets = source.page_offsets or []
        if not full_text or not offsets:
            return "_(no extractable text or page offsets for this source)_"

        slices = slice_pages_by_range(full_text, offsets, page_nums)
        if not slices:
            return f"No content for pages: {page_nums}"

        parts = []
        for s in slices:
            parts.append(f"--- page {s['page']} ---\n{s['content']}")
        return "\n\n".join(parts)

    # =========================================================================
    # Source/Type browsing
    # =========================================================================

    @mcp.tool()
    async def list_sources(
        status: str = "ready",
        knowledge_type: Optional[str] = None,
        limit: int = 20,
    ) -> str:
        """
        List raw source documents with optional filters.

        Args:
            status: "ready", "processing", "error", or "all".
            knowledge_type: Filter by KnowledgeType slug.
            limit: Max sources to return (default: 20).
        """
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload
        from app.database import async_session_factory
        from app.database.models import KnowledgeType, Source
        from app.services.mcp_auth_service import apply_scope_filter

        identity, err = await _get_identity()
        if err:
            return err

        async with async_session_factory() as session:
            stmt = (
                select(Source)
                .options(selectinload(Source.knowledge_type))
                .order_by(Source.created_at.desc())
            )
            if status != "all":
                stmt = stmt.where(Source.status == status)
            if knowledge_type:
                kt_id = (await session.execute(
                    select(KnowledgeType.id).where(KnowledgeType.slug == knowledge_type)
                )).scalar()
                if kt_id:
                    stmt = stmt.where(Source.knowledge_type_id == kt_id)
            stmt = apply_scope_filter(stmt, identity).limit(limit)
            sources = (await session.execute(stmt)).scalars().all()

        if not sources:
            msg = "No documents found"
            if knowledge_type:
                msg += f" of type '{knowledge_type}'"
            return msg + "."

        from collections import defaultdict
        by_type = defaultdict(list)
        for s in sources:
            kt_name = s.knowledge_type.name if s.knowledge_type else "Uncategorized"
            by_type[kt_name].append(s)

        lines = [f"**Knowledge Base — {len(sources)} document(s)**\n"]
        for kt_name, type_sources in by_type.items():
            lines.append(f"\n### {kt_name} ({len(type_sources)})")
            for s in type_sources:
                title = s.title or s.file_name or s.url or "Untitled"
                lines.append(f"- **{title}** (ID: `{s.id}`)")
        return "\n".join(lines)

    @mcp.tool()
    async def list_knowledge_types() -> str:
        """
        List knowledge types (admin-defined classifications) accessible to the caller.
        """
        from sqlalchemy import func, select
        from app.database import async_session_factory
        from app.database.models import KnowledgeType, Source

        identity, err = await _get_identity()
        if err:
            return err

        async with async_session_factory() as session:
            stmt = (
                select(KnowledgeType, func.count(Source.id).label("doc_count"))
                .outerjoin(
                    Source,
                    (Source.knowledge_type_id == KnowledgeType.id) & (Source.status == "ready"),
                )
                .group_by(KnowledgeType.id)
                .order_by(KnowledgeType.sort_order, KnowledgeType.name)
            )
            rows = (await session.execute(stmt)).all()

        if not rows:
            return "No knowledge types have been defined yet."

        allowed_types = identity.allowed_knowledge_types

        lines = ["**Knowledge Types**\n"]
        for kt, doc_count in rows:
            if allowed_types is not None and kt.slug not in allowed_types:
                continue
            line = f"- **{kt.name}** (slug: `{kt.slug}`, {doc_count} doc(s))"
            if kt.description:
                line += f" — {kt.description}"
            lines.append(line)

        if len(lines) == 1:
            return "No accessible knowledge types found for your scope."
        return "\n".join(lines)

    @mcp.tool()
    async def get_knowledge_type_docs(knowledge_type_slug: str, limit: int = 10) -> str:
        """
        List documents belonging to a specific knowledge type.

        Args:
            knowledge_type_slug: Type slug (use `list_knowledge_types` to find).
            limit: Max documents to return (default: 10).
        """
        from sqlalchemy import select
        from app.database import async_session_factory
        from app.database.models import KnowledgeType, Source
        from app.services.mcp_auth_service import apply_scope_filter

        identity, err = await _get_identity()
        if err:
            return err

        if (identity.allowed_knowledge_types is not None
                and knowledge_type_slug not in identity.allowed_knowledge_types):
            return (
                f"Access denied: knowledge type '{knowledge_type_slug}' is outside your scope. "
                f"Use `list_knowledge_types` to see what types you can access."
            )

        async with async_session_factory() as session:
            kt = (await session.execute(
                select(KnowledgeType).where(KnowledgeType.slug == knowledge_type_slug)
            )).scalar_one_or_none()
            if not kt:
                return f"Knowledge type '{knowledge_type_slug}' not found."

            stmt = (
                select(Source)
                .where(Source.knowledge_type_id == kt.id, Source.status == "ready")
                .order_by(Source.created_at.desc())
            )
            stmt = apply_scope_filter(stmt, identity).limit(limit)
            sources = (await session.execute(stmt)).scalars().all()

        if not sources:
            return f"No documents found for knowledge type: **{kt.name}**"

        lines = [f"**{kt.name}** — {len(sources)} document(s)\n"]
        for s in sources:
            title = s.title or s.file_name or s.url or "Untitled"
            lines.append(f"- **{title}** (ID: `{s.id}`)")
        return "\n".join(lines)

    # =========================================================================
    # Tier 2 — Contribute (member-level, requires review)
    # =========================================================================

    @mcp.tool()
    async def propose_wiki_edit(slug: str, content_md: str, note: Optional[str] = None) -> str:
        """
        Propose an edit to an existing wiki page. Creates a pending draft for editor review.

        Use search_wiki() or read_wiki_index() to find the right slug first.
        Always confirm with the user before submitting.

        Args:
            slug: Target page slug (e.g. "concept/fire-safety").
            content_md: The full proposed content in Markdown (max 50,000 chars).
            note: Optional one-line explanation of what you changed and why.
        """
        from sqlalchemy import select
        from app.database import async_session_factory
        from app.database.models import Employee, WikiPage
        from app.services import wiki_service
        from app.services.permission_engine import (
            get_workspace_role, workspace_role_can, has_any_permission, _get_user_permissions,
        )

        identity, err = await _get_identity()
        if err:
            return err

        if not slug or not content_md.strip():
            return "Error: slug and content_md are required."
        if slug in ("_index", "_log"):
            return "Error: cannot propose drafts for reserved pages."
        if len(content_md) > 50_000:
            return "Error: content_md exceeds 50,000 character limit."

        async with async_session_factory() as session:
            page = (await session.execute(
                select(WikiPage).where(WikiPage.slug == slug)
            )).scalar_one_or_none()
            if not page:
                return f"Page '{slug}' not found. Use read_wiki_index() to browse available pages."

            employee = await session.get(Employee, identity.employee_id)
            if not employee:
                return "Error: employee not found."

            if employee.role != "admin":
                if page.scope_type == "project" and page.scope_id:
                    role = await get_workspace_role(session, employee, page.scope_id)
                    if not role:
                        return f"Error: you are not a member of the workspace for page '{slug}'."
                    if not workspace_role_can(role, "contributor"):
                        return f"Error: requires contributor role or above to propose edits to '{slug}'."
                else:
                    perms = _get_user_permissions(employee)
                    if not has_any_permission(list(perms), "wiki", "write"):
                        return "Error: insufficient permission to propose wiki edits."

            draft = await wiki_service.create_draft(
                session,
                page_id=page.id,
                author_id=employee.id,
                content_md=content_md.strip(),
                note=note,
                source="mcp_claude_desktop",
            )
            await session.commit()

        return (
            f"Draft submitted for `{slug}` (Draft ID: `{draft.id}`).\n"
            f"An editor will review it. Note: {note or '(none)'}"
        )

    # =========================================================================
    # Tier 3 — Direct Edit (editor/admin only, no review)
    # =========================================================================

    @mcp.tool()
    async def edit_wiki_page(slug: str, content_md: str, change_note: Optional[str] = None) -> str:
        """
        Directly edit a wiki page. Requires editor or admin role.
        Creates a revision in history immediately — no review step.

        Use propose_wiki_edit() instead if you only have contributor access.

        Args:
            slug: Target page slug.
            content_md: Full new content in Markdown.
            change_note: Optional one-line description of the change.
        """
        from sqlalchemy import select
        from app.database import async_session_factory
        from app.database.models import Employee, WikiPage
        from app.services import wiki_service
        from app.services.permission_engine import (
            get_workspace_role, workspace_role_can, has_any_permission, _get_user_permissions,
        )

        identity, err = await _get_identity()
        if err:
            return err

        if not slug or not content_md.strip():
            return "Error: slug and content_md are required."
        if slug in ("_index", "_log"):
            return "Error: cannot directly edit reserved pages."

        async with async_session_factory() as session:
            page = (await session.execute(
                select(WikiPage).where(WikiPage.slug == slug)
            )).scalar_one_or_none()
            if not page:
                return f"Page '{slug}' not found."

            employee = await session.get(Employee, identity.employee_id)
            if not employee:
                return "Error: employee not found."

            if employee.role != "admin":
                if page.scope_type == "project" and page.scope_id:
                    role = await get_workspace_role(session, employee, page.scope_id)
                    if not role or not workspace_role_can(role, "editor"):
                        return f"Error: requires editor role or above to directly edit '{slug}'."
                else:
                    perms = _get_user_permissions(employee)
                    if "wiki:write:all" not in perms:
                        return "Error: requires wiki:write:all permission to directly edit global wiki pages. Use propose_wiki_edit() instead."

            await wiki_service.direct_edit_page(session, page, employee.id, content_md.strip(), change_note)
            await session.commit()

        return f"Page `{slug}` updated to v{page.version}."

    # =========================================================================
    # Tier 4 — Review (editor/admin only)
    # =========================================================================

    @mcp.tool()
    async def list_pending_drafts(workspace_id: Optional[str] = None) -> str:
        """
        List pending wiki drafts awaiting editor review.

        Args:
            workspace_id: Optional. Filter to a specific workspace UUID.
                          Omit to see all accessible pending drafts.
        """
        from sqlalchemy import select
        from app.database import async_session_factory
        from app.database.models import Employee, WikiPage, WikiPageDraft
        from app.services.permission_engine import (
            get_workspace_role, workspace_role_can, has_any_permission, _get_user_permissions,
        )

        identity, err = await _get_identity()
        if err:
            return err

        async with async_session_factory() as session:
            employee = await session.get(Employee, identity.employee_id)
            if not employee:
                return "Error: employee not found."

            stmt = (
                select(WikiPageDraft)
                .where(WikiPageDraft.status == "pending")
                .order_by(WikiPageDraft.created_at.asc())
                .limit(50)
            )
            drafts = (await session.execute(stmt)).scalars().all()

            lines = []
            for draft in drafts:
                page = await session.get(WikiPage, draft.page_id)
                if not page:
                    continue
                if workspace_id and str(page.scope_id) != workspace_id:
                    continue
                # Check reviewer permission
                can_review = employee.role == "admin"
                if not can_review and page.scope_type == "project" and page.scope_id:
                    role = await get_workspace_role(session, employee, page.scope_id)
                    can_review = bool(role) and workspace_role_can(role, "editor")
                elif not can_review:
                    perms = _get_user_permissions(employee)
                    can_review = "wiki:write:all" in perms
                if not can_review:
                    continue

                author = await session.get(Employee, draft.author_id) if draft.author_id else None
                lines.append(
                    f"- **{page.slug}** | Draft `{draft.id}` | "
                    f"by {author.name if author else 'unknown'} | "
                    f"{draft.created_at.strftime('%Y-%m-%d %H:%M')} | "
                    f"note: {draft.note or '(none)'}"
                )

        if not lines:
            return "No pending drafts found."
        return f"**{len(lines)} pending draft(s):**\n\n" + "\n".join(lines)

    @mcp.tool()
    async def review_draft(draft_id: str) -> str:
        """
        Get full content of a pending draft for review.
        Returns the draft content alongside the current page content for comparison.

        Args:
            draft_id: UUID of the draft (from list_pending_drafts).
        """
        from app.database import async_session_factory
        from app.database.models import Employee, WikiPage, WikiPageDraft
        from app.services.permission_engine import (
            get_workspace_role, workspace_role_can, _get_user_permissions,
        )
        import uuid as _uuid

        identity, err = await _get_identity()
        if err:
            return err

        try:
            did = _uuid.UUID(draft_id)
        except ValueError:
            return "Error: invalid draft ID format."

        async with async_session_factory() as session:
            draft = await session.get(WikiPageDraft, did)
            if not draft:
                return f"Draft `{draft_id}` not found."

            employee = await session.get(Employee, identity.employee_id)
            if not employee:
                return "Error: employee not found."

            page = await session.get(WikiPage, draft.page_id)
            if not page:
                return "Error: parent wiki page not found."

            # Permission: editor+ in workspace, or wiki:write:all, or admin
            can_review = employee.role == "admin"
            if not can_review and page.scope_type == "project" and page.scope_id:
                role = await get_workspace_role(session, employee, page.scope_id)
                can_review = bool(role) and workspace_role_can(role, "editor")
            elif not can_review:
                perms = _get_user_permissions(employee)
                can_review = "wiki:write:all" in perms
            if not can_review:
                return "Error: insufficient permission to review drafts for this page."

            author = await session.get(Employee, draft.author_id) if draft.author_id else None

        return (
            f"## Draft `{draft_id}`\n"
            f"**Page:** `{page.slug}` — {page.title}\n"
            f"**Author:** {author.name if author else 'unknown'}\n"
            f"**Status:** {draft.status}\n"
            f"**Note:** {draft.note or '(none)'}\n\n"
            f"---\n\n"
            f"### Proposed content\n\n{draft.content_md}\n\n"
            f"---\n\n"
            f"### Current page content (v{page.version})\n\n{page.content_md or '_(empty)_'}"
        )

    @mcp.tool()
    async def approve_draft(
        draft_id: str,
        reviewer_note: Optional[str] = None,
        edited_content_md: Optional[str] = None,
    ) -> str:
        """
        Approve a pending wiki draft. Requires editor or admin role.

        The draft content (or your edited version) is written directly to the wiki page.
        A revision is created in history.

        Args:
            draft_id: UUID of the draft to approve.
            reviewer_note: Optional note to the author explaining the decision.
            edited_content_md: Optional — provide this to approve with your own edits
                               instead of the author's original content.
        """
        from app.database import async_session_factory
        from app.database.models import Employee, WikiPage, WikiPageDraft
        from app.services import wiki_service
        from app.services.permission_engine import (
            get_workspace_role, workspace_role_can, _get_user_permissions,
        )
        import uuid as _uuid

        identity, err = await _get_identity()
        if err:
            return err

        try:
            did = _uuid.UUID(draft_id)
        except ValueError:
            return "Error: invalid draft ID format."

        async with async_session_factory() as session:
            draft = await session.get(WikiPageDraft, did)
            if not draft:
                return f"Draft `{draft_id}` not found."
            if draft.status != "pending":
                return f"Error: draft is already {draft.status}."

            employee = await session.get(Employee, identity.employee_id)
            if not employee:
                return "Error: employee not found."

            page = await session.get(WikiPage, draft.page_id)
            if not page:
                return "Error: parent wiki page not found."

            can_review = employee.role == "admin"
            if not can_review and page.scope_type == "project" and page.scope_id:
                role = await get_workspace_role(session, employee, page.scope_id)
                can_review = bool(role) and workspace_role_can(role, "editor")
            elif not can_review:
                perms = _get_user_permissions(employee)
                can_review = "wiki:write:all" in perms
            if not can_review:
                return "Error: insufficient permission to approve drafts for this page."

            await wiki_service.approve_draft(
                session, draft, employee.id,
                reviewer_note=reviewer_note,
                edited_content_md=edited_content_md,
            )
            await session.commit()

        return f"Draft `{draft_id}` approved. Page `{page.slug}` updated to v{page.version}."

    @mcp.tool()
    async def reject_draft(draft_id: str, reviewer_note: str) -> str:
        """
        Reject a pending wiki draft. reviewer_note is required — the author needs
        to understand why their proposal was not accepted.

        Args:
            draft_id: UUID of the draft to reject.
            reviewer_note: Required explanation for the author.
        """
        from app.database import async_session_factory
        from app.database.models import Employee, WikiPage, WikiPageDraft
        from app.services import wiki_service
        from app.services.permission_engine import (
            get_workspace_role, workspace_role_can, _get_user_permissions,
        )
        import uuid as _uuid

        identity, err = await _get_identity()
        if err:
            return err

        if not reviewer_note or not reviewer_note.strip():
            return "Error: reviewer_note is required when rejecting a draft."

        try:
            did = _uuid.UUID(draft_id)
        except ValueError:
            return "Error: invalid draft ID format."

        async with async_session_factory() as session:
            draft = await session.get(WikiPageDraft, did)
            if not draft:
                return f"Draft `{draft_id}` not found."
            if draft.status != "pending":
                return f"Error: draft is already {draft.status}."

            employee = await session.get(Employee, identity.employee_id)
            if not employee:
                return "Error: employee not found."

            page = await session.get(WikiPage, draft.page_id)
            if not page:
                return "Error: parent wiki page not found."

            can_review = employee.role == "admin"
            if not can_review and page.scope_type == "project" and page.scope_id:
                role = await get_workspace_role(session, employee, page.scope_id)
                can_review = bool(role) and workspace_role_can(role, "editor")
            elif not can_review:
                perms = _get_user_permissions(employee)
                can_review = "wiki:write:all" in perms
            if not can_review:
                return "Error: insufficient permission to reject drafts for this page."

            await wiki_service.reject_draft(session, draft, employee.id, reviewer_note.strip())
            await session.commit()

        return f"Draft `{draft_id}` rejected. Note to author: {reviewer_note}"
