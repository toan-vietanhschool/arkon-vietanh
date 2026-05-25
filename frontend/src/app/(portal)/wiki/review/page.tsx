"use client";

import React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DraftResponse } from "@/types/wiki";
import { WikiDraftDiff } from "@/components/wiki/wiki-draft-diff";
import { WikiAiCheckPanel } from "@/components/wiki/wiki-ai-check-panel";
import { WikiContent } from "@/components/wiki/wiki-content";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";

/**
 * Dedicated review console — 3-pane layout for high-volume reviewers.
 *
 * Layout:
 *   [queue list] | [diff / proposed / current] | [meta + AI + actions]
 *
 * URL state:
 *   ?draft=<uuid>   selected draft (also drives detail panes)
 *   ?status=...     pending | needs_revision | approved | rejected
 *   ?mine=true      author view (drafts I authored)
 *
 * Keyboard shortcuts (focus must NOT be in a textarea/input):
 *   j / ↓     next draft
 *   k / ↑     previous draft
 *   a         approve
 *   r         open reject note
 *   c         open request-changes note
 *   Esc       cancel pending action
 *   ?         toggle shortcut help
 */

type ScopeMode = "review" | "mine";
type StatusFilter = "pending" | "needs_revision" | "approved" | "rejected";
type CenterTab = "diff" | "proposed" | "current";
type ActionMode = "approve" | "reject" | "request_changes" | null;

const MIN_NOTE_LENGTH = 20;
const AI_POLL_INTERVAL_MS = 3000;

