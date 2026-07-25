/**
 * Message-catalog registry.
 *
 * Catalogs are small (a few hundred short strings across 2–3 languages), so
 * they're statically bundled rather than lazy-loaded — this avoids a
 * flash-of-English while an async chunk loads on the fixed-canvas kiosk, at a
 * negligible bundle cost. Revisit only if the catalog grows large.
 */
import { en, type MessageKey, type Messages } from "./en";
import { es } from "./es";
import type { KioskLocale } from "../locales";

const CATALOGS: Record<KioskLocale, Messages> = { en, es };

/** The catalog for a locale (always defined; `en` is the ultimate fallback). */
export function getMessages(locale: KioskLocale): Messages {
  return CATALOGS[locale] ?? en;
}

/** Raw English source string for a key — the per-key runtime fallback. */
export function fallbackMessage(key: MessageKey): string {
  return en[key];
}

export type { MessageKey, Messages };
