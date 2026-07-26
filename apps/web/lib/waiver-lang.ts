/**
 * Ambient waiver display language for the in-house waiver template.
 *
 * `pandoraOnboardGuest` / `pandoraFetchWaiverTemplate` run in plain lib code that
 * can't read React context, and they're invoked from ~9 kiosk call sites. Rather
 * than thread `lang` through every one, the kiosk's LocaleProvider mirrors the
 * current locale here, and the pandora waiver helpers default to it. Lives in
 * `lib/` (not features/) so pandora.ts imports it without a layering inversion.
 *
 * A module-level value is safe: a kiosk is single-guest at a time on the client,
 * so there is never a second concurrent session in a different language. Defaults
 * to English (also the value on the server, where it's never set).
 */
export type WaiverLangCode = "en" | "es";

let current: WaiverLangCode = "en";

/** Called by the kiosk LocaleProvider whenever the active locale changes. */
export function setWaiverLang(lang: WaiverLangCode): void {
  current = lang;
}

/** The waiver language to render — used as the default in the pandora helpers. */
export function getWaiverLang(): WaiverLangCode {
  return current;
}
