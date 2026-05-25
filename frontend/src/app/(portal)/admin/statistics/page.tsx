"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { BarList, LineChart } from "@/components/stats/charts";

/* ──────────────────────────────────────────────────────────────────────── */
/* Types                                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

type TimeSeriesPoint = {
  date: string;
  value: number | null;
  dimensions?: Record<string, unknown> | null;
  items?: Array<Record<string, unknown>> | null;
};

type SectionResponse = {
  from_date: string;
  to_date: string;
  series: Record<string, TimeSeriesPoint[]>;
  latest: Record<string, number | null>;
  latest_lists: Record<string, Array<Record<string, unknown>>>;
};

type OverviewResponse = {
  as_of: string;
  kpis: Record<string, number | null>;
  top_gap_topic: { normalized?: string; count?: number; samples?: string[] } | null;
  top_contributor: { name?: string; count?: number; author_id?: string } | null;
};

type GapItem = {
  normalized: string;
  count: number;
  samples: string[];
  requester_ids: string[];
};

type TabKey = "overview" | "content" | "contribution" | "usage" | "gaps";

/* ──────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* KPI card                                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

function KpiCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: string;
  tone?: "default" | "warn" | "good";
}) {
  const toneCls =
    tone === "warn"
      ? "border-amber-500/20 bg-amber-50/40"
      : tone === "good"
      ? "border-emerald-500/20 bg-emerald-50/30"
      : "border-border bg-card";
  return (
    <div className={`rounded-xl border p-3 ${toneCls}`}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon && <span className="material-symbols-outlined text-[14px]">{icon}</span>}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Page                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

export default function StatisticsPage() {
  const t = useTranslations("Stats");
  const [tab, setTab] = useState<TabKey>("overview");
  const [fromDate, setFromDate] = useState<string>(isoDaysAgo(30));
  const [toDate, setToDate] = useState<string>(isoDaysAgo(1));
  const [loading, setLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [content, setContent] = useState<SectionResponse | null>(null);
  const [contribution, setContribution] = useState<SectionResponse | null>(null);
  const [usage, setUsage] = useState<SectionResponse | null>(null);
  const [gaps, setGaps] = useState<{ items: GapItem[] } | null>(null);

  const range = useMemo(() => `from=${fromDate}&to=${toDate}`, [fromDate, toDate]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, ct, cb, us, gp] = await Promise.all([
        api<OverviewResponse>(`/api/admin/stats/overview`),
        api<SectionResponse>(`/api/admin/stats/content?${range}`),
        api<SectionResponse>(`/api/admin/stats/contribution?${range}`),
        api<SectionResponse>(`/api/admin/stats/usage?${range}`),
        api<{ items: GapItem[] }>(`/api/admin/stats/gaps?${range}&limit=50`),
      ]);
      setOverview(ov);
      setContent(ct);
      setContribution(cb);
      setUsage(us);
      setGaps(gp);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failedToLoad"));
    } finally {
      setLoading(false);
    }
  }, [range, t]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const triggerBackfill = async () => {
    setBackfilling(true);
    try {
      await api(`/api/admin/stats/rollup?target=${toDate}`, { method: "POST" });
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("backfillFailed"));
    } finally {
      setBackfilling(false);
    }
  };

  const exportCsv = (section: Exclude<TabKey, "overview">) => {
    const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5055";
    const token = typeof window !== "undefined" ? localStorage.getItem("arkon_token") : null;
    if (!token) return;
    fetch(`${base}/api/admin/stats/export/${section}.csv?${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `stats_${section}_${fromDate}_${toDate}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });
  };

  const tabKeys: TabKey[] = ["overview", "content", "contribution", "usage", "gaps"];

  return (
    <>
      <PageHeader
        title={t("pageTitle")}
        description={t("pageDescription")}
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => loadAll()} disabled={loading}>
              <span className={`material-symbols-outlined text-base mr-2 ${loading ? "animate-spin" : ""}`}>
                refresh
              </span>
              {t("refresh")}
            </Button>
            <Button variant="outline" onClick={triggerBackfill} disabled={backfilling}>
              <span className={`material-symbols-outlined text-base mr-2 ${backfilling ? "animate-spin" : ""}`}>
                calculate
              </span>
              {backfilling ? t("computing") : t("rollup", { date: toDate })}
            </Button>
          </div>
        }
      />

      {/* Filter bar */}
      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{t("filterFrom")}</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{t("filterTo")}</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          />
        </div>
        <div className="flex gap-1 ml-auto">
          {tabKeys.map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`px-3 h-9 text-sm rounded-md border transition-colors ${
                tab === tabKey ? "bg-foreground text-background border-foreground" : "bg-background hover:bg-black/[0.03]"
              }`}
            >
              {t(`tabs.${tabKey}`)}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mt-4 text-sm text-destructive bg-destructive/10 px-4 py-3 rounded-lg flex items-center gap-2">
          <span className="material-symbols-outlined text-base">error</span>
          {error}
        </div>
      )}

      <div className="mt-4">
        {tab === "overview" && <OverviewTab data={overview} />}
        {tab === "content" && <ContentTab data={content} onExport={() => exportCsv("content")} />}
        {tab === "contribution" && <ContributionTab data={contribution} onExport={() => exportCsv("contribution")} />}
        {tab === "usage" && <UsageTab data={usage} onExport={() => exportCsv("usage")} />}
        {tab === "gaps" && <GapsTab data={gaps} onExport={() => exportCsv("gaps")} />}
      </div>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Tabs                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

