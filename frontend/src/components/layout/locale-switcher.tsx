"use client";

// Compact locale switcher dropdown.
// - Reads the active locale via `useLocale()` (sourced from cookie via i18n/request.ts).
// - Persists the user's choice through the `setLocale` server action which
//   writes the `arkon_locale` cookie.
// - Triggers `router.refresh()` so server components re-render with the new
//   message dictionary on the next paint.

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Check, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/actions";
import { LOCALES, type Locale } from "@/i18n/config";

export function LocaleSwitcher() {
  const router = useRouter();
  const currentLocale = useLocale() as Locale;
  const t = useTranslations("LocaleSwitcher");
  const [isPending, startTransition] = useTransition();

  const handleSelect = (next: Locale) => {
    if (next === currentLocale || isPending) return;
    startTransition(async () => {
      const result = await setLocale(next);
      if (result.ok) {
        router.refresh();
      }
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("label")}
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-100",
          "text-muted-foreground hover:bg-black/[0.03] hover:text-foreground",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          isPending && "opacity-60",
        )}
      >
        <Languages className="h-[16px] w-[16px] shrink-0" strokeWidth={1.75} />
        <span className="truncate uppercase tracking-wide text-[11px] font-semibold">
          {currentLocale}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[160px]">
        {LOCALES.map((loc) => {
          const isActive = loc === currentLocale;
          return (
            <DropdownMenuItem
              key={loc}
              onClick={() => handleSelect(loc)}
              className={cn(
                "flex items-center justify-between gap-2 text-[13px]",
                isActive && "font-semibold",
              )}
            >
              <span>{t(loc)}</span>
              {isActive ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
