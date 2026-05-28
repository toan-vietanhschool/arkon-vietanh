"""
Wiki Service — CRUD, semantic search, and wikilink graph for WikiPage.

The wiki is the LLM-compiled knowledge layer. It replaces chunk-based RAG.
Each page is markdown that may contain `[[slug]]` wikilinks; after every
upsert, refresh_links() re-parses the content and rewrites the wiki_links
edge table so 1-2 hop graph queries (backlinks, neighborhood) stay fast in
PostgreSQL — no separate graph DB needed.

Scope support: every page belongs to a scope (global or workspace). Query
functions accept scope_type/scope_id to isolate results. Default is global.
"""

import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from loguru import logger
from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import WikiLink, WikiPage, WikiPageDraft, WikiPageRevision

# Reserved page slugs — these are regular WikiPage rows but treated specially.
INDEX_SLUG = "_index"
LOG_SLUG = "_log"

# Recognized page types — used for filtering and prompt hints to the compiler.
PAGE_TYPES = {"entity", "concept", "source", "topic", "index", "log"}

# `[[slug]]` or `[[slug|display text]]` — captures the slug only.
_WIKILINK_RE = re.compile(r"\[\[([^\]\|]+)(?:\|[^\]]*)?]]")


# ---------------------------------------------------------------------------
# Scope filter helper
# ---------------------------------------------------------------------------

def _scope_filter(scope_type: str = "global", scope_id: Optional[uuid.UUID] = None):
    """Return SQLAlchemy WHERE clauses for exact scope filtering."""
    if scope_id:
        return and_(WikiPage.scope_type == scope_type, WikiPage.scope_id == scope_id)
    return and_(WikiPage.scope_type == scope_type, WikiPage.scope_id.is_(None))


def _scope_filter_with_dept(department_id: Optional[uuid.UUID] = None):
    """OR-filter: global pages + department pages visible to the given dept member.

    DEPRECATED for MCP read paths — does NOT include project-scoped pages,
    which made wiki pages of workspaces invisible to their own members. Use
    `_scope_filter_for_identity` instead.
    """
    if department_id:
        return or_(
            and_(WikiPage.scope_type == "global", WikiPage.scope_id.is_(None)),
            and_(WikiPage.scope_type == "department", WikiPage.scope_id == department_id),
        )
    return _scope_filter("global")


def _scope_filter_for_identity(
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
):
    """OR-filter for the MCP read path: every wiki page the user can see.

    Includes:
      - All global pages.
      - Department pages of the user's own department.
      - Project pages of every workspace the user is a member of.

    Without the project branch, members of a workspace cannot find their own
    workspace's wiki pages via search — they fall through to raw-source
    drill-down and assume the page doesn't exist.
    """
    clauses = [and_(WikiPage.scope_type == "global", WikiPage.scope_id.is_(None))]
    if department_id is not None:
        clauses.append(
            and_(WikiPage.scope_type == "department", WikiPage.scope_id == department_id)
        )
    if project_ids:
        clauses.append(
            and_(WikiPage.scope_type == "project", WikiPage.scope_id.in_(project_ids))
        )
    return or_(*clauses)


def _inverse_scope_filter_for_identity(
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
):
    """Pages OUTSIDE the user's accessible scope — used by out-of-scope hints.

    Excludes global pages (everyone sees those) so the inverse is just:
      - Department pages of OTHER departments.
      - Project pages of workspaces the user is NOT a member of.
    """
    project_clause = (
        and_(WikiPage.scope_type == "project", WikiPage.scope_id.notin_(project_ids))
        if project_ids
        else WikiPage.scope_type == "project"
    )
    dept_clause = (
        and_(WikiPage.scope_type == "department", WikiPage.scope_id != department_id)
        if department_id is not None
        else WikiPage.scope_type == "department"
    )
    return or_(dept_clause, project_clause)


# ---------------------------------------------------------------------------
# Wikilink parsing & graph maintenance
# ---------------------------------------------------------------------------

def extract_wikilinks(content_md: str) -> list[str]:
    """Return the list of slugs referenced by `[[slug]]` patterns, deduped."""
    if not content_md:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for match in _WIKILINK_RE.finditer(content_md):
        slug = match.group(1).strip()
        if slug and slug not in seen:
            seen.add(slug)
            out.append(slug)
    return out


async def refresh_links(
    session: AsyncSession,
    from_page_id: uuid.UUID,
    from_slug: str,
    content_md: str,
) -> None:
    """
    Replace all outgoing edges from the page identified by `from_page_id` with
    wikilinks parsed from its current `content_md`. Self-links (matching the
    page's own slug) are dropped to keep the graph sane.
    """
    await session.execute(
        delete(WikiLink).where(WikiLink.from_page_id == from_page_id)
    )
    targets = [s for s in extract_wikilinks(content_md) if s != from_slug]
    if not targets:
        return
    await session.execute(
        pg_insert(WikiLink)
        .values([{"from_page_id": from_page_id, "to_slug": t} for t in targets])
        .on_conflict_do_nothing()
    )


async def get_backlinks(
    session: AsyncSession,
    slug: str,
    scope_type: Optional[str] = None,
    scope_id: Optional[uuid.UUID] = None,
) -> list[str]:
    """Slugs of pages that link to `slug`.

    If scope filters are given, only return slugs of origin pages in the same
    scope OR in global scope (global referrers are visible from any scope).
    """
    stmt = (
        select(WikiPage.slug)
        .join(WikiLink, WikiLink.from_page_id == WikiPage.id)
        .where(WikiLink.to_slug == slug)
    )
    if scope_type is not None:
        stmt = stmt.where(
            or_(
                and_(WikiPage.scope_type == scope_type, WikiPage.scope_id == scope_id) if scope_id is not None
                else and_(WikiPage.scope_type == scope_type, WikiPage.scope_id.is_(None)),
                and_(WikiPage.scope_type == "global", WikiPage.scope_id.is_(None)),
            )
        )
    result = await session.execute(stmt.distinct())
    return [row[0] for row in result.all()]


async def get_outlinks(
    session: AsyncSession,
    slug: str,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
) -> list[str]:
    """Slugs that the page (`slug`, scope) links to."""
    page = await get_page_by_slug(session, slug, scope_type=scope_type, scope_id=scope_id)
    if page is None:
        return []
    result = await session.execute(
        select(WikiLink.to_slug).where(WikiLink.from_page_id == page.id)
    )
    return [row[0] for row in result.all()]


