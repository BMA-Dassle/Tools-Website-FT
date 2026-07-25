/**
 * Kiosk locales.
 *
 * The kiosk's guest-facing language. Locale rides in KioskConfig (like
 * `variant`/`brand`) — NOT in the URL path — because the kiosk is a client-only,
 * localStorage-provisioned single-page flow with no per-language routing. See
 * tasks/kiosk-i18n-spanish-plan.md.
 *
 * `en` is the source-of-truth catalog; every other locale is a translation of
 * it and falls back to `en` for any missing key (getMessages()).
 */
export const KIOSK_LOCALES = ["en", "es"] as const;
export type KioskLocale = (typeof KIOSK_LOCALES)[number];

export const DEFAULT_LOCALE: KioskLocale = "en";

/** Native-language label for each locale (what a guest reads on the switcher). */
export const LOCALE_LABEL: Record<KioskLocale, string> = {
  en: "English",
  es: "Español",
};

/** Short code shown beside the flag (a flag alone under-signifies a language). */
export const LOCALE_SHORT: Record<KioskLocale, string> = {
  en: "EN",
  es: "ES",
};

/** BCP-47 tag for Intl formatting + the DOM `lang` attribute. */
export const LOCALE_BCP47: Record<KioskLocale, string> = {
  en: "en-US",
  es: "es-US",
};

export function isKioskLocale(v: unknown): v is KioskLocale {
  return typeof v === "string" && (KIOSK_LOCALES as readonly string[]).includes(v);
}

/** Normalize a raw `?lang=` param (or stored value) to a supported locale. */
export function normalizeLocale(raw: string | undefined | null): KioskLocale | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "en" || v.startsWith("en-") || v === "english") return "en";
  if (v === "es" || v.startsWith("es-") || v === "spanish" || v === "espanol" || v === "español") {
    return "es";
  }
  return null;
}