function OverviewTab({ data }: { data: OverviewResponse | null }) {
  const t = useTranslations("Stats");
  if (!data) return <SkeletonGrid />;
  const k = data.kpis;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label={t("kpi.totalWikiPages")} value={fmtNumber(k["wiki.pages.total"])} icon="auto_stories" />
        <KpiCard
          label={t("kpi.stalePages")}
          value={fmtNumber(k["wiki.pages.stale_30d"])}
          icon="hourglass_empty"
          tone={k["wiki.pages.stale_30d"] && k["wiki.pages.stale_30d"]! > 0 ? "warn" : "default"}
        />
        <KpiCard label={t("kpi.orphanPages")} value={fmtNumber(k["wiki.pages.orphan"])} icon="link_off" tone={k["wiki.pages.orphan"] && k["wiki.pages.orphan"]! > 0 ? "warn" : "default"} />
        <KpiCard label={t("kpi.pagesUpdatedToday")} value={fmtNumber(k["wiki.pages.updated"])} icon="edit_note" />
        <KpiCard label={t("kpi.draftsPending")} value={fmtNumber(k["draft.pending"])} icon="rate_review" />
        <KpiCard label={t("kpi.avgTimeToReview")} value={fmtDuration(k["draft.time_to_review_avg_seconds"])} icon="schedule" />
        <KpiCard label={t("kpi.plansAwaitingReview")} value={fmtNumber(k["compile_plan.pending_review"])} icon="task_alt" />
        <KpiCard label={t("kpi.deniedAccessToday")} value={fmtNumber(k["audit.denied"])} icon="block" tone={k["audit.denied"] && k["audit.denied"]! > 0 ? "warn" : "default"} />
        <KpiCard label={t("kpi.mcpActiveUsersToday")} value={fmtNumber(k["mcp.active_users"])} icon="person" />
        <KpiCard label={t("kpi.mcpWau")} value={fmtNumber(k["mcp.weekly_active_users"])} icon="group" />
        <KpiCard label={t("kpi.mcpQueriesToday")} value={fmtNumber(k["mcp.queries.total"])} icon="search" />
        <KpiCard
          label={t("kpi.zeroResultQueriesToday")}
          value={fmtNumber(k["mcp.queries.zero_result"])}
          icon="search_off"
          tone={k["mcp.queries.zero_result"] && k["mcp.queries.zero_result"]! > 0 ? "warn" : "default"}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm font-medium mb-2">{t("overview.topGapTitle")}</div>
          {data.top_gap_topic ? (
            <>
              <div className="text-lg">{data.top_gap_topic.normalized || "—"}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {t("overview.askedCount", {
                  count: data.top_gap_topic.count ?? 0,
                  sample: data.top_gap_topic.samples?.[0] || "",
                })}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">{t("overview.noGaps")}</div>
          )}
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-sm font-medium mb-2">{t("overview.topContributorTitle")}</div>
          {data.top_contributor ? (
            <>
              <div className="text-lg">{data.top_contributor.name || "—"}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {t("overview.draftsSubmitted", { count: data.top_contributor.count ?? 0 })}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">{t("overview.noDrafts")}</div>
          )}
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground">{t("overview.asOf", { date: data.as_of })}</div>
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function seriesPoints(data: SectionResponse | null, key: string): { date: string; value: number | null }[] {
  if (!data) return [];
  return (data.series[key] || []).map((p) => ({ date: p.date, value: p.value }));
}

function ExportButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations("Stats");
  return (
    <button onClick={onClick} className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">
      {t("exportCsv")}
    </button>
  );
}

