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
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
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

/** Full locale context — language state + switcher controls. */
export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within <LocaleProvider>");
  return ctx;
}
