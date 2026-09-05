import type { Locale } from "./copy";

/**
 * Which language this screen speaks.
 *
 * `?lang=es` and nothing else, for now. The kiosk has a real locale context and
 * this surface does not yet — but the copy catalog is complete in both languages
 * from day one, so switching to a shared context later is a one-line change here
 * rather than a translation project.
 *
 * Defaults to English on anything unrecognised. A guest who typed something odd
 * gets a working screen, not a blank one.
 */
export function resolveLocale(raw: string | string[] | undefined): Locale {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return String(v ?? "")
    .toLowerCase()
    .startsWith("es")
    ? "es"
    : "en";
}