async def get_neighborhood(
    session: AsyncSession,
    slug: str,
    depth: int = 1,
) -> dict:
    """
    Return nodes (slug, title, page_type) and edges within `depth` hops of `slug`.
    Uses an undirected recursive CTE — useful for Obsidian-style graph view.
    """
    depth = max(1, min(depth, 3))  # cap at 3 hops to keep queries cheap
    # Recursive CTE walking both directions over (origin_slug, target_slug)
    # tuples derived from wiki_links joined with wiki_pages on from_page_id.
    # WITH RECURSIVE is required because `walk` self-references inside its
    # own definition. Without the RECURSIVE keyword Postgres treats `walk` as
    # not-yet-defined when it parses the second arm of the UNION, raising
    # `relation "walk" does not exist`. The `edges` non-recursive CTE is
    # allowed in the same WITH clause as long as RECURSIVE is set once.
    cte_sql = text(
        """
        WITH RECURSIVE edges AS (
            SELECT wp.slug AS from_slug, wl.to_slug AS to_slug
            FROM wiki_links wl
            JOIN wiki_pages wp ON wp.id = wl.from_page_id
        ),
        walk(slug, dist) AS (
            SELECT CAST(:start AS varchar), 0
          UNION
            SELECT
              CASE WHEN e.from_slug = w.slug THEN e.to_slug ELSE e.from_slug END,
              w.dist + 1
            FROM walk w
            JOIN edges e
              ON e.from_slug = w.slug OR e.to_slug = w.slug
            WHERE w.dist < :depth
        )
        SELECT DISTINCT slug FROM walk
        """
    )
    rows = await session.execute(cte_sql, {"start": slug, "depth": depth})
    slugs = [r[0] for r in rows.all()]
    if not slugs:
        return {"nodes": [], "edges": []}

    pages_result = await session.execute(
        select(WikiPage.slug, WikiPage.title, WikiPage.page_type)
        .where(WikiPage.slug.in_(slugs))
    )
    nodes = [
        {"slug": r.slug, "title": r.title, "page_type": r.page_type}
        for r in pages_result.all()
    ]
    edges_result = await session.execute(
        select(WikiPage.slug.label("from_slug"), WikiLink.to_slug)
        .join(WikiLink, WikiLink.from_page_id == WikiPage.id)
        .where(and_(WikiPage.slug.in_(slugs), WikiLink.to_slug.in_(slugs)))
    )
    edges = [{"from": r.from_slug, "to": r.to_slug} for r in edges_result.all()]
    return {"nodes": nodes, "edges": edges}


# ---------------------------------------------------------------------------
# Page CRUD
# ---------------------------------------------------------------------------

