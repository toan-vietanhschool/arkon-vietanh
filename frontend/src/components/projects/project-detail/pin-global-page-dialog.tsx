"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";

type PinnablePage = {
  id: string;
  slug: string;
  title: string;
  page_type: string;
  summary: string;
  scope_type: string;
  updated_at: string | null;
};

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onPinned: () => void;
};

export function PinGlobalPageDialog({ projectId, open, onClose, onPinned }: Props) {
  const t = useTranslations("Projects.pinGlobalPage");
  const tCommon = useTranslations("Common");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<PinnablePage[]>([]);
  const [loading, setLoading] = useState(false);
  const [pinning, setPinning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ scope_type: "global", limit: "100" });
    if (search.trim()) qs.set("search", search.trim());
    api<PinnablePage[]>(`/api/projects/${projectId}/wiki/pinnable?${qs.toString()}`)
      .then(setPages)
      .catch((err: Error) => {
        setError(err.message);
        setPages([]);
      })
      .finally(() => setLoading(false));
  }, [open, projectId, search]);

  if (!open) return null;

  const handlePin = async (page: PinnablePage) => {
    setPinning(page.id);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/wiki/pinned`, {
        method: "POST",
        body: { page_id: page.id },
      });
      setPages((prev) => prev.filter((p) => p.id !== page.id));
      onPinned();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pin failed");
    } finally {
      setPinning(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-global-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 id="pin-global-title" className="text-base font-semibold">
              {t("title")}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t("description")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon("close")}
            className="text-muted-foreground hover:text-foreground"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="px-6 py-3 border-b border-border">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-3">
          {error && (
            <p className="text-xs text-destructive mb-3">{error}</p>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="material-symbols-outlined text-3xl text-muted-foreground animate-spin">
                progress_activity
              </span>
            </div>
          ) : pages.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center italic">
              {t("empty")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {pages.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-muted/40 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-sm truncate">{p.title || p.slug}</span>
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200">
                        {p.scope_type}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                      {p.slug}
                    </p>
                    {p.summary && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{p.summary}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handlePin(p)}
                    disabled={pinning === p.id}
                  >
                    {pinning === p.id ? (
                      <span className="material-symbols-outlined text-sm animate-spin">
                        progress_activity
                      </span>
                    ) : (
                      <>
                        <span className="material-symbols-outlined text-sm mr-1">push_pin</span>
                        {t("pinAction")}
                      </>
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-6 py-3 border-t border-border flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            {tCommon("close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
