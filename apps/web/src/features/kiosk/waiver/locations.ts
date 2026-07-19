/**
 * Kiosk center ↔ BMI location mapping for the group-waiver flow.
 *
 * A fort-myers kiosk serves guests of BOTH FM venues (HeadPinz FM 332160 and
 * FastTrax 467486 share one BMI server; events can span both — listDailyEvents
 * has multi-location detection), so its picker queries both and dedupes by
 * project id. Naples is single-venue.
 */
import type { CenterCode } from "~/features/booking";

export const CENTER_TO_BMI_LOCATION_IDS: Record<CenterCode, number[]> = {
  "fort-myers": [332160, 467486],
  naples: [332145],
};

/** BMI locationId → Pandora location key (waiver checks ride Pandora). */
export const BMI_LOCATION_TO_PANDORA_KEY: Record<number, string> = {
  332160: "headpinz",
  467486: "fasttrax",
  332145: "naples",
};

export function isValidCenter(v: string): v is CenterCode {
  return v === "fort-myers" || v === "naples";
}
