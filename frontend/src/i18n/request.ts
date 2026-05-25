// next-intl server-side locale resolver. Auto-discovers namespace files
// under `messages/{locale}/*.json` — each file becomes one namespace keyed
// by its PascalCase filename. This lets multiple contributors add new
// namespaces without coordinating edits to a single shared messages file.
//
// Filename → namespace key:
//   common.json            → Common
//   nav.json               → Nav
//   locale-switcher.json   → LocaleSwitcher
//   wiki-review.json       → WikiReview
//
// Resolution order for locale:
//   1. `arkon_locale` cookie (set by LocaleSwitcher)
//   2. DEFAULT_LOCALE (vi)

import fs from "fs/promises";
import path from "path";
import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from "./config";

function toNamespaceKey(filename: string): string {
  return filename
    .replace(/\.json$/, "")
    .split("-")
    .map((seg) => (seg.length === 0 ? "" : seg[0].toUpperCase() + seg.slice(1)))
    .join("");
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  const dir = path.join(process.cwd(), "messages", locale);
  const entries = await fs.readdir(dir);
  const messages: Record<string, unknown> = {};
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    const raw = await fs.readFile(filePath, "utf8");
    messages[toNamespaceKey(entry)] = JSON.parse(raw);
  }

  return { locale, messages };
});
