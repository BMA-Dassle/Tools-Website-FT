/**
 * Kiosk internationalization — public surface.
 *
 * Usage in a guest-facing kiosk component:
 *     import { useT } from "~/features/kiosk/i18n";
 *     const t = useT();
 *     <h1>{t("attract.letsPlay")}</h1>
 *
 * See tasks/kiosk-i18n-spanish-plan.md for scope and rollout.
 */
export { LocaleProvider, useLocale, type Translate, type TranslateValues } from "./LocaleProvider";
export { useT } from "./useT";
export { LanguageSwitcher } from "./LanguageSwitcher";
export {
  KIOSK_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABEL,
  LOCALE_SHORT,
  LOCALE_BCP47,
  normalizeLocale,
  isKioskLocale,
  type KioskLocale,
} from "./locales";
export type { MessageKey } from "./messages";
