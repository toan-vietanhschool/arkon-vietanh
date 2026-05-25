// next-intl server-side locale resolver. Called once per request to load the
// active locale + its message dictionary into the React tree.
//
// Resolution order:
//   1. `arkon_locale` cookie (set by LocaleSwitcher)
//   2. DEFAULT_LOCALE (vi)
//
// Header-based negotiation (Accept-Language) is intentionally omitted —
// employees pick their language explicitly and we persist that choice.

import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from "./config";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  const messages = (await import(`../../messages/${locale}.json`)).default;
  return { locale, messages };
});