function relativeTime(iso: string): string {
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function aiBadgeClass(status: string): string {
  switch (status) {
    case "passed":
      return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-200";
    case "warned":
      return "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-200";
    case "failed":
      return "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-200";
    case "running":
    case "queued":
      return "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export default function WikiReviewPage() {
  const t = useTranslations("WikiReview");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();

  const status = (searchParams.get("status") as StatusFilter) || "pending";
  const scopeMode: ScopeMode = searchParams.get("mine") === "true" ? "mine" : "review";
  const selectedId = searchParams.get("draft");
  // Client-side scope filter. Encoded as "scopeType:scopeId" (or just
  // "scopeType" for global/no-id). Empty = all scopes. Filter runs over the
  // already-loaded drafts list — no extra API call needed.
  const scopeKey = searchParams.get("scope") || "";

  const [drafts, setDrafts] = React.useState<DraftResponse[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [helpOpen, setHelpOpen] = React.useState(false);
  // Snapshot of the current page content for the active draft (loaded on demand).
  const [pageContent, setPageContent] = React.useState<string>("");
  const [pageContentLoading, setPageContentLoading] = React.useState(false);
  // Live draft snapshot (overrides list item — used to poll AI status updates).
  const [liveDraft, setLiveDraft] = React.useState<DraftResponse | null>(null);
  const [centerTab, setCenterTab] = React.useState<CenterTab>("diff");
  const [compareWithDraftId, setCompareWithDraftId] = React.useState<string>("");
  const [actionMode, setActionMode] = React.useState<ActionMode>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [rerunBusy, setRerunBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const noteRef = React.useRef<HTMLTextAreaElement>(null);

  // ---------- URL helpers ----------

  const updateUrl = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `/wiki/review?${qs}` : "/wiki/review", { scroll: false });
    },
    [router, searchParams],
  );

  // ---------- Data loading ----------

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("status", status);
      qs.set("limit", "200");
      if (scopeMode === "mine") qs.set("mine", "true");
      const rows = await api<DraftResponse[]>(`/api/wiki/drafts?${qs.toString()}`);
      const list = Array.isArray(rows) ? rows : [];
      setDrafts(list);
      // If current selection isn't in this list, snap to the first item.
      if (list.length > 0 && (!selectedId || !list.some((d) => d.id === selectedId))) {
        updateUrl({ draft: list[0].id });
      } else if (list.length === 0 && selectedId) {
        updateUrl({ draft: null });
      }
    } catch {
      setDrafts([]);
    } finally {
      setLoading(false);
    }
    // selectedId intentionally excluded — load runs on filter changes, not on
    // every selection change. Selection-driven URL writeback uses updateUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, scopeMode]);

  React.useEffect(() => {
    load();
  }, [load]);

  // ---------- Scope filter (client-side over loaded drafts) ----------

  // Unique scope options derived from the loaded drafts. Keyed as
  // "scopeType:scopeId" (or "global" for the global scope). Stable order:
  // global first, then alpha by label.
  const scopeOptions = React.useMemo(() => {
    const seen = new Map<string, { key: string; label: string }>();
    for (const d of drafts) {
      const type = d.page_scope_type || "global";
      const id = d.page_scope_id || "";
      const key = type === "global" ? "global" : `${type}:${id}`;
      if (seen.has(key)) continue;
      const label =
        type === "global"
          ? t("scopeGlobal")
          : `${d.page_scope_name || id}${d.page_scope_name ? "" : ""} · ${type}`;
      seen.set(key, { key, label });
    }
    const arr = Array.from(seen.values());
    arr.sort((a, b) => {
      if (a.key === "global") return -1;
      if (b.key === "global") return 1;
      return a.label.localeCompare(b.label);
    });
    return arr;
  }, [drafts]);

  const filteredDrafts = React.useMemo(() => {
    if (!scopeKey) return drafts;
    return drafts.filter((d) => {
      const type = d.page_scope_type || "global";
      const id = d.page_scope_id || "";
      const key = type === "global" ? "global" : `${type}:${id}`;
      return key === scopeKey;
    });
  }, [drafts, scopeKey]);

  // If the current selection is filtered out, snap to the first visible draft.
  React.useEffect(() => {
    if (filteredDrafts.length === 0) return;
    if (!selectedId || !filteredDrafts.some((d) => d.id === selectedId)) {
      updateUrl({ draft: filteredDrafts[0].id });
    }
    // updateUrl is stable; intentionally omit to avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredDrafts, selectedId]);

  // ---------- Active draft + page content ----------

  const activeDraft = React.useMemo(() => {
    if (!selectedId) return filteredDrafts[0] ?? null;
    return filteredDrafts.find((d) => d.id === selectedId) ?? filteredDrafts[0] ?? null;
  }, [filteredDrafts, selectedId]);

  // When active draft has a fresh liveDraft snapshot (same id), prefer it for
  // AI status. Falls back to the list row otherwise.
  const draft =
    liveDraft && activeDraft && liveDraft.id === activeDraft.id ? liveDraft : activeDraft;

  // Reset state when active draft changes.
  React.useEffect(() => {
    setLiveDraft(null);
    setActionMode(null);
    setNote("");
    setError(null);
    setCompareWithDraftId("");
    setCenterTab(draft?.draft_kind === "create" ? "proposed" : "diff");
  }, [draft?.id, draft?.draft_kind]);

  // Load the parent page's current content for the diff. Skip for create drafts.
  React.useEffect(() => {
    if (!draft || draft.draft_kind === "create" || !draft.page_slug) {
      setPageContent("");
      return;
    }
    setPageContentLoading(true);
    const qs = new URLSearchParams();
    if (draft.page_scope_type) qs.set("scope_type", draft.page_scope_type);
    if (draft.page_scope_id) qs.set("scope_id", draft.page_scope_id);
    api<{ content_md?: string }>(`/api/wiki/pages/${draft.page_slug}?${qs.toString()}`)
      .then((p) => setPageContent(p?.content_md || ""))
      .catch(() => setPageContent(""))
      .finally(() => setPageContentLoading(false));
  }, [draft?.id, draft?.draft_kind, draft?.page_slug, draft?.page_scope_type, draft?.page_scope_id]);

  // Poll AI status while pending/running.
  React.useEffect(() => {
    if (!draft) return;
    const running = draft.ai_check_status === "pending" || draft.ai_check_status === "running" || draft.ai_check_status === "queued";
    if (!running) return;
    const id = setInterval(async () => {
      try {
        const fresh = await api<DraftResponse>(`/api/wiki/drafts/${draft.id}`);
        setLiveDraft(fresh);
        if (!["pending", "running", "queued"].includes(fresh.ai_check_status)) {
          clearInterval(id);
        }
      } catch {
        /* silent */
      }
    }, AI_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [draft?.id, draft?.ai_check_status]);

  // ---------- Navigation between drafts ----------

  const selectIndex = React.useCallback(
    (idx: number) => {
      if (filteredDrafts.length === 0) return;
      const clamped = Math.max(0, Math.min(filteredDrafts.length - 1, idx));
      updateUrl({ draft: filteredDrafts[clamped].id });
    },
    [filteredDrafts, updateUrl],
  );

  const activeIdx = React.useMemo(
    () => (draft ? filteredDrafts.findIndex((d) => d.id === draft.id) : -1),
    [filteredDrafts, draft],
  );

  const goNext = React.useCallback(() => selectIndex(activeIdx + 1), [activeIdx, selectIndex]);
  const goPrev = React.useCallback(() => selectIndex(activeIdx - 1), [activeIdx, selectIndex]);

  // ---------- Reviewer actions ----------

  const resetForm = React.useCallback(() => {
    setActionMode(null);
    setNote("");
    setError(null);
  }, []);

  const advanceAfterAction = React.useCallback(() => {
    // Remove the just-actioned draft and pick the next one in the *visible*
    // (filtered) list — activeIdx is indexed against filteredDrafts.
    if (!draft) return;
    const nextVisible = filteredDrafts.filter((d) => d.id !== draft.id);
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    if (nextVisible.length === 0) {
      updateUrl({ draft: null });
    } else {
      const nextIdx = Math.min(activeIdx, nextVisible.length - 1);
      updateUrl({ draft: nextVisible[nextIdx].id });
    }
    resetForm();
  }, [draft, filteredDrafts, activeIdx, updateUrl, resetForm]);

  const handleApprove = React.useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/wiki/drafts/${draft.id}/approve`, {
        method: "POST",
        body: { allow_conflict: draft.has_conflict ? true : undefined },
      });
      advanceAfterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.approveFailed"));
    } finally {
      setBusy(false);
    }
  }, [draft, advanceAfterAction, t]);

  const handleNoteSubmit = React.useCallback(async () => {
    if (!draft || !actionMode || actionMode === "approve") return;
    if (note.trim().length < MIN_NOTE_LENGTH) {
      setError(t("errors.noteLengthError", { min: MIN_NOTE_LENGTH }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const endpoint =
        actionMode === "reject"
          ? `/api/wiki/drafts/${draft.id}/reject`
          : `/api/wiki/drafts/${draft.id}/request-changes`;
      await api(endpoint, { method: "POST", body: { reviewer_note: note } });
      advanceAfterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }, [draft, actionMode, note, advanceAfterAction, t]);

  const handleRerunAiReview = React.useCallback(async () => {
    if (!draft) return;
    setRerunBusy(true);
    setError(null);
    try {
      const fresh = await api<DraftResponse>(
        `/api/wiki/drafts/${draft.id}/rerun-ai-review`,
        { method: "POST" },
      );
      setDrafts((prev) => prev.map((d) => (d.id === fresh.id ? fresh : d)));
      setLiveDraft(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.recheckFailed"));
    } finally {
      setRerunBusy(false);
    }
  }, [draft, t]);

  const handleWithdraw = React.useCallback(async () => {
    if (!draft) return;
    if (!window.confirm(t("withdrawConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/wiki/drafts/${draft.id}/withdraw`, { method: "POST" });
      advanceAfterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.withdrawFailed"));
    } finally {
      setBusy(false);
    }
  }, [draft, advanceAfterAction, t]);

  // ---------- Keyboard shortcuts ----------

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in a form field.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || target.isContentEditable) {
          if (e.key === "Escape") resetForm();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          goNext();
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          goPrev();
          break;
        case "a":
          if (draft && draft.status === "pending" && !actionMode) {
            e.preventDefault();
            void handleApprove();
          }
          break;
        case "r":
          if (draft && draft.status === "pending") {
            e.preventDefault();
            setActionMode("reject");
            setNote("");
            setTimeout(() => noteRef.current?.focus(), 0);
          }
          break;
        case "c":
          if (draft && draft.status === "pending") {
            e.preventDefault();
            setActionMode("request_changes");
            setNote("");
            setTimeout(() => noteRef.current?.focus(), 0);
          }
          break;
        case "Escape":
          if (actionMode) {
            e.preventDefault();
            resetForm();
          }
          break;
        case "?":
          e.preventDefault();
          setHelpOpen((o) => !o);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [draft, actionMode, goNext, goPrev, handleApprove, resetForm]);

  // ---------- Render ----------

  const currentUserId = user?.id ?? null;
  const isOwnDraft = !!draft && !!currentUserId && draft.author_id === currentUserId;
  const isCreate = draft?.draft_kind === "create";
  const isPending = draft?.status === "pending";
  const isNeedsRevision = draft?.status === "needs_revision";

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: "pending", label: t("statusFilter.pending") },
    { value: "needs_revision", label: t("statusFilter.needs_revision") },
    { value: "approved", label: t("statusFilter.approved") },
    { value: "rejected", label: t("statusFilter.rejected") },
  ];

  return (
    <div className="flex-1 min-h-0 -mx-6 -my-4 md:-mx-8 lg:-mx-10 grid grid-cols-[320px_1fr_340px] gap-0 border-t border-border">
      {/* ============================ Left pane: queue ========================= */}
      <aside className="border-r border-border flex flex-col min-h-0 bg-card/30">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("queueTitle")}</h2>
            <button
              type="button"
              onClick={() => setHelpOpen((o) => !o)}
              className="text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
              title={t("shortcutsHint")}
            >
              <kbd className="font-mono">?</kbd>
            </button>
          </div>

          <div className="inline-flex rounded-md border border-border bg-background p-0.5 w-full">
            {([
              { v: "review" as const, l: t("tabs.toReview"), i: "fact_check" },
              { v: "mine" as const, l: t("tabs.mine"), i: "edit_note" },
            ]).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => updateUrl({ mine: opt.v === "mine" ? "true" : null, draft: null })}
                className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                  scopeMode === opt.v
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{opt.i}</span>
                {opt.l}
              </button>
            ))}
          </div>

          <select
            value={status}
            onChange={(e) => updateUrl({ status: e.target.value, draft: null })}
            className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring"
          >
            {statusOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {scopeOptions.length > 1 && (
            <select
              value={scopeKey}
              onChange={(e) => updateUrl({ scope: e.target.value || null, draft: null })}
              className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring"
              title={t("scopeFilterTitle")}
            >
              <option value="">{t("allScopes", { count: drafts.length })}</option>
              {scopeOptions.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          )}

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {loading
                ? t("loading")
                : scopeKey
                  ? t("draftCountFiltered", { filtered: filteredDrafts.length, total: drafts.length })
                  : t("draftCount", { count: drafts.length })}
            </span>
            <button
              type="button"
              onClick={load}
              className="hover:text-foreground gap-0.5 inline-flex items-center"
              title={t("refresh")}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? null : filteredDrafts.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon="inbox"
                title={t("queueEmpty.title")}
                description={
                  scopeKey && drafts.length > 0
                    ? t("queueEmpty.descriptionScope")
                    : t("queueEmpty.descriptionStatus", { status })
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filteredDrafts.map((d) => {
                const active = draft?.id === d.id;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => updateUrl({ draft: d.id })}
                      className={`w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors ${
                        active ? "bg-primary/10 border-l-2 border-l-primary" : "border-l-2 border-l-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {d.draft_kind === "create" && (
                          <span className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200">
                            {t("listItem.new")}
                          </span>
                        )}
                        {d.has_conflict && (
                          <span className="text-[9px] uppercase tracking-wide px-1 py-px rounded bg-destructive/15 text-destructive">
                            {t("listItem.conflict")}
                          </span>
                        )}
                        <p className="text-sm font-medium truncate flex-1">
                          {d.page_title || d.page_slug}
                        </p>
                      </div>
                      <p className="text-[11px] text-muted-foreground font-mono truncate">
                        {d.page_slug}
                        {d.page_scope_type && d.page_scope_type !== "global" && (
                          <span className="ml-1 font-sans">· {d.page_scope_type}{d.page_scope_name ? `:${d.page_scope_name}` : ""}</span>
                        )}
                      </p>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                        <span>{d.author_name || "?"}</span>
                        <span>·</span>
                        <span>{relativeTime(d.created_at)}</span>
                        {(d.revision_round ?? 0) > 0 && (
                          <>
                            <span>·</span>
                            <span>r{(d.revision_round ?? 0) + 1}</span>
                          </>
                        )}
                      </div>
                      <span className={`mt-1 inline-block text-[9px] uppercase tracking-wide px-1 py-px rounded ${aiBadgeClass(d.ai_check_status)}`}>
                        {t("listItem.aiStatus", { status: d.ai_check_status })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ============================ Center pane: diff ======================== */}
      <section className="flex flex-col min-h-0 bg-background">
        {!draft ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="text-sm text-muted-foreground italic">
              {loading ? t("loading") : t("center.selectPrompt")}
            </p>
          </div>
        ) : (
          <>
            {/* Sticky header with title + tab toggle */}
            <div className="border-b border-border px-5 py-3 sticky top-0 bg-background z-10">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h1 className="text-base font-semibold flex items-center gap-2 flex-wrap">
                    {isCreate && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200">
                        {t("center.newPageBadge")}
                      </span>
                    )}
                    <span className="truncate">{draft.page_title || draft.page_slug}</span>
                    {draft.has_conflict && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-destructive/15 text-destructive">
                        {t("center.conflict", { base: draft.base_version ?? "?", page: draft.page_version })}
                      </span>
                    )}
                  </h1>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {draft.page_slug}
                    {draft.page_scope_type && draft.page_scope_type !== "global" && (
                      <span className="ml-2 font-sans">
                        · {draft.page_scope_type}{draft.page_scope_name ? ` · ${draft.page_scope_name}` : ""}
                      </span>
                    )}
                    {draft.page_slug && !isCreate && (
                      <>
                        {" · "}
                        <Link
                          href={`/wiki/${draft.page_slug}${
                            draft.page_scope_type !== "global"
                              ? `?scopeType=${draft.page_scope_type}${draft.page_scope_id ? `&scopeId=${draft.page_scope_id}` : ""}`
                              : ""
                          }`}
                          className="font-sans hover:underline text-primary"
                          target="_blank"
                        >
                          {t("center.openPage")}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {t("rightPane.counter", { current: activeIdx + 1, total: filteredDrafts.length })}
                </div>
              </div>

              {/* Tab toggle */}
              <div className="flex gap-1 mt-3">
                {(isCreate ? (["proposed"] as const) : (["diff", "proposed", "current"] as const)).map((tabKey) => (
                  <button
                    key={tabKey}
                    type="button"
                    onClick={() => setCenterTab(tabKey)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors capitalize ${
                      centerTab === tabKey
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    {tabKey === "current"
                      ? t("center.tabs.current")
                      : tabKey === "proposed"
                        ? t("center.tabs.proposed")
                        : t("center.tabs.diff")}
                  </button>
                ))}

                {centerTab === "diff" && !isCreate && drafts.length > 1 && (
                  <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{t("center.compareWith")}</span>
                    <select
                      value={compareWithDraftId}
                      onChange={(e) => setCompareWithDraftId(e.target.value)}
                      className="h-6 rounded border border-input bg-background px-1.5 text-[11px] focus:outline-none"
                    >
                      <option value="">{t("center.compareCurrent")}</option>
                      {drafts
                        .filter((d) => d.id !== draft.id && d.draft_kind !== "create" && d.page_id === draft.page_id)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {(d.revision_round ?? 0) > 0
                              ? t("center.compareDraftRound", { author: d.author_name || "?", round: (d.revision_round ?? 0) + 1 })
                              : t("center.compareDraft", { author: d.author_name || "?" })}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4">
              {centerTab === "diff" && !isCreate ? (
                pageContentLoading ? (
                  <p className="text-xs text-muted-foreground italic">{t("center.loadingPage")}</p>
                ) : (
                  <WikiDraftDiff
                    oldText={
                      compareWithDraftId
                        ? drafts.find((d) => d.id === compareWithDraftId)?.content_md ?? pageContent
                        : pageContent
                    }
                    newText={draft.content_md}
                    mode="unified"
                    contextLines={3}
                  />
                )
              ) : centerTab === "proposed" || isCreate ? (
                draft.content_md.trim() ? (
                  <WikiContent markdown={draft.content_md} />
                ) : (
                  <p className="text-sm text-muted-foreground italic">{t("center.emptyContent")}</p>
                )
              ) : (
                <WikiContent markdown={pageContent || "_(empty page)_"} />
              )}
            </div>
          </>
        )}
      </section>

      {/* ============================ Right pane: meta + actions =============== */}
      <aside className="border-l border-border flex flex-col min-h-0 bg-card/30">
        {!draft ? (
          <div className="p-4 text-xs text-muted-foreground italic">{t("rightPane.noSelection")}</div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4">
            {/* Author block */}
            <section>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{t("rightPane.sectionAuthor")}</p>
              <p className="text-sm font-medium">{draft.author_name || t("rightPane.authorUnknown")}</p>
              {draft.author_stats && draft.author_stats.total_reviewed > 0 ? (
                <p
                  className="text-[11px] text-muted-foreground tabular-nums"
                  title={
                    draft.author_stats.needs_revision
                      ? t("rightPane.authorStatsWithRevision", {
                          approved: draft.author_stats.approved,
                          rejected: draft.author_stats.rejected,
                          revision: draft.author_stats.needs_revision,
                        })
                      : t("rightPane.authorStatsTitle", {
                          approved: draft.author_stats.approved,
                          rejected: draft.author_stats.rejected,
                        })
                  }
                >
                  {t("rightPane.authorStats", {
                    approved: draft.author_stats.approved,
                    pct: Math.round(draft.author_stats.accuracy * 100),
                  })}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground italic">{t("rightPane.firstContribution")}</p>
              )}
            </section>

            {/* Submission */}
            <section>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{t("rightPane.sectionSubmitted")}</p>
              <p className="text-sm">{relativeTime(draft.created_at)}</p>
              <p className="text-[11px] text-muted-foreground">{t("rightPane.round", { round: (draft.revision_round ?? 0) + 1 })}</p>
              {draft.note && (
                <p className="text-xs text-muted-foreground mt-1.5 italic">&ldquo;{draft.note}&rdquo;</p>
              )}
              {isNeedsRevision && draft.last_returned_note && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  <span className="font-medium">{t("rightPane.reviewerAsked")}</span> {draft.last_returned_note}
                </p>
              )}
            </section>

            {/* Suggested metadata for create drafts */}
            {isCreate && draft.suggested_metadata && (
              <section>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{t("rightPane.sectionSuggestedPage")}</p>
                <p className="text-xs">
                  <span className="font-mono">{draft.suggested_metadata.slug}</span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {draft.suggested_metadata.page_type} · {draft.suggested_metadata.scope_type}
                </p>
                {!!draft.suggested_metadata.knowledge_type_slugs?.length && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {t("rightPane.tags", { tags: draft.suggested_metadata.knowledge_type_slugs.join(", ") })}
                  </p>
                )}
              </section>
            )}

            {/* Suggested reviewers */}
            {draft.suggested_reviewers && draft.suggested_reviewers.length > 0 && (
              <section>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{t("rightPane.sectionSuggestedReviewers")}</p>
                <ul className="space-y-0.5">
                  {draft.suggested_reviewers.map((r) => (
                    <li key={r.id} className="text-xs flex justify-between items-baseline gap-2">
                      <span className="truncate">{r.name || r.email || "?"}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{r.score}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* AI check panel */}
            <section>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{t("rightPane.sectionAiPreview")}</p>
              <WikiAiCheckPanel
                status={draft.ai_check_status}
                results={draft.ai_check_results}
                onRerun={handleRerunAiReview}
                rerunBusy={rerunBusy}
              />
            </section>

            {/* Action area */}
            <section className="border-t border-border pt-3">
              {error && <p className="text-xs text-destructive mb-2">{error}</p>}

              {actionMode === "reject" || actionMode === "request_changes" ? (
                <div className="space-y-2">
                  <label className="block text-xs font-medium">
                    {actionMode === "reject" ? t("note.rejectLabel") : t("note.requestChangesLabel")}
                  </label>
                  <textarea
                    ref={noteRef}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={4}
                    placeholder={
                      actionMode === "reject"
                        ? t("note.rejectPlaceholder")
                        : t("note.requestChangesPlaceholder")
                    }
                    className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring/30 resize-none"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t("note.charMin", { current: note.trim().length, min: MIN_NOTE_LENGTH })}
                  </p>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" size="sm" onClick={resetForm} disabled={busy}>
                      {t("actions.cancel")} <kbd className="ml-1 text-[10px] opacity-60">{t("actions.cancelKey")}</kbd>
                    </Button>
                    <Button
                      size="sm"
                      variant={actionMode === "reject" ? "destructive" : "default"}
                      onClick={handleNoteSubmit}
                      disabled={busy || note.trim().length < MIN_NOTE_LENGTH}
                    >
                      {busy ? (
                        <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                      ) : (
                        <span className="material-symbols-outlined text-sm">
                          {actionMode === "reject" ? "cancel" : "edit_note"}
                        </span>
                      )}
                      {actionMode === "reject" ? t("actions.confirmReject") : t("actions.sendBack")}
                    </Button>
                  </div>
                </div>
              ) : isOwnDraft ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground italic">{t("rightPane.ownDraft")}</p>
                  {(isPending || isNeedsRevision) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleWithdraw}
                      disabled={busy}
                      className="w-full"
                    >
                      <span className="material-symbols-outlined text-sm mr-1">remove_circle</span>
                      {t("actions.withdraw")}
                    </Button>
                  )}
                </div>
              ) : !isPending ? (
                <p className="text-xs text-muted-foreground italic">
                  {draft.status === "needs_revision"
                    ? t("rightPane.waitingResubmit")
                    : t("rightPane.draftStatus", { status: draft.status })}
                </p>
              ) : (
                <div className="space-y-2">
                  <Button
                    size="sm"
                    onClick={handleApprove}
                    disabled={busy}
                    className="w-full justify-between"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      {t("actions.approve")}
                    </span>
                    <kbd className="text-[10px] opacity-70">{t("actions.approveKey")}</kbd>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setActionMode("request_changes"); setNote(""); setTimeout(() => noteRef.current?.focus(), 0); }}
                    disabled={busy}
                    className="w-full justify-between"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">edit_note</span>
                      {t("actions.requestChanges")}
                    </span>
                    <kbd className="text-[10px] opacity-70">{t("actions.requestChangesKey")}</kbd>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setActionMode("reject"); setNote(""); setTimeout(() => noteRef.current?.focus(), 0); }}
                    disabled={busy}
                    className="w-full justify-between"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">cancel</span>
                      {t("actions.reject")}
                    </span>
                    <kbd className="text-[10px] opacity-70">{t("actions.rejectKey")}</kbd>
                  </Button>
                </div>
              )}
            </section>
          </div>
        )}
      </aside>

      {/* Keyboard help overlay */}
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="bg-background border border-border rounded-xl shadow-lg p-6 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">{t("shortcuts.title")}</h3>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t("shortcuts.close")}
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>
            <dl className="space-y-2 text-sm">
              {([
                [t("shortcuts.keys.nextDraft"), t("shortcuts.nextDraft")],
                [t("shortcuts.keys.prevDraft"), t("shortcuts.prevDraft")],
                [t("shortcuts.keys.approve"), t("shortcuts.approveCurrent")],
                [t("shortcuts.keys.requestChanges"), t("shortcuts.requestChanges")],
                [t("shortcuts.keys.reject"), t("shortcuts.reject")],
                [t("shortcuts.keys.cancel"), t("shortcuts.cancelAction")],
                [t("shortcuts.keys.help"), t("shortcuts.toggleHelp")],
              ] as [string, string][]).map(([key, label]) => (
                <div key={key} className="flex justify-between items-baseline">
                  <kbd className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{key}</kbd>
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
              ))}
            </dl>
            <p className="text-[10px] text-muted-foreground mt-4 italic">
              {t("shortcuts.disabledInField")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
