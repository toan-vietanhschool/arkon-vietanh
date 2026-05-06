import React, { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { WikiTypeBadge, wikiTypeGroupLabel } from "@/components/wiki/wiki-type-badge";
import { ScopeBadge } from "@/components/shared/scope-badge";
import { WikiContent } from "@/components/wiki/wiki-content";
import { WikiPageDetail } from "@/types/wiki";

export function WikiDetailInline({
  slug,
  projectId,
  onBack,
  onPageLoaded,
  onNavigate,
}: {
  slug: string;
  projectId: string;
  onBack: () => void;
  onPageLoaded: (page: WikiPageDetail) => void;
  onNavigate: (slug: string) => void;
}) {
  const [page, setPage] = useState<WikiPageDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setPage(null);
    api<WikiPageDetail>(`/api/wiki/pages/${encodeURIComponent(slug)}?scope_type=project&scope_id=${projectId}`)
      .then((data) => { setPage(data); onPageLoaded(data); })
      .catch(() => setPage(null))
      .finally(() => setLoading(false));
  }, [slug, projectId]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-6">
          <div className="h-4 w-16 rounded bg-muted animate-pulse" />
          <div className="h-4 w-24 rounded bg-muted animate-pulse" />
        </div>
        <div className="h-10 w-2/3 rounded-lg bg-muted animate-pulse mb-3" />
        <div className="h-4 w-full rounded bg-muted animate-pulse mb-2" />
        <div className="h-4 w-5/6 rounded bg-muted animate-pulse mb-8" />
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-4 rounded bg-muted animate-pulse"
              style={{ width: `${85 - i * 5}%`, opacity: 1 - i * 0.08 }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <span className="material-symbols-outlined text-4xl text-muted-foreground">find_in_page</span>
        <p className="text-sm text-muted-foreground">Page not found: {slug}</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          <span className="material-symbols-outlined text-base mr-1">arrow_back</span>
          Back to list
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-8 h-8 rounded-full border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors shrink-0 shadow-sm"
          title="Back to pages"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        </button>
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <button
            onClick={onBack}
            className="hover:text-foreground transition-colors font-medium"
          >
            Wiki
          </button>
          <span className="material-symbols-outlined text-muted-foreground/50" style={{ fontSize: 14 }}>chevron_right</span>
          <span className="capitalize font-medium">
            {wikiTypeGroupLabel(page.page_type)}
          </span>
          <span className="material-symbols-outlined text-muted-foreground/50" style={{ fontSize: 14 }}>chevron_right</span>
          <span className="text-foreground font-semibold truncate max-w-[200px]">
            {page.title}
          </span>
        </nav>
      </div>

      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <WikiTypeBadge type={page.page_type} />
          <ScopeBadge scopeType="workspace" />
          <span className="text-xs text-muted-foreground ml-auto">v{page.version}</span>
        </div>
        <h1 className="font-heading text-4xl font-normal leading-tight text-foreground">
          {page.title}
        </h1>
        {page.summary && (
          <p className="mt-2 text-muted-foreground text-sm leading-6">{page.summary}</p>
        )}
      </div>

      {/* Markdown body */}
      <WikiContent markdown={page.content_md} onWikiLinkClick={onNavigate} />
    </div>
  );
}
