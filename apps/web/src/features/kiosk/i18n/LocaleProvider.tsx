"use client";

/**
 * Kiosk locale context.
 *
 * Mounts INSIDE KioskConfigProvider (see KioskShell) so it can read the
 * staff-set default language from device config. The active locale is derived,
 * not stored twice:
 *
 *     locale = guestOverride ?? configDefault
 *
 * - `configDefault` — from `config.locale` (staff provisioning `?lang=es`),
 *   persisted in localStorage; the shared device's default between guests.
 * - `guestOverride` — the ephemeral tap on the top-right flag switcher. NOT
 *   persisted. `resetLocale()` clears it, so Start-Over returns the next guest
 *   to the staff default (see KioskFlow.handleStartOver).
 *
 * Deriving (rather than syncing state in an effect) keeps this free of the
 * setState-in-effect hydration pattern the repo's lint rules flag, and makes a
 * staff re-provision update the default automatically when no guest override is
 * in play.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { setWaiverLang } from "@/lib/waiver-lang";
import { DEFAULT_LOCALE, normalizeLocale, type KioskLocale } from "./locales";
import { formatMessage, type TranslateValues } from "./format";
import type { MessageKey } from "./messages";

export type { TranslateValues };
export type Translate = (key: MessageKey, values?: TranslateValues) => string;

interface LocaleContextValue {
  locale: KioskLocale;
  /** The staff-set device default (what Start-Over returns to). */
  defaultLocale: KioskLocale;
  /** Guest tap on the switcher — ephemeral, not persisted. */
  setLocale: (locale: KioskLocale) => void;
  /** Clear the guest override → back to the device default (Start-Over). */
  resetLocale: () => void;
  t: Translate;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const { config } = useKioskConfig();
  const defaultLocale = normalizeLocale(config?.locale) ?? DEFAULT_LOCALE;
  const [override, setOverride] = useState<KioskLocale | null>(null);
  const locale = override ?? defaultLocale;

  // Mirror the active locale into the ambient waiver language so the in-house
  // waiver template (fetched from plain lib code that can't read this context)
  // renders in the guest's language. Not setState — just a module setter.
  useEffect(() => {
    setWaiverLang(locale);
  }, [locale]);

  const t = useCallback<Translate>((key, values) => formatMessage(locale, key, values), [locale]);
  // Stable identities so Start-Over's handleStartOver (and other consumers that
  // depend on these) don't churn each render.
  const setLocale = useCallback((next: KioskLocale) => setOverride(next), []);
  const resetLocale = useCallback(() => setOverride(null), []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, defaultLocale, setLocale, resetLocale, t }),
    [locale, defaultLocale, setLocale, resetLocale, t],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Fallback used when a kiosk component renders OUTSIDE a LocaleProvider — the
 * standalone `/join/[code]` phone page mounts kiosk components (JoinPhoneFlow)
 * without the kiosk shell that provides the context. Rather than throw (which
 * crashed the whole page — incident 2026-07-26, "useLocale must be used within
 * <LocaleProvider>" on /join/[code]), fall back to the default locale so the
 * component renders in English. Switcher controls are no-ops here.
 */
const FALLBACK_LOCALE_VALUE: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  defaultLocale: DEFAULT_LOCALE,
  setLocale: () => {},
  resetLocale: () => {},
  t: (key, values) => formatMessage(DEFAULT_LOCALE, key, values),
};

/** Full locale context — language state + switcher controls. Falls back to the
 *  default locale (never throws) when there is no provider, so a standalone page
 *  that renders kiosk components can't crash on a missing context. */
export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? FALLBACK_LOCALE_VALUE;
}