function ContentTab({ data, onExport }: { data: SectionResponse | null; onExport: () => void }) {
  const t = useTranslations("Stats");
  if (!data) return <SkeletonGrid />;
  const byType = data.latest_lists["wiki.pages.by_type"] || [];
  const topPages = data.latest_lists["wiki.top_pages"] || [];
  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        <Card title={t("content.pagesUpdatedPerDay")}><LineChart data={seriesPoints(data, "wiki.pages.updated")} /></Card>
        <Card title={t("content.revisionsPerDay")}><LineChart data={seriesPoints(data, "wiki.revisions.daily")} color="#c2652a" /></Card>
        <Card title={t("content.stalePages")}><LineChart data={seriesPoints(data, "wiki.pages.stale_30d")} color="#a04848" /></Card>
        <Card title={t("content.orphanPages")}><LineChart data={seriesPoints(data, "wiki.pages.orphan")} color="#8a6dba" /></Card>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Card title={t("content.pagesByType")}>
          <BarList items={byType.map((b) => ({ name: (b.dimensions as { page_type?: string } | null)?.page_type || b.page_type || "—", count: Number(b.count ?? 0) }))} />
        </Card>
        <Card title={t("content.topEditedPages")} action={<ExportButton onClick={onExport} />}>
          <BarList items={topPages.map((p) => ({ name: p.title || p.slug, count: Number(p.revisions ?? 0) }))} />
        </Card>
      </div>
    </div>
  );
}

function ContributionTab({ data, onExport }: { data: SectionResponse | null; onExport: () => void }) {
  const t = useTranslations("Stats");
  if (!data) return <SkeletonGrid />;
  const topAuthors = data.latest_lists["draft.top_contributors"] || [];
  const topReviewers = data.latest_lists["draft.top_reviewers"] || [];
  const bySource = data.latest_lists["draft.created.by_source"] || [];
  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        <Card title={t("contribution.draftsCreatedPerDay")}><LineChart data={seriesPoints(data, "draft.created")} /></Card>
        <Card title={t("contribution.draftsApprovedRejected")}>
          <LineChart data={seriesPoints(data, "draft.approved")} color="#3d8a4e" label={t("contribution.approved")} />
          <LineChart data={seriesPoints(data, "draft.rejected")} color="#a04848" label={t("contribution.rejected")} />
        </Card>
        <Card title={t("contribution.pendingDrafts")}><LineChart data={seriesPoints(data, "draft.pending")} color="#c2652a" /></Card>
        <Card title={t("contribution.avgTimeToReview")}>
          <LineChart data={seriesPoints(data, "draft.time_to_review_avg_seconds")} />
        </Card>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        <Card title={t("contribution.topContributors")} action={<ExportButton onClick={onExport} />}>
          <BarList items={topAuthors as Array<Record<string, unknown>>} labelKey="name" valueKey="count" />
        </Card>
        <Card title={t("contribution.topReviewers")}>
          <BarList items={topReviewers as Array<Record<string, unknown>>} labelKey="name" valueKey="count" />
        </Card>
        <Card title={t("contribution.bySource")}>
          <BarList
            items={bySource.map((b) => ({
              name: (b.dimensions as { source?: string } | null)?.source || "—",
              count: Number(b.count ?? 0),
            }))}
          />
        </Card>
      </div>
    </div>
  );
}

