"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { AiCheckItem, AiCheckResults, AiCheckStatus } from "@/types/wiki";

type Props = {
  status: AiCheckStatus | string;
  results: AiCheckResults | null;
  onRerun?: () => void | Promise<void>;
  rerunBusy?: boolean;
};

// Status badge classes stay untranslated (CSS only); labels come from t().
function badgeClasses(status: AiCheckStatus | string): { classes: string; icon: string } {
  switch (status) {
    case "passed":
      return { classes: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-200", icon: "check_circle" };
    case "warned":
      return { classes: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-200", icon: "warning" };
    case "failed":
      return { classes: "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-200", icon: "report" };
    case "running":
      return { classes: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200", icon: "progress_activity" };
    case "queued":
      return { classes: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200", icon: "schedule" };
    case "skipped":
      return { classes: "bg-muted text-muted-foreground", icon: "skip_next" };
    case "pending":
    default:
      return { classes: "bg-muted text-muted-foreground", icon: "schedule" };
  }
}

function checkIcon(check: AiCheckItem): { icon: string; cls: string } {
  switch (check.status) {
    case "pass":
      return { icon: "check_circle", cls: "text-emerald-600 dark:text-emerald-400" };
    case "warn":
      return { icon: "warning", cls: "text-amber-600 dark:text-amber-400" };
    case "fail":
      return { icon: "cancel", cls: "text-rose-600 dark:text-rose-400" };
    case "skipped":
    default:
      return { icon: "remove_circle", cls: "text-muted-foreground" };
  }
}

function formatMatch(m: AiCheckItem["matches"][number]): string {
  if (typeof m === "string") return m;
  if (m.slug && typeof m.score === "number") {
    return `${m.slug} (${(m.score * 100).toFixed(0)}%)`;
  }
  if (m.slug) return m.slug;
  if (m.snippet) return m.line ? `L${m.line}: ${m.snippet}` : m.snippet;
  return JSON.stringify(m);
}

// Check IDs that have known translations. The fallback prettification remains
// for any new backend check id that hasn't been localised yet.
const KNOWN_CHECK_IDS = new Set([
  "pii.email", "pii.phone_vn", "pii.cccd_vn",
  "secret.api_key_sk", "secret.anthropic", "secret.aws_access",
  "secret.github_pat", "secret.google_api", "secret.jwt", "secret.private_key",
  "links.broken", "links.self", "length.sanity",
  "markdown.heading_jump", "markdown.unclosed_fence",
  "semantic.duplicate",
  "llm.tone", "llm.scope_fit", "llm.factual",
  "runner.error",
]);


export function WikiAiCheckPanel({ status, results, onRerun, rerunBusy }: Props) {
  const t = useTranslations("WikiAiCheck");
  const [expanded, setExpanded] = React.useState(false);
  const badge = badgeClasses(status);

  // Resolve badge label from translations; fall back to raw status for unknown values.
  const badgeLabelMap: Record<string, string> = {
    passed: t("badge.passed"),
    warned: t("badge.warned"),
    failed: t("badge.failed"),
    running: t("badge.running"),
    queued: t("badge.queued"),
    skipped: t("badge.skipped"),
    pending: t("badge.pending"),
  };
  const badgeLabel = badgeLabelMap[status] ?? String(status);

  const summary = results?.summary;
  const allChecks = results?.checks || [];
  const flagged = allChecks.filter((c) => c.status === "warn" || c.status === "fail");
  const passed = allChecks.filter((c) => c.status === "pass");
  const skipped = allChecks.filter((c) => c.status === "skipped");
  const [showPassed, setShowPassed] = React.useState(false);
  const inFlight = status === "running" || status === "queued" || !!rerunBusy;

  // Pre-built lookup tables so we never pass dynamic template-literal keys to t().
  // JSON keys use underscores; backend check IDs use dots. Map dot-id → t() result.
  const checkLabelLookup: Record<string, string> = {
    "pii.email": t("checks.pii_email"),
    "pii.phone_vn": t("checks.pii_phone_vn"),
    "pii.cccd_vn": t("checks.pii_cccd_vn"),
    "secret.api_key_sk": t("checks.secret_api_key_sk"),
    "secret.anthropic": t("checks.secret_anthropic"),
    "secret.aws_access": t("checks.secret_aws_access"),
    "secret.github_pat": t("checks.secret_github_pat"),
    "secret.google_api": t("checks.secret_google_api"),
    "secret.jwt": t("checks.secret_jwt"),
    "secret.private_key": t("checks.secret_private_key"),
    "links.broken": t("checks.links_broken"),
    "links.self": t("checks.links_self"),
    "length.sanity": t("checks.length_sanity"),
    "markdown.heading_jump": t("checks.markdown_heading_jump"),
    "markdown.unclosed_fence": t("checks.markdown_unclosed_fence"),
    "semantic.duplicate": t("checks.semantic_duplicate"),
    "llm.tone": t("checks.llm_tone"),
    "llm.scope_fit": t("checks.llm_scope_fit"),
    "llm.factual": t("checks.llm_factual"),
    "runner.error": t("checks.runner_error"),
  };
  const categoryLabelLookup: Record<string, string> = {
    "Sensitive data": t("categories.sensitiveData"),
    "Structure": t("categories.structure"),
    "Duplicates": t("categories.duplicates"),
    "AI judgment": t("categories.aiJudgment"),
    "System": t("categories.system"),
  };
  const prefixToCategoryKey: Record<string, string> = {
    pii: "Sensitive data",
    secret: "Sensitive data",
    links: "Structure",
    length: "Structure",
    markdown: "Structure",
    semantic: "Duplicates",
    llm: "AI judgment",
    runner: "System",
  };

  function describeCheck(id: string): { label: string; category: string } {
    if (KNOWN_CHECK_IDS.has(id)) {
      const label = checkLabelLookup[id] ?? id;
      const [cat] = id.split(".");
      const rawCategory = prefixToCategoryKey[cat] ?? cat;
      const category = categoryLabelLookup[rawCategory] ?? rawCategory;
      return { label, category };
    }
    // Fallback for unknown ids: prettify "foo.bar_baz" -> "Foo · Bar baz".
    const [cat, rest] = id.split(".");
    const pretty = (rest || cat).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
    return { label: pretty, category: cat.replace(/_/g, " ") };
  }

  const notRunText =
    status === "running"
      ? t("notRun.running")
      : status === "queued"
        ? t("notRun.queued")
        : t("notRun.default");

  return (
    <div className="border-t border-border bg-muted/30">
      <div className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-muted/50 transition-colors">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <span
            className={`material-symbols-outlined ${inFlight ? "animate-spin" : ""}`}
            style={{ fontSize: 16 }}
          >
            {badge.icon}
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${badge.classes}`}>
            {badgeLabel}
          </span>
          {summary && (
            <span className="text-muted-foreground tabular-nums truncate">
              {summary.skipped > 0
                ? t("summaryWithSkipped", { pass: summary.pass, warn: summary.warn, fail: summary.fail, skipped: summary.skipped })
                : t("summary", { pass: summary.pass, warn: summary.warn, fail: summary.fail })}
            </span>
          )}
        </button>
        {onRerun && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!inFlight) void onRerun();
            }}
            disabled={inFlight}
            title={t("recheckTitle")}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide border border-border hover:bg-background disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span
              className={`material-symbols-outlined ${rerunBusy ? "animate-spin" : ""}`}
              style={{ fontSize: 12 }}
            >
              {rerunBusy ? "progress_activity" : "refresh"}
            </span>
            {t("recheck")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? t("collapse") : t("expand")}
          className="material-symbols-outlined text-muted-foreground"
          style={{ fontSize: 16 }}
        >
          {expanded ? "expand_less" : "expand_more"}
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-3 space-y-3">
          {!results ? (
            <p className="text-xs text-muted-foreground italic">
              {notRunText}
            </p>
          ) : (
            <>
              {/* Flagged checks first — these need attention */}
              {flagged.length === 0 ? (
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                  {t("allPassed")}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {flagged.map((c) => {
                    const ico = checkIcon(c);
                    const desc = describeCheck(c.id);
                    return (
                      <li key={c.id} className="flex gap-2 text-xs">
                        <span
                          className={`material-symbols-outlined shrink-0 mt-0.5 ${ico.cls}`}
                          style={{ fontSize: 14 }}
                        >
                          {ico.icon}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="flex flex-wrap items-baseline gap-x-1.5" title={c.id}>
                            <span className="font-medium">{desc.label}</span>
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              {desc.category}
                            </span>
                          </p>
                          {c.message && <p>{c.message}</p>}
                          {c.matches.length > 0 && (
                            <ul className="mt-0.5 ml-2 text-muted-foreground text-[11px] list-disc list-inside">
                              {c.matches.slice(0, 5).map((m, i) => (
                                <li key={i} className="truncate">{formatMatch(m)}</li>
                              ))}
                              {c.matches.length > 5 && (
                                <li className="italic">{t("moreMatches", { count: c.matches.length - 5 })}</li>
                              )}
                            </ul>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Passed + skipped checks — collapsed by default. Reviewers
                  can expand to see what the AI already verified. */}
              {(passed.length > 0 || skipped.length > 0) && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowPassed((s) => !s)}
                    className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: 14 }}
                    >
                      {showPassed ? "expand_less" : "expand_more"}
                    </span>
                    {showPassed
                      ? t("hidePassed", {
                          pass: passed.length,
                          skippedSuffix: skipped.length > 0 ? t("skippedSuffix", { skipped: skipped.length }) : "",
                        })
                      : t("showPassed", {
                          pass: passed.length,
                          skippedSuffix: skipped.length > 0 ? t("skippedSuffix", { skipped: skipped.length }) : "",
                        })}
                  </button>
                  {showPassed && (
                    <ul className="mt-1.5 space-y-1 pl-1">
                      {[...passed, ...skipped].map((c) => {
                        const ico = checkIcon(c);
                        const desc = describeCheck(c.id);
                        return (
                          <li
                            key={c.id}
                            className="flex gap-2 text-[11px] text-muted-foreground"
                            title={c.id}
                          >
                            <span
                              className={`material-symbols-outlined shrink-0 mt-0.5 ${ico.cls}`}
                              style={{ fontSize: 12 }}
                            >
                              {ico.icon}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span>{desc.label}</span>
                              <span className="ml-1.5 text-muted-foreground/70 text-[10px] uppercase tracking-wide">
                                {desc.category}
                              </span>
                              {c.message && (
                                <span className="ml-1 italic">— {c.message}</span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
          <p className="text-[10px] text-muted-foreground italic pt-1">
            {t("advisory")}
          </p>
        </div>
      )}
    </div>
  );
}
