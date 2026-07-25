/**
 * Pure ICU message formatting — no React, so it's unit-testable in isolation.
 *
 * `LocaleProvider` wraps this in context; components use `useT()`. Formatters are
 * compiled once per (locale, key) and cached — catalogs are static, so the cache
 * lives for the process. Every path is crash-proof: a malformed ICU string or a
 * bad interpolation falls back to the raw English source rather than throwing on
 * a live kiosk screen.
 */
import IntlMessageFormat from "intl-messageformat";
import { LOCALE_BCP47, type KioskLocale } from "./locales";
import { fallbackMessage, getMessages, type MessageKey } from "./messages";

export type TranslateValues = Record<string, string | number | boolean | Date>;

const formatterCache = new Map<string, IntlMessageFormat>();

function getFormatter(locale: KioskLocale, key: MessageKey): IntlMessageFormat | null {
  const cacheKey = `${locale} ${key}`;
  const hit = formatterCache.get(cacheKey);
  if (hit) return hit;
  const message = getMessages(locale)[key] ?? fallbackMessage(key);
  try {
    const f = new IntlMessageFormat(message, LOCALE_BCP47[locale]);
    formatterCache.set(cacheKey, f);
    return f;
  } catch {
    return null; // malformed ICU — caller falls back to raw English
  }
}

export function formatMessage(
  locale: KioskLocale,
  key: MessageKey,
  values?: TranslateValues,
): string {
  const f = getFormatter(locale, key);
  if (!f) return fallbackMessage(key);
  try {
    return String(f.format(values));
  } catch {
    return fallbackMessage(key);
  }
}