function UsageTab({ data, onExport }: { data: SectionResponse | null; onExport: () => void }) {
  const t = useTranslations("Stats");
  if (!data) return <SkeletonGrid />;
  const byTool = data.latest_lists["mcp.queries.by_tool"] || [];
  const topEmp = data.latest_lists["mcp.top_employees"] || [];
  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        <Card title={t("usage.mcpQueriesPerDay")}><LineChart data={seriesPoints(data, "mcp.queries.total")} /></Card>
        <Card title={t("usage.zeroResultQueries")}><LineChart data={seriesPoints(data, "mcp.queries.zero_result")} color="#a04848" /></Card>
        <Card title={t("usage.dailyActiveUsers")}><LineChart data={seriesPoints(data, "mcp.active_users")} color="#3d8a4e" /></Card>
        <Card title={t("usage.avgLatency")}><LineChart data={seriesPoints(data, "mcp.latency_ms_avg")} color="#8a6dba" /></Card>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Card title={t("usage.queriesByTool")} action={<ExportButton onClick={onExport} />}>
          <BarList items={byTool as Array<Record<string, unknown>>} labelKey="tool_name" valueKey="count" />
        </Card>
        <Card title={t("usage.topEmployeesByQueryCount")}>
          <BarList items={topEmp as Array<Record<string, unknown>>} labelKey="name" valueKey="count" />
        </Card>
      </div>
    </div>
  );
}

function GapsTab({ data, onExport }: { data: { items: GapItem[] } | null; onExport: () => void }) {
  const t = useTranslations("Stats");
  if (!data) return <SkeletonGrid />;
  if (!data.items.length) {
    return (
      <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
        {t("gaps.noGaps")}
      </div>
    );
  }
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-medium">{t("gaps.tableTitle")}</div>
        <ExportButton onClick={onExport} />
      </div>
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-wide text-muted-foreground bg-black/[0.02]">
          <tr>
            <th className="text-left px-4 py-2 font-medium">{t("gaps.colTopic")}</th>
            <th className="text-right px-4 py-2 font-medium">{t("gaps.colCount")}</th>
            <th className="text-left px-4 py-2 font-medium">{t("gaps.colSampleQueries")}</th>
            <th className="text-right px-4 py-2 font-medium">{t("gaps.colAction")}</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((g, i) => (
            <tr key={i} className="border-t hover:bg-black/[0.02]">
              <td className="px-4 py-2 font-medium">{g.normalized}</td>
              <td className="px-4 py-2 text-right tabular-nums">{g.count}</td>
              <td className="px-4 py-2 text-xs text-muted-foreground">
                {g.samples.slice(0, 2).map((s, idx) => (
                  <div key={idx} className="truncate max-w-[420px]">"{s}"</div>
                ))}
              </td>
              <td className="px-4 py-2 text-right">
                <a
                  href={`/wiki?new=1&title=${encodeURIComponent(g.samples[0] || g.normalized)}`}
                  className="text-xs text-foreground/80 hover:text-foreground underline-offset-2 hover:underline"
                >
                  {t("gaps.createDraft")}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-24 rounded-xl border bg-card animate-pulse" />
      ))}
    </div>
  );
}
