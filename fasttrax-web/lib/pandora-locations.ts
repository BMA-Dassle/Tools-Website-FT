/**
 * Pandora locationID map — shared across pandora proxy and sales-lead flow.
 *
 * NOTE: these are *Pandora* (alphanumeric) IDs, distinct from:
 *   - BMI numeric IDs (e.g. 332160 HeadPinz Fort Myers) used in portal bot LOCATION_NAMES
 *   - QAMF bowling passport IDs (9172 FM, 3148 Naples) used in bowling booking
 */

export const PANDORA_LOCATION_MAP: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11", // HeadPinz Fort Myers
  naples:   "PPTR5G2N0QXF7", // HeadPinz Naples
};

export const PANDORA_DEFAULT_LOCATION_ID = "TXBSQN0FEKQ11";

export type PandoraCenterKey = keyof typeof PANDORA_LOCATION_MAP;

/** Resolve a center key to a Pandora locationID, falling back to the default. */
export function resolvePandoraLocation(key: string | null | undefined): string {
  if (key && PANDORA_LOCATION_MAP[key]) return PANDORA_LOCATION_MAP[key];
  return PANDORA_DEFAULT_LOCATION_ID;
}

/** Human-readable names for display (emails, cards, logs). */
export const PANDORA_CENTER_NAMES: Record<string, string> = {
  fasttrax: "FastTrax Fort Myers",
  headpinz: "HeadPinz Fort Myers",
  naples:   "HeadPinz Naples",
};
