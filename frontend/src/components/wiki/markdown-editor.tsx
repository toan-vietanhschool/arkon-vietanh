"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { WikiContent } from "./wiki-content";
import { WikilinkAutocomplete } from "./wikilink-autocomplete";
import { getTextareaCaretCoords, type CaretCoords } from "@/lib/textarea-caret";
import { api } from "@/lib/api";
import { WikiPageSummary } from "@/types/wiki";

// ---------------------------------------------------------------------------
// Toolbar helpers — operate on a controlled textarea + value pair.
// ---------------------------------------------------------------------------

function insertWrap(
  ta: HTMLTextAreaElement,
  value: string,
  setValue: (v: string) => void,
  before: string,
  after = "",
  placeholder = "text",
) {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = value.slice(s, e) || placeholder;
  const next = value.slice(0, s) + before + sel + after + value.slice(e);
  setValue(next);
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(s + before.length, s + before.length + sel.length);
  });
}

function insertLinePrefix(
  ta: HTMLTextAreaElement,
  value: string,
  setValue: (v: string) => void,
  prefix: string,
) {
  const s = ta.selectionStart;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
  setValue(next);
  requestAnimationFrame(() => {
    ta.focus();
    const pos = s + prefix.length;
    ta.setSelectionRange(pos, pos);
  });
}

function insertBlock(
  ta: HTMLTextAreaElement,
  value: string,
  setValue: (v: string) => void,
  block: string,
  cursorOffset: number,
) {
  const s = ta.selectionStart;
  const next = value.slice(0, s) + block + value.slice(s);
  setValue(next);
  requestAnimationFrame(() => {
    ta.focus();
    const pos = s + cursorOffset;
    ta.setSelectionRange(pos, pos);
  });
}

function ToolbarButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="flex items-center justify-center w-7 h-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
    >
      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
        {icon}
      </span>
    </button>
  );
}

function ToolbarSep() {
  return <span className="w-px h-4 bg-border mx-0.5 shrink-0" />;
}

// ---------------------------------------------------------------------------
// MarkdownEditor — controlled editor with Edit/Preview tabs + formatting toolbar.
// ---------------------------------------------------------------------------

export type MarkdownEditorProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Tailwind class for textarea min-height. Default: "min-h-[400px]". */
  minHeightClass?: string;
};

type LinkContext = {
  /** Caret offset right after the opening `[[`. */
  start: number;
  /** Text the user has typed between `[[` and the caret. */
  query: string;
  /** Caret offset where the user currently sits (popup re-anchors here on key strokes). */
  caretOffset: number;
};

/**
 * Look back from the caret for an unclosed `[[`. Returns null if the user is
 * not currently typing a wikilink (no `[[` within the last ~80 chars, or a
 * closing `]]` / newline appears in between).
 */