async def get_page_by_slug(
    session: AsyncSession,
    slug: str,
    allowed_kt_slugs: Optional[list[str]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
) -> Optional[WikiPage]:
    """
    Fetch a page by slug within a specific scope. If `allowed_kt_slugs` is
    given (RBAC), only return the page when it overlaps the allowed set or is
    a reserved slug.
    """
    stmt = select(WikiPage).where(
        WikiPage.slug == slug,
        _scope_filter(scope_type, scope_id),
    )
    result = await session.execute(stmt)
    page = result.scalars().first()
    if page is None:
        return None
    if allowed_kt_slugs is None or slug in (INDEX_SLUG, LOG_SLUG):
        return page
    if not page.knowledge_type_slugs:
        return page
    if any(s in allowed_kt_slugs for s in page.knowledge_type_slugs):
        return page
    return None


async def get_page_by_slug_any_scope(
    session: AsyncSession,
    slug: str,
) -> Optional[WikiPage]:
    """
    Fetch a page by slug across ALL scopes (no scope filtering).
    Used as a fallback when no explicit scope is specified, e.g. global graph view
    clicking on a workspace-scoped wiki page.
    """
    stmt = select(WikiPage).where(WikiPage.slug == slug).limit(1)
    result = await session.execute(stmt)
    return result.scalars().first()


async def list_pages(
    session: AsyncSession,
    page_type: Optional[str] = None,
    knowledge_type_slug: Optional[str] = None,
    allowed_kt_slugs: Optional[list[str]] = None,
    limit: int = 50,
    offset: int = 0,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    all_scopes: bool = False,
) -> list[WikiPage]:
    """List pages with filtering within a scope.

    Scope behaviour:
      - `all_scopes=True`: no scope filter at all (admin bypass).
      - `department_id` (and optionally `project_ids`) given: union of global
        + user's department + every workspace the user is a member of.
      - Otherwise: exact `scope_type`/`scope_id` (pipeline write path).
    """
    if all_scopes:
        scope_clause = None
    elif department_id is not None or project_ids:
        scope_clause = _scope_filter_for_identity(department_id, project_ids)
    else:
        scope_clause = _scope_filter(scope_type, scope_id)
    stmt = (
        select(WikiPage)
        .where(WikiPage.slug.notin_([INDEX_SLUG, LOG_SLUG]))
        .order_by(WikiPage.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if scope_clause is not None:
        stmt = stmt.where(scope_clause)
    if page_type:
        stmt = stmt.where(WikiPage.page_type == page_type)
    if knowledge_type_slug:
        stmt = stmt.where(WikiPage.knowledge_type_slugs.any(knowledge_type_slug))  # type: ignore[arg-type]
    if allowed_kt_slugs:
        stmt = stmt.where(
            or_(
                WikiPage.knowledge_type_slugs.overlap(allowed_kt_slugs),
                func.cardinality(WikiPage.knowledge_type_slugs) == 0,
            )
        )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def search_pages_semantic(
    session: AsyncSession,
    query_embedding: list[float],
    top_k: int = 10,
    allowed_kt_slugs: Optional[list[str]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    spec_id: Optional[str] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    inverse_scope: bool = False,
    all_scopes: bool = False,
) -> list[tuple[WikiPage, float]]:
    """
    Cosine-similarity search over wiki page embeddings within a scope.

    Embeddings live in per-dimension tables (`wiki_page_embeddings_<dim>`).
    The active embedding model spec determines which table to query and which
    `model_spec_id` rows to filter to. Pass `spec_id` explicitly to override —
    only used by tests and internal tooling.

    Scope behaviour:
      - If `department_id` or `project_ids` is given: returns pages from
        global + user's department + user's workspaces (MCP read path).
      - If `inverse_scope=True`: returns pages OUTSIDE that scope (other
        departments, workspaces the user isn't a member of). Used to surface
        "you don't have access" hints.
      - Otherwise uses exact scope_type/scope_id matching (pipeline write path).

    Returns (page, similarity) pairs sorted by similarity descending. Returns
    an empty list if no active embedding model is configured.
    """
    from app.ai.embedding_catalog import get_spec
    from app.ai.registry import ProviderRegistry
    from app.database.models import get_embedding_model_for_dim

    if spec_id is None:
        registry = ProviderRegistry(session)
        spec_id = await registry.get_active_embedding_spec_id()
    if not spec_id:
        return []

    spec = get_spec(spec_id)
    Emb = get_embedding_model_for_dim(spec.dimension)

    if all_scopes and not inverse_scope:
        scope_clause = None
    elif inverse_scope:
        scope_clause = _inverse_scope_filter_for_identity(department_id, project_ids)
    elif department_id is not None or project_ids:
        scope_clause = _scope_filter_for_identity(department_id, project_ids)
    else:
        scope_clause = _scope_filter(scope_type, scope_id)

    where_clauses = [
        Emb.model_spec_id == spec.id,
        WikiPage.slug.notin_([INDEX_SLUG, LOG_SLUG]),
    ]
    if scope_clause is not None:
        where_clauses.append(scope_clause)

    stmt = (
        select(
            WikiPage,
            (1 - Emb.embedding.cosine_distance(query_embedding)).label("similarity"),
        )
        .join(Emb, Emb.page_id == WikiPage.id)
        .where(and_(*where_clauses))
        .order_by(Emb.embedding.cosine_distance(query_embedding))
        .limit(top_k)
    )
    if allowed_kt_slugs:
        stmt = stmt.where(
            or_(
                WikiPage.knowledge_type_slugs.overlap(allowed_kt_slugs),
                func.cardinality(WikiPage.knowledge_type_slugs) == 0,
            )
        )
    result = await session.execute(stmt)
    return [(row[0], float(row[1])) for row in result.all()]


async def search_pages_bm25(
    session: AsyncSession,
    query: str,
    top_k: int = 30,
    allowed_kt_slugs: Optional[list[str]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    inverse_scope: bool = False,
    all_scopes: bool = False,
) -> list[tuple[WikiPage, float]]:
    """
    BM25-style lexical search over the generated `wiki_pages.search_vector`
    tsvector column (see migration 028).

    Why this exists alongside `search_pages_semantic`:
      * Embeddings struggle with exact terms (proper nouns, acronyms, IDs).
      * Lexical search nails those but misses paraphrases. The MCP layer
        combines both signals.

    Scoring:
      * `plainto_tsquery('simple', :q)` parses the user query — multi-word
        queries become AND'd lexemes safely (no risk of operator injection).
      * `ts_rank_cd(search_vector, query, 32)` ranks each hit. The `32` flag
        is `rank/(rank+1)` — a length-normalised score in (0, 1) that keeps
        long pages from dominating just because they contain more tokens.

    Scope behaviour mirrors `search_pages_semantic` exactly:
      * `all_scopes=True` and not inverse: no scope filter (admin bypass).
      * `inverse_scope=True`: pages OUTSIDE user's accessible scopes.
      * `department_id` or `project_ids` given: identity union (global +
        own dept + own workspaces).
      * Otherwise: exact scope_type/scope_id match.

    Returns (page, ts_rank_cd) tuples sorted by score descending. Returns
    an empty list when the query produces no lexemes (e.g. all stopwords or
    punctuation only).
    """
    query = (query or "").strip()
    if not query:
        return []

    tsquery = func.plainto_tsquery("simple", query)
    rank = func.ts_rank_cd(WikiPage.search_vector, tsquery, 32).label("score")

    if all_scopes and not inverse_scope:
        scope_clause = None
    elif inverse_scope:
        scope_clause = _inverse_scope_filter_for_identity(department_id, project_ids)
    elif department_id is not None or project_ids:
        scope_clause = _scope_filter_for_identity(department_id, project_ids)
    else:
        scope_clause = _scope_filter(scope_type, scope_id)

    where_clauses = [
        WikiPage.search_vector.op("@@")(tsquery),
        WikiPage.slug.notin_([INDEX_SLUG, LOG_SLUG]),
    ]
    if scope_clause is not None:
        where_clauses.append(scope_clause)

    stmt = (
        select(WikiPage, rank)
        .where(and_(*where_clauses))
        .order_by(rank.desc())
        .limit(top_k)
    )
    if allowed_kt_slugs:
        stmt = stmt.where(
            or_(
                WikiPage.knowledge_type_slugs.overlap(allowed_kt_slugs),
                func.cardinality(WikiPage.knowledge_type_slugs) == 0,
            )
        )
    result = await session.execute(stmt)
    return [(row[0], float(row[1])) for row in result.all()]


async def expand_via_graph_walk(
    session: AsyncSession,
    seed_page_ids: list[uuid.UUID],
    seed_scores: dict[uuid.UUID, float],
    max_hops: int = 2,
    decay: float = 0.5,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    all_scopes: bool = False,
    include_backlinks: bool = False,
) -> dict[uuid.UUID, float]:
    """
    Expand a set of seed pages via wikilinks (1-2 hops) and return a proximity
    score per discovered page.

    Algorithm:
      hop_score[seed] = seed_scores[seed]
      for each hop h in 1..max_hops:
          for each page p reached at hop h via wiki_links:
              score(p) += decay^h * source_seed_score
      Apply scope filter at the END so we don't waste hops on pages the
      caller can't read anyway.

    Returns {page_id: aggregated_proximity_score}. INCLUDES the original
    seeds (with their starting scores) so caller can fuse with BM25/vector
    ranks easily.
    """
    if not seed_page_ids:
        return {}
    if max_hops <= 0:
        return dict(seed_scores)

    # Resolve the scope clause once — applied at JOIN target so out-of-scope
    # pages are unreachable even when reached via in-scope sources.
    if all_scopes:
        scope_clause = None
    elif department_id is not None or project_ids:
        scope_clause = _scope_filter_for_identity(department_id, project_ids)
    else:
        scope_clause = _scope_filter(scope_type, scope_id)

    # Aggregated proximity score per page (starts with the seeds themselves).
    scores: dict[uuid.UUID, float] = {
        pid: float(seed_scores.get(pid, 0.0)) for pid in seed_page_ids
    }

    # Per-hop frontier: maps page_id -> contribution score at this hop.
    # For hop 1 the contributions are the seed scores themselves; for hop 2
    # the contributions are whatever hop-1 nodes accumulated from their seeds.
    frontier: dict[uuid.UUID, float] = {
        pid: float(seed_scores.get(pid, 0.0)) for pid in seed_page_ids
    }

    for hop in range(1, max_hops + 1):
        if not frontier:
            break
        hop_multiplier = decay ** hop

        # Pull edges incident to the current frontier. Outbound is always on;
        # inbound (backlinks) is opt-in. Cross-source links in Arkon are often
        # asymmetric (e.g. leaf pages link to hub pages but not vice-versa);
        # `include_backlinks=True` lets the walk also surface those leaves.
        frontier_ids = list(frontier.keys())
        edges: list[tuple] = []

        # --- outbound: frontier --> target via [[to_slug]] ---
        out_where = [WikiLink.from_page_id.in_(frontier_ids)]
        if scope_clause is not None:
            out_where.append(scope_clause)
        out_stmt = (
            select(WikiLink.from_page_id, WikiPage.id)
            .join(WikiPage, WikiPage.slug == WikiLink.to_slug)
            .where(and_(*out_where))
        )
        edges.extend((await session.execute(out_stmt)).all())

        # --- inbound: any page p that links to a frontier page ---
        if include_backlinks:
            # Resolve frontier page_ids -> slugs first; backlinks key off slug.
            slug_stmt = select(WikiPage.id, WikiPage.slug).where(
                WikiPage.id.in_(frontier_ids)
            )
            slug_rows = (await session.execute(slug_stmt)).all()
            frontier_slug_to_id = {slug: pid for pid, slug in slug_rows}
            frontier_slugs = list(frontier_slug_to_id.keys())
            if frontier_slugs:
                in_where = [WikiLink.to_slug.in_(frontier_slugs)]
                if scope_clause is not None:
                    in_where.append(scope_clause)
                # Source-side scope filter: only count incoming edges whose
                # source page is itself in scope (otherwise we'd read pages
                # the caller can't see).
                in_stmt = (
                    select(WikiLink.to_slug, WikiPage.id)
                    .join(WikiPage, WikiPage.id == WikiLink.from_page_id)
                    .where(and_(*in_where))
                )
                for to_slug, src_pid in (await session.execute(in_stmt)).all():
                    target_pid_in_frontier = frontier_slug_to_id.get(to_slug)
                    if target_pid_in_frontier is None:
                        continue
                    # Edge tuple format: (frontier_node_id, discovered_page_id)
                    edges.append((target_pid_in_frontier, src_pid))

        # Accumulate per-target contributions; multiple paths from distinct
        # frontier nodes SUM (rewards multi-source convergence).
        next_frontier: dict[uuid.UUID, float] = {}
        for from_pid, target_pid in edges:
            source_contrib = frontier.get(from_pid, 0.0)
            if source_contrib == 0.0:
                continue
            delta = hop_multiplier * source_contrib
            scores[target_pid] = scores.get(target_pid, 0.0) + delta
            # For next hop, propagate this node's accumulated contribution.
            # We use the seed-equivalent strength (source_contrib) rather
            # than the decayed delta so the next hop applies its own decay
            # against the original strength — equivalent to decay^(h+1).
            prev = next_frontier.get(target_pid, 0.0)
            if source_contrib > prev:
                next_frontier[target_pid] = source_contrib

        frontier = next_frontier

    return scores


async def search_pages_hybrid(
    session: AsyncSession,
    query: str,
    query_embedding: list[float],
    top_k: int = 10,
    allowed_kt_slugs: Optional[list[str]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    spec_id: Optional[str] = None,
    department_id: Optional[uuid.UUID] = None,
    project_ids: Optional[list[uuid.UUID]] = None,
    all_scopes: bool = False,
    *,
    candidate_pool: int = 30,
    rrf_k: int = 60,
    graph_hops: int = 2,
    graph_decay: float = 0.5,
    graph_weight: float = 0.0,
) -> list[tuple[WikiPage, float]]:
    """
    Hybrid retrieval combining BM25 (lexical) + vector (semantic), with
    optional graph-walk re-ranking via wikilinks.

    Pipeline:
      1. BM25 top-N (lexical, `search_pages_bm25`)
      2. Vector top-N (semantic, `search_pages_semantic`)
      3. Reciprocal Rank Fusion: score(p) = sum 1/(rrf_k + rank_in_list)
      4. (optional) Graph walk from top fused seeds → bonus for pages that
         many seeds link to. Disabled by default (`graph_weight=0`).
      5. Final score = rrf_score + graph_weight * (graph_score - own_rrf)
      6. Sort, normalise so top is ~1.0, return top_k.

    Why RRF instead of weighted sum of raw scores: BM25 (`ts_rank_cd`) and
    cosine similarity live on different scales and distributions. Working
    in rank space sidesteps that problem and is the standard hybrid-search
    fusion technique (Cormack et al. 2009).

    Why `graph_weight=0` is the default: empirically on Arkon's corpus,
    graph re-ranking inflates well-connected "hub" pages that many top
    candidates link to. On a small corpus this surfaces useful bridges;
    once the corpus has > ~20 sources with dense cross-source linking the
    same mechanism homogenises the result set and reduces topical
    precision. Callers who want bridge-aware results (e.g. a "Related
    pages" sidebar) can pass `graph_weight=0.05`. The graph_walk function
    itself remains available as a standalone primitive.

    Returns (WikiPage, normalised_score) sorted by score descending.
    """
    import asyncio as _asyncio

    # Channels run independently; fire them in parallel.
    bm25_task = search_pages_bm25(
        session=session,
        query=query,
        top_k=candidate_pool,
        allowed_kt_slugs=allowed_kt_slugs,
        scope_type=scope_type,
        scope_id=scope_id,
        department_id=department_id,
        project_ids=project_ids,
        all_scopes=all_scopes,
    )
    vec_task = search_pages_semantic(
        session=session,
        query_embedding=query_embedding,
        top_k=candidate_pool,
        allowed_kt_slugs=allowed_kt_slugs,
        scope_type=scope_type,
        scope_id=scope_id,
        spec_id=spec_id,
        department_id=department_id,
        project_ids=project_ids,
        all_scopes=all_scopes,
    )
    # SQLAlchemy AsyncSession is NOT safe for concurrent statements, so we
    # await sequentially. Both channels are cheap; net latency stays low.
    bm25_hits = await bm25_task
    vec_hits = await vec_task

    # ------- Reciprocal Rank Fusion -------
    # rrf_score(page) = sum over channels of 1/(k + rank), rank is 1-indexed.
    pages_by_id: dict[uuid.UUID, WikiPage] = {}
    rrf_scores: dict[uuid.UUID, float] = {}

    for rank, (page, _) in enumerate(bm25_hits, start=1):
        pages_by_id[page.id] = page
        rrf_scores[page.id] = rrf_scores.get(page.id, 0.0) + 1.0 / (rrf_k + rank)
    for rank, (page, _) in enumerate(vec_hits, start=1):
        pages_by_id[page.id] = page
        rrf_scores[page.id] = rrf_scores.get(page.id, 0.0) + 1.0 / (rrf_k + rank)

    if not rrf_scores:
        return []

    # ------- Optional graph walk expansion from top fused seeds -------
    # Skip entirely when graph_weight is 0 — the walk is expensive on dense
    # graphs and would just multiply by zero anyway.
    graph_scores: dict[uuid.UUID, float] = {}
    if graph_weight > 0:
        seed_limit = max(top_k * 2, 10)
        top_seeds = sorted(rrf_scores.items(), key=lambda kv: kv[1], reverse=True)[:seed_limit]
        seed_ids = [pid for pid, _ in top_seeds]
        seed_scores = {pid: score for pid, score in top_seeds}
        graph_scores = await expand_via_graph_walk(
            session=session,
            seed_page_ids=seed_ids,
            seed_scores=seed_scores,
            max_hops=graph_hops,
            decay=graph_decay,
            scope_type=scope_type,
            scope_id=scope_id,
            department_id=department_id,
            project_ids=project_ids,
            all_scopes=all_scopes,
            include_backlinks=False,
        )

    # ------- Final fusion -------
    # Graph walk is used as a RERANKER only — we do NOT introduce pages
    # that were not retrieved by BM25 or vector. Why: empirically, pages
    # surfaced ONLY by graph walk are usually well-connected hubs that
    # over-rank just because many candidates link to them, drowning out
    # truly relevant leaf pages. The graph signal still meaningfully
    # boosts candidates that are reinforced by other candidates linking
    # to them, but it cannot vault unrelated hubs into the top results.
    final_scores: dict[uuid.UUID, float] = {}
    for pid in pages_by_id.keys():
        rrf = rrf_scores.get(pid, 0.0)
        gscore = graph_scores.get(pid, 0.0)
        # Boost = excess graph score over the page's own seed score.
        # For non-seeds (rrf=0) the boost is bounded by graph_weight * gscore.
        proximity_boost = max(0.0, gscore - rrf)
        final_scores[pid] = rrf + graph_weight * proximity_boost

    ranked = sorted(final_scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
    # Normalize so the top result is ~1.0; downstream UIs render this as a
    # percentage. Raw RRF scores cluster around 1/(60+rank) ≈ 0.016, which
    # rendered as a `%` is misleading ("2% match"). The relative ordering is
    # what matters, not the absolute magnitude.
    if ranked:
        top_score = ranked[0][1]
        scale = (1.0 / top_score) if top_score > 0 else 1.0
        return [(pages_by_id[pid], score * scale) for pid, score in ranked if pid in pages_by_id]
    return []


# ---------------------------------------------------------------------------
# Compiler ops application
# ---------------------------------------------------------------------------

async def apply_create(
    session: AsyncSession,
    slug: str,
    title: str,
    page_type: str,
    content_md: str,
    summary: str,
    knowledge_type_slugs: list[str],
    source_ids: list[uuid.UUID],
    embedding: Optional[list[float]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
    revision_change_type: str = "agent_compile",
    revision_draft_id: Optional[uuid.UUID] = None,
    revision_changed_by_id: Optional[uuid.UUID] = None,
    revision_change_note: Optional[str] = None,
) -> WikiPage:
    """Insert a new page in the given scope. Conflicts raise — caller should use update.

    The initial v1 revision row is written here. Callers that want to attribute
    the revision differently (e.g. draft approval) pass `revision_change_type`
    + reviewer/draft fields instead of inserting a second revision themselves —
    `uq_wiki_revisions_page_version` forbids two rows for the same (page, v=1).
    """
    page = WikiPage(
        slug=slug,
        title=title,
        page_type=page_type if page_type in PAGE_TYPES else "concept",
        content_md=content_md,
        summary=summary,
        knowledge_type_slugs=list(knowledge_type_slugs or []),
        source_ids=list(source_ids or []),
        # embedding intentionally omitted: stored in wiki_page_embeddings_<dim>
        scope_type=scope_type,
        scope_id=scope_id,
        version=1,
    )
    _ = embedding  # backward-compat parameter, ignored
    session.add(page)
    await session.flush()
    await refresh_links(session, page.id, slug, content_md)
    session.add(WikiPageRevision(
        page_id=page.id, version=page.version,
        content_md=content_md,
        change_type=revision_change_type,
        draft_id=revision_draft_id,
        changed_by_id=revision_changed_by_id,
        change_note=revision_change_note,
    ))
    return page


async def apply_update(
    session: AsyncSession,
    slug: str,
    new_content_md: str,
    summary: Optional[str] = None,
    title: Optional[str] = None,
    add_knowledge_type_slug: Optional[str] = None,
    add_source_id: Optional[uuid.UUID] = None,
    embedding: Optional[list[float]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
) -> Optional[WikiPage]:
    """
    Update an existing page atomically within the given scope:
      - Replace content_md with new_content_md.
      - Optionally update title/summary.
      - Union add_knowledge_type_slug into knowledge_type_slugs.
      - Append add_source_id to source_ids if not present.
      - Bump version, refresh updated_at, refresh embedding if supplied.
    Returns None if the page does not exist.
    """
    page = await get_page_by_slug(session, slug, scope_type=scope_type, scope_id=scope_id)
    if page is None:
        return None

    page.content_md = new_content_md
    if title is not None:
        page.title = title
    if summary is not None:
        page.summary = summary
    if add_knowledge_type_slug and add_knowledge_type_slug not in (page.knowledge_type_slugs or []):
        page.knowledge_type_slugs = [*(page.knowledge_type_slugs or []), add_knowledge_type_slug]
    if add_source_id and add_source_id not in (page.source_ids or []):
        page.source_ids = [*(page.source_ids or []), add_source_id]
    # Embeddings are no longer stored on WikiPage; the compiler calls
    # _reembed_pages after this returns, which writes into the active
    # wiki_page_embeddings_<dim> table. The `embedding` parameter is accepted
    # only for backward compatibility and ignored here.
    _ = embedding
    page.version = (page.version or 1) + 1
    await session.flush()
    await refresh_links(session, page.id, slug, new_content_md)
    session.add(WikiPageRevision(
        page_id=page.id, version=page.version,
        content_md=new_content_md, change_type="agent_compile",
    ))
    return page


async def upsert_page(
    session: AsyncSession,
    slug: str,
    title: str,
    page_type: str,
    content_md: str,
    summary: str,
    knowledge_type_slugs: list[str],
    source_ids: list[uuid.UUID],
    embedding: Optional[list[float]] = None,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
) -> WikiPage:
    """Create-or-update by slug within a scope."""
    # Acquire a transaction-level advisory lock based on the hash of the slug
    # to serialize concurrent upserts for the exact same page.
    lock_query = select(func.pg_advisory_xact_lock(func.hashtext(slug)))
    await session.execute(lock_query)

    existing = await get_page_by_slug(session, slug, scope_type=scope_type, scope_id=scope_id)
    if existing is None:
        return await apply_create(
            session, slug, title, page_type, content_md, summary,
            knowledge_type_slugs, source_ids, embedding,
            scope_type=scope_type, scope_id=scope_id,
        )
    return await apply_update(
        session,
        slug=slug,
        new_content_md=content_md,
        summary=summary,
        title=title,
        add_knowledge_type_slug=knowledge_type_slugs[0] if knowledge_type_slugs else None,
        add_source_id=source_ids[0] if source_ids else None,
        embedding=embedding,
        scope_type=scope_type, scope_id=scope_id,
    ) or existing


# ---------------------------------------------------------------------------
# Reserved pages: _index and _log
# ---------------------------------------------------------------------------

async def regenerate_index(
    session: AsyncSession,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
) -> WikiPage:
    """
    Rebuild the `_index` page within the given scope.
    Grouped by page_type, alphabetical within group. Excludes reserved slugs.
    """
    stmt = (
        select(WikiPage.slug, WikiPage.title, WikiPage.page_type, WikiPage.summary)
        .where(
            WikiPage.slug.notin_([INDEX_SLUG, LOG_SLUG]),
            _scope_filter(scope_type, scope_id),
        )
        .order_by(WikiPage.page_type, WikiPage.title)
    )
    rows = (await session.execute(stmt)).all()

    by_type: dict[str, list[tuple[str, str, str]]] = {}
    for r in rows:
        by_type.setdefault(r.page_type, []).append((r.slug, r.title, r.summary or ""))

    lines = ["# Wiki Index", ""]
    if not by_type:
        lines.append("_(empty — no pages yet)_")
    else:
        for ptype in sorted(by_type.keys()):
            lines.append(f"## {ptype.capitalize()}")
            lines.append("")
            for slug, title, summary in by_type[ptype]:
                summary_part = f" — {summary}" if summary else ""
                lines.append(f"- [[{slug}|{title}]]{summary_part}")
            lines.append("")

    new_md = "\n".join(lines).rstrip() + "\n"
    page = await get_page_by_slug(session, INDEX_SLUG, scope_type=scope_type, scope_id=scope_id)
    if page is None:
        page = WikiPage(
            slug=INDEX_SLUG,
            title="Wiki Index",
            page_type="index",
            content_md=new_md,
            summary="Catalog of all wiki pages",
            knowledge_type_slugs=[],
            source_ids=[],
            scope_type=scope_type,
            scope_id=scope_id,
        )
        session.add(page)
    else:
        page.content_md = new_md
        page.version = (page.version or 1) + 1
    await session.flush()
    return page


async def append_log(
    session: AsyncSession,
    entry: str,
    scope_type: str = "global",
    scope_id: Optional[uuid.UUID] = None,
) -> WikiPage:
    """
    Append a timestamped line to the `_log` page within the given scope.
    """
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    line = f"## [{ts}] {entry.strip()}"
    page = await get_page_by_slug(session, LOG_SLUG, scope_type=scope_type, scope_id=scope_id)
    if page is None:
        page = WikiPage(
            slug=LOG_SLUG,
            title="Wiki Log",
            page_type="log",
            content_md=f"# Wiki Log\n\n{line}\n",
            summary="Chronological activity log",
            knowledge_type_slugs=[],
            source_ids=[],
            scope_type=scope_type,
            scope_id=scope_id,
        )
        session.add(page)
    else:
        existing = page.content_md or "# Wiki Log\n"
        if "_(empty" in existing:
            existing = "# Wiki Log\n"
        page.content_md = existing.rstrip() + f"\n\n{line}\n"
        page.version = (page.version or 1) + 1
    await session.flush()
    return page


# ---------------------------------------------------------------------------
# Page deletion — cascade cleanup
# ---------------------------------------------------------------------------

async def delete_page_cascade(
    session: AsyncSession,
    page: WikiPage,
) -> None:
    """
    Delete a wiki page and cascade-cleanup all references:
    1. Delete all outgoing links from this page
    2. Delete all incoming links pointing to this page
    3. Remove [[slug]] and [[slug|text]] wikilinks from pages that reference this one
    4. Delete the page itself

    Caller passes the already-resolved page so we never accidentally fall back
    to a different scope's copy of the same slug.
    """
    slug = page.slug
    del_scope_type = page.scope_type or "global"
    del_scope_id = page.scope_id

    # 1+2: Remove edges. Outgoing edges from this page cascade via FK. Incoming
    # edges (to this slug) are removed only from referrers in the same scope
    # OR from global referrers (which logically point at the deleted page if
    # it is global) — leave edges in other scopes intact because they target
    # *that* scope's same-slug page, not the one we're deleting.
    if del_scope_type == "global":
        # Deleting a global page invalidates ALL [[slug]] references because
        # those links resolve to global by default. Clear all incoming edges.
        await session.execute(
            delete(WikiLink).where(WikiLink.to_slug == slug)
        )
    else:
        same_scope_pages = select(WikiPage.id).where(
            WikiPage.scope_type == del_scope_type,
            WikiPage.scope_id == del_scope_id,
        )
        await session.execute(
            delete(WikiLink).where(
                WikiLink.to_slug == slug,
                WikiLink.from_page_id.in_(same_scope_pages),
            )
        )

    # 3: Find pages that reference this slug in their content and clean up.
    # Scope the scrub the same way: only rewrite same-scope pages (and globals
    # when deleting a global page).
    ref_stmt = select(WikiPage).where(
        WikiPage.content_md.contains(f"[[{slug}]]")
        | WikiPage.content_md.contains(f"[[{slug}|")
    )
    if del_scope_type != "global":
        ref_stmt = ref_stmt.where(
            WikiPage.scope_type == del_scope_type,
            WikiPage.scope_id == del_scope_id,
        )
    referring_pages = (await session.execute(ref_stmt)).scalars().all()

    for ref_page in referring_pages:
        if ref_page.id == page.id:
            continue
        cleaned = ref_page.content_md or ""
        # Replace [[slug|display]] with just display text
        cleaned = re.sub(
            rf"\[\[{re.escape(slug)}\|([^\]]+)]]",
            r"\1",
            cleaned,
        )
        # Replace [[slug]] with slug text
        cleaned = cleaned.replace(f"[[{slug}]]", slug.split("/")[-1])
        ref_page.content_md = cleaned

    # 4: Delete the page itself
    await session.delete(page)

    await session.flush()
    logger.info(f"delete_page_cascade({slug}): deleted page + cleaned {len(referring_pages)} references")


# ---------------------------------------------------------------------------
# Source removal — used when deleting a source
# ---------------------------------------------------------------------------

async def detach_source_from_wiki(
    session: AsyncSession,
    source_id: uuid.UUID,
) -> int:
    """
    Remove `source_id` from every WikiPage.source_ids.
    - Pages that have other contributing sources: keep, just remove this source_id.
    - Pages whose only source was this one: delete immediately.

    Returns the number of pages deleted.
    """
    stmt = select(WikiPage).where(WikiPage.source_ids.any(source_id))  # type: ignore[arg-type]
    pages = list((await session.execute(stmt)).scalars().all())
    deleted_count = 0
    for page in pages:
        remaining = [sid for sid in (page.source_ids or []) if sid != source_id]
        if not remaining:
            await session.delete(page)
            deleted_count += 1
        else:
            page.source_ids = remaining
    await session.flush()
    if deleted_count:
        logger.info(f"detach_source_from_wiki({source_id}): deleted {deleted_count} single-source pages")
    return deleted_count


# ---------------------------------------------------------------------------
# Draft workflow
# ---------------------------------------------------------------------------

class DraftConflictError(Exception):
    """Raised when a draft's base_version is older than the current page version."""
    def __init__(self, current_version: int, base_version: int):
        self.current_version = current_version
        self.base_version = base_version
        super().__init__(
            f"Draft is based on v{base_version} but the page has advanced to "
            f"v{current_version}. Re-base the draft against the latest content."
        )


async def create_draft(
    session: AsyncSession,
    page_id: Optional[uuid.UUID],
    author_id: uuid.UUID,
    content_md: str,
    note: Optional[str] = None,
    source: str = "web_ui",
    source_metadata: Optional[dict] = None,
    base_version: Optional[int] = None,
    draft_kind: str = "edit",
    suggested_metadata: Optional[dict] = None,
) -> WikiPageDraft:
    """Create a pending draft for editor review.

    For draft_kind='edit', page_id is required. For 'create', page_id stays
    None and suggested_metadata holds the contributor's proposed slug/title/
    page_type/knowledge_type_slugs/scope. The reviewer can override the
    metadata at approve time before the page is materialised.
    """
    draft = WikiPageDraft(
        page_id=page_id,
        author_id=author_id,
        content_md=content_md,
        note=note,
        status="pending",
        source=source,
        source_metadata=source_metadata,
        base_version=base_version,
        draft_kind=draft_kind,
        suggested_metadata=suggested_metadata,
    )
    session.add(draft)
    await session.flush()
    return draft


class CreateDraftSlugConflict(Exception):
    """Raised when approving a create-draft whose slug already exists in scope."""
    def __init__(self, slug: str, scope_type: str, scope_id: Optional[uuid.UUID]):
        self.slug = slug
        self.scope_type = scope_type
        self.scope_id = scope_id
        scope_label = scope_type if scope_id is None else f"{scope_type}:{scope_id}"
        super().__init__(
            f"Slug '{slug}' already exists in {scope_label}. "
            "Override final_slug, or have the contributor edit the existing page instead."
        )


async def approve_draft(
    session: AsyncSession,
    draft: WikiPageDraft,
    reviewer_id: uuid.UUID,
    reviewer_note: Optional[str] = None,
    edited_content_md: Optional[str] = None,
    allow_conflict: bool = False,
    metadata_overrides: Optional[dict] = None,
) -> WikiPage:
    """
    Approve a pending draft. Writes the final content to wiki_pages.content_md,
    creates a revision, and marks the draft approved.
    If edited_content_md is provided, that is used instead of the original draft content.

    For draft_kind='create' the page is materialised from
    `draft.suggested_metadata` (or the reviewer-supplied `metadata_overrides`)
    using `apply_create`. The reviewer may override slug / title / page_type /
    knowledge_type_slugs before commit.

    Raises DraftConflictError when an edit draft was authored against an older
    page version than the current one, unless `allow_conflict=True` or
    `edited_content_md` is supplied. Raises CreateDraftSlugConflict when a
    create draft's chosen slug already exists in the target scope.
    """
    final_content = edited_content_md.strip() if edited_content_md else draft.content_md

    # Serialise concurrent approves on the same page. Without this, two
    # reviewers clicking Approve on different pending drafts of the same
    # page within the same second can both read page.version=N, both set
    # N+1, and both INSERT a WikiPageRevision(version=N+1) — leaving a
    # duplicate revision row and a non-deterministic last-writer-wins for
    # the page content. Lock by slug (when known) so we don't block the
    # entire page table.
    target_slug: Optional[str] = None
    existing_page: Optional[WikiPage] = None
    if draft.draft_kind == "create":
        target_slug = (draft.suggested_metadata or {}).get("slug")
    else:
        existing_page = await session.get(WikiPage, draft.page_id) if draft.page_id else None
        target_slug = existing_page.slug if existing_page else None
    if target_slug:
        await session.execute(
            select(func.pg_advisory_xact_lock(func.hashtext(target_slug)))
        )
        # The page row was loaded BEFORE the lock; another reviewer may have
        # bumped its version while we waited. Refresh from DB so version /
        # content_md reflect the committed state inside the critical section.
        if existing_page is not None:
            await session.refresh(existing_page)

    if draft.draft_kind == "create":
        meta = dict(draft.suggested_metadata or {})
        overrides = metadata_overrides or {}
        slug = (overrides.get("final_slug") or meta.get("slug") or "").strip()
        title = (overrides.get("final_title") or meta.get("title") or "").strip()
        page_type = overrides.get("final_page_type") or meta.get("page_type") or "concept"
        kt_slugs = (
            overrides.get("final_knowledge_type_slugs")
            if overrides.get("final_knowledge_type_slugs") is not None
            else meta.get("knowledge_type_slugs") or []
        )
        scope_type = meta.get("scope_type") or "global"
        scope_id_raw = meta.get("scope_id")
        try:
            scope_id = uuid.UUID(scope_id_raw) if isinstance(scope_id_raw, str) else scope_id_raw
        except (ValueError, TypeError):
            scope_id = None
        if scope_id is not None and not isinstance(scope_id, uuid.UUID):
            # Hand-crafted metadata with a non-string non-UUID (e.g. int)
            # shouldn't propagate downstream. Treat as missing scope.
            scope_id = None

        if not slug or slug in (INDEX_SLUG, LOG_SLUG):
            raise ValueError(f"Invalid slug for new page: '{slug}'")
        if not title:
            raise ValueError("Title is required to materialise a new page")

        existing = await get_page_by_slug(session, slug, scope_type=scope_type, scope_id=scope_id)
        if existing is not None:
            raise CreateDraftSlugConflict(slug, scope_type, scope_id)

        page = await apply_create(
            session,
            slug=slug, title=title, page_type=page_type,
            content_md=final_content, summary="",
            knowledge_type_slugs=list(kt_slugs), source_ids=[],
            scope_type=scope_type, scope_id=scope_id,
            # apply_create writes the v1 revision; attribute it to the approval
            # path instead of the default "agent_compile" since this came from
            # a reviewer accepting a contributor's create-draft.
            revision_change_type="draft_approved_create",
            revision_draft_id=draft.id,
            revision_changed_by_id=reviewer_id,
            revision_change_note=reviewer_note,
        )
        # Backfill draft.page_id so subsequent UI reads can join cleanly.
        draft.page_id = page.id
    else:
        page = await session.get(WikiPage, draft.page_id) if draft.page_id else None
        if page is None:
            raise ValueError(f"Wiki page {draft.page_id} not found")

        if (
            not allow_conflict
            and edited_content_md is None
            and draft.base_version is not None
            and page.version is not None
            and draft.base_version < page.version
        ):
            raise DraftConflictError(page.version, draft.base_version)

        page.content_md = final_content
        page.version = (page.version or 1) + 1
        await session.flush()
        await refresh_links(session, page.id, page.slug, final_content)

        session.add(WikiPageRevision(
            page_id=page.id,
            version=page.version,
            content_md=final_content,
            change_type="draft_approved",
            draft_id=draft.id,
            changed_by_id=reviewer_id,
            change_note=reviewer_note,
        ))

    draft.status = "approved"
    draft.reviewed_by_id = reviewer_id
    draft.reviewed_at = datetime.now(timezone.utc)
    draft.reviewer_note = reviewer_note
    await session.flush()
    return page


async def reject_draft(
    session: AsyncSession,
    draft: WikiPageDraft,
    reviewer_id: uuid.UUID,
    reviewer_note: str,
) -> WikiPageDraft:
    """Reject a pending draft with a required reason."""
    draft.status = "rejected"
    draft.reviewed_by_id = reviewer_id
    draft.reviewed_at = datetime.now(timezone.utc)
    draft.reviewer_note = reviewer_note
    await session.flush()
    return draft


async def direct_edit_page(
    session: AsyncSession,
    page: WikiPage,
    editor_id: uuid.UUID,
    content_md: str,
    change_note: Optional[str] = None,
) -> WikiPage:
    """
    Sync write by an editor/admin — no review step.
    Creates a revision immediately.
    """
    page.content_md = content_md
    page.version = (page.version or 1) + 1
    await session.flush()
    await refresh_links(session, page.id, page.slug, content_md)

    session.add(WikiPageRevision(
        page_id=page.id,
        version=page.version,
        content_md=content_md,
        change_type="editor_edit",
        changed_by_id=editor_id,
        change_note=change_note,
    ))
    await session.flush()
    return page


async def rollback_to_revision(
    session: AsyncSession,
    page: WikiPage,
    target_version: int,
    actor_id: uuid.UUID,
) -> WikiPage:
    """
    Restore a page to a previous revision snapshot.
    Creates a new revision recording the rollback.
    """
    revision = (await session.execute(
        select(WikiPageRevision).where(
            WikiPageRevision.page_id == page.id,
            WikiPageRevision.version == target_version,
        )
    )).scalar_one_or_none()
    if revision is None:
        raise ValueError(f"Revision v{target_version} not found for page {page.slug}")

    page.content_md = revision.content_md
    page.version = (page.version or 1) + 1
    await session.flush()
    await refresh_links(session, page.id, page.slug, revision.content_md)

    session.add(WikiPageRevision(
        page_id=page.id,
        version=page.version,
        content_md=revision.content_md,
        change_type="rollback",
        changed_by_id=actor_id,
        change_note=f"rollback to v{target_version}",
    ))
    await session.flush()
    return page
