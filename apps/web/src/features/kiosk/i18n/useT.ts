"use client";

/**
 * `const t = useT()` — the ergonomic entry point for translating kiosk copy.
 *
 *     const t = useT();
 *     <h1>{t("attract.letsPlay")}</h1>
 *     <p>{t("people.tooYoung", { name: firstName })}</p>
 *
 * Returns just the translate function (the common case). Reach for `useLocale()`
 * when you also need the current locale or the switcher controls.
 */
import { useLocale, type Translate } from "./LocaleProvider";

export function useT(): Translate {
  return useLocale().t;
}