function detectWikilinkContext(value: string, caret: number): LinkContext | null {
  const MAX_LOOKBACK = 80;
  const start = Math.max(0, caret - MAX_LOOKBACK);
  for (let i = caret - 1; i >= start; i--) {
    const c = value[i];
    if (c === "\n") return null;
    if (c === "]") return null; // closing bracket -> outside a wikilink
    if (c === "[" && value[i - 1] === "[") {
      return { start: i + 1, query: value.slice(i + 1, caret), caretOffset: caret };
    }
  }
  return null;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder = "Write markdown here...",
  minHeightClass = "min-h-[400px]",
}: MarkdownEditorProps) {
  const t = useTranslations("WikiEditor");
  const [tab, setTab] = React.useState<"edit" | "preview">("edit");
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // Wikilink autocomplete state ----------------------------------------------
  const [link, setLink] = React.useState<LinkContext | null>(null);
  const [coords, setCoords] = React.useState<CaretCoords | null>(null);
  const [pages, setPages] = React.useState<WikiPageSummary[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    api<WikiPageSummary[]>("/api/wiki/pages?limit=300")
      .then((rows) => {
        if (!cancelled) setPages(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setPages([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateLinkCtx = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const ctx = detectWikilinkContext(ta.value, ta.selectionStart);
    if (ctx) {
      setLink(ctx);
      try {
        setCoords(getTextareaCaretCoords(ta, ta.selectionStart));
      } catch {
        setCoords(null);
      }
    } else {
      setLink(null);
      setCoords(null);
    }
  }, []);

  const handlePick = (p: WikiPageSummary) => {
    const ta = taRef.current;
    if (!ta || !link) return;
    const after = `${p.slug}]]`;
    const next = ta.value.slice(0, link.start) + after + ta.value.slice(link.caretOffset);
    onChange(next);
    const newCaret = link.start + after.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
      setLink(null);
      setCoords(null);
    });
  };

  const w = (before: string, after = "", ph = "text") => {
    const ta = taRef.current;
    if (!ta) return;
    insertWrap(ta, value, onChange, before, after, ph);
  };
  const lp = (prefix: string) => {
    const ta = taRef.current;
    if (!ta) return;
    insertLinePrefix(ta, value, onChange, prefix);
  };
  const blk = (block: string, offset: number) => {
    const ta = taRef.current;
    if (!ta) return;
    insertBlock(ta, value, onChange, block, offset);
  };

  return (
    <div className="flex flex-col gap-0 rounded-xl border border-border overflow-hidden">
      {/* Header: tab toggle */}
      <div className="flex items-center justify-between px-3 py-2 bg-card border-b border-border">
        <div className="flex gap-1">
          {(["edit", "preview"] as const).map((tabKey) => (
            <button
              key={tabKey}
              type="button"
              onClick={() => setTab(tabKey)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors capitalize ${
                tab === tabKey
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              {tabKey === "edit" ? t("tabs.edit") : t("tabs.preview")}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{t("markdownLabel")}</span>
      </div>

      {tab === "edit" ? (
        <>
          {/* Toolbar */}
          <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 bg-card/60 border-b border-border">
            <ToolbarButton icon="format_bold" label={t("toolbar.bold")} onClick={() => w("**", "**", "bold text")} />
            <ToolbarButton icon="format_italic" label={t("toolbar.italic")} onClick={() => w("*", "*", "italic text")} />
            <ToolbarButton icon="code" label={t("toolbar.inlineCode")} onClick={() => w("`", "`", "code")} />
            <ToolbarSep />
            <button
              type="button"
              title={t("toolbar.heading2")}
              onClick={() => lp("## ")}
              className="px-1.5 h-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors text-xs font-bold font-mono"
            >
              H2
            </button>
            <button
              type="button"
              title={t("toolbar.heading3")}
              onClick={() => lp("### ")}
              className="px-1.5 h-7 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors text-xs font-bold font-mono"
            >
              H3
            </button>
            <ToolbarSep />
            <ToolbarButton icon="format_list_bulleted" label={t("toolbar.bulletList")} onClick={() => lp("- ")} />
            <ToolbarButton icon="format_list_numbered" label={t("toolbar.numberedList")} onClick={() => lp("1. ")} />
            <ToolbarButton icon="format_quote" label={t("toolbar.blockquote")} onClick={() => lp("> ")} />
            <ToolbarSep />
            <ToolbarButton icon="data_object" label={t("toolbar.codeBlock")} onClick={() => blk("\n```\n\n```\n", 5)} />
            <ToolbarButton icon="link" label={t("toolbar.link")} onClick={() => w("[", "](url)", "link text")} />
            <ToolbarButton
              icon="account_tree"
              label={t("toolbar.wikilink")}
              onClick={() => {
                const ta = taRef.current;
                if (!ta) return;
                insertWrap(ta, value, onChange, "[[", "", "");
                requestAnimationFrame(() => updateLinkCtx());
              }}
            />
            <ToolbarButton icon="horizontal_rule" label={t("toolbar.horizontalRule")} onClick={() => blk("\n\n---\n\n", 6)} />
          </div>

          {/* Textarea */}
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              requestAnimationFrame(updateLinkCtx);
            }}
            onClick={updateLinkCtx}
            onKeyUp={(e) => {
              if (
                e.key === "ArrowLeft" ||
                e.key === "ArrowRight" ||
                e.key === "ArrowUp" ||
                e.key === "ArrowDown" ||
                e.key === "Home" ||
                e.key === "End"
              ) {
                updateLinkCtx();
              }
            }}
            onBlur={() => {
              setTimeout(() => {
                if (document.activeElement !== taRef.current) {
                  setLink(null);
                  setCoords(null);
                }
              }, 150);
            }}
            className={`w-full ${minHeightClass} resize-y p-4 font-mono text-sm leading-6 bg-background text-foreground focus:outline-none placeholder:text-muted-foreground`}
            placeholder={placeholder}
            spellCheck={false}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "b") {
                e.preventDefault();
                w("**", "**", "bold text");
              }
              if ((e.metaKey || e.ctrlKey) && e.key === "i") {
                e.preventDefault();
                w("*", "*", "italic text");
              }
            }}
          />
        </>
      ) : (
        <div className={`${minHeightClass} p-6 bg-background overflow-y-auto`}>
          {value.trim() ? (
            <WikiContent markdown={value} />
          ) : (
            <p className="text-sm text-muted-foreground italic">{t("previewEmpty")}</p>
          )}
        </div>
      )}

      {/* Wikilink autocomplete — anchored to caret in viewport coords. */}
      {tab === "edit" && link && coords && (
        <WikilinkAutocomplete
          pages={pages}
          query={link.query}
          caret={coords}
          onPick={handlePick}
          onClose={() => {
            setLink(null);
            setCoords(null);
          }}
        />
      )}
    </div>
  );
}
