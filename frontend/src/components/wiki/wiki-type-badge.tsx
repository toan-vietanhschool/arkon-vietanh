"use client";

import { useTranslations } from "next-intl";
import { WikiPageType } from "@/types/wiki";

const TYPE_CONFIG: Record<
  WikiPageType,
  { icon: string; color: string; bg: string }
> = {
  entity: { icon: "person", color: "#c2652a", bg: "rgba(194,101,42,0.1)" },
  concept: { icon: "lightbulb", color: "#8c7b6b", bg: "rgba(140,123,107,0.1)" },
  topic: { icon: "topic", color: "#6b8c7b", bg: "rgba(107,140,123,0.1)" },
  source: { icon: "description", color: "#7b6b8c", bg: "rgba(123,107,140,0.1)" },
  index: { icon: "list_alt", color: "#78706a", bg: "rgba(120,112,106,0.1)" },
  log: { icon: "history", color: "#78706a", bg: "rgba(120,112,106,0.1)" },
};

/** Maps page type → singular translation key. */
const SINGULAR_KEY_MAP: Record<string, string> = {
  entity: "entity",
  concept: "concept",
  topic: "topic",
  source: "source",
  index: "index",
  log: "log",
};

export function WikiTypeBadge({ type }: { type: string }) {
  const t = useTranslations("Wiki.pageType");
  const cfg = TYPE_CONFIG[type as WikiPageType] ?? TYPE_CONFIG.concept;
  const singularKey = SINGULAR_KEY_MAP[type];
  const label = singularKey
    ? t(singularKey as Parameters<typeof t>[0])
    : type;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ color: cfg.color, backgroundColor: cfg.bg, border: `1px solid ${cfg.color}40` }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 12 }}>
        {cfg.icon}
      </span>
      {label}
    </span>
  );
}

export function wikiTypeIcon(type: string): string {
  return TYPE_CONFIG[type as WikiPageType]?.icon ?? "article";
}

export function wikiTypeColor(type: string): string {
  return TYPE_CONFIG[type as WikiPageType]?.color ?? "#78706a";
}

/** Maps page type → plural translation key suffix. */
const PLURAL_KEY_MAP: Record<string, string> = {
  entity: "entityPlural",
  concept: "conceptPlural",
  topic: "topicPlural",
  source: "sourcePlural",
  index: "indexPlural",
  log: "logPlural",
};

/**
 * Hook that returns a function for translating page type plural labels.
 * Use this in React components.
 */
export function useWikiTypeGroupLabel() {
  const t = useTranslations("Wiki.pageType");
  return (type: string): string => {
    const key = PLURAL_KEY_MAP[type];
    if (!key) return type;
    return t(key as Parameters<typeof t>[0]);
  };
}

/**
 * Non-hook fallback for contexts where hooks cannot be called
 * (e.g. inside imperative callbacks). Returns English labels.
 * Prefer useWikiTypeGroupLabel() in React render contexts.
 */
export function wikiTypeGroupLabel(type: string): string {
  const labels: Record<string, string> = {
    entity: "Entities",
    concept: "Concepts",
    topic: "Topics",
    source: "Sources",
    index: "Index",
    log: "Log",
  };
  return labels[type] ?? type;
}
