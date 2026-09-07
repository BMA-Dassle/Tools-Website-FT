"use client";

/**
 * The shared AccountCard's guest-facing strings, from the kiosk EN/ES catalog.
 * The card lives in the web booking components (English defaults); every kiosk
 * surface that renders it — the OTP sign-in, the licence-scan picker, the
 * new-racer gate's picker — passes these so a Spanish-speaking guest reads
 * "Licencia hasta …", not "License to …" (owner rule 2026-07-26).
 */
import type { AccountCardLabels } from "~/components/features/booking/steps/race/ReturningRacerLookup";
import { useT } from "../i18n";

export function useAccountCardLabels(): AccountCardLabels {
  const t = useT();
  return {
    // `{date}` stays literal here — the card substitutes it.
    licenseTo: t("account.licenseTo", { date: "{date}" }),
    licenseActive: t("account.licenseActive"),
    noLicense: t("account.noLicense"),
    lastRaced: t("account.lastRaced", { date: "{date}" }),
    samePhone: t("account.samePhone"),
  };
}
