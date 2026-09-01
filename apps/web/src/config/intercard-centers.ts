/**
 * Intercard game-card configuration (corp 6283).
 *
 * Auth model: the Intercard SOAP surface authenticates on the MAC id alone
 * (identity + tenant + routing). Each LOCATION is a SEPARATE MAC registration
 * (owner 2026-07-19), so the MAC MUST match the center the load books to — a
 * wrong MAC is rejected (-2 MAC not registered). Resolve it with macForCenter().
 *
 * NEVER commit a MAC — it's the whole credential. Set the per-location secrets in
 * Vercel: INTERCARD_MAC_12 (HeadPinz Fort Myers), INTERCARD_MAC_6 (HeadPinz
 * Naples), INTERCARD_MAC_13 (FastTrax Fort Myers). INTERCARD_MAC (legacy single)
 * is used only as a fallback when a site-specific one isn't set.
 */

import { SQUARE_LOCATIONS } from "~/features/booking/data/square-catalog-map";

export const CORP_ID = 6283;

/** Legacy single MAC — fallback only; prefer the per-location secrets. */
export const INTERCARD_MAC = process.env.INTERCARD_MAC || "";

/**
 * The Intercard MAC for a specific location code. Each site registers its own
 * MAC, so this must be keyed to the center the tokens load to. Falls back to the
 * shared INTERCARD_MAC (single-tenant legacy) when a per-site secret is absent.
 * Empty (no secret at all) → calls fail closed (NO_MAC).
 */
export function macForCenter(code: number): string {
  return process.env[`INTERCARD_MAC_${code}`] || INTERCARD_MAC || "";
}

/** Data-center SOAP endpoints (overridable via env; defaults are the live hosts). */
export const INTERCARD_TPI_URL =
  process.env.INTERCARD_TPI_URL ||
  "https://intercard.swflpassport.com/WS_ThirdPartyInterface/WS_ThirdPartyInterface.asmx";
export const INTERCARD_BALANCE_URL =
  process.env.INTERCARD_BALANCE_URL ||
  "https://intercard.swflpassport.com/WS_AccountHistory/WebServiceAccountHistory.asmx";

/**
 * ONSITE REST proxy (Api_External). Same host as the SOAP services, but this
 * one relays each call live to the SITE'S OWN Transaction Server over SignalR —
 * real-time truth instead of the replicated datacenter copy. See
 * `data/intercard-onsite.ts` and docs/intercard-api-external-rest.md.
 */
export const INTERCARD_ONSITE_URL =
  process.env.INTERCARD_ONSITE_URL || "https://intercard.swflpassport.com/Api_External";

/**
 * The onsite proxy authenticates on FOUR values, not the MAC alone: the
 * `LocID` + `ProductCode` + `ClientToken` headers plus the MAC in the body. All
 * four must match a licensed device row or the call 401s with the same generic
 * "ETPI requires up to date Licensing." regardless of which one is wrong.
 *
 * NEVER commit the token — it is a credential, exactly like the MAC. Set
 * INTERCARD_CLIENT_TOKEN (and INTERCARD_PRODUCT_CODE if it ever differs from
 * the corp-6283 default) in Vercel. Empty → onsite calls fail closed (NO_TOKEN),
 * which the kiosk badge surfaces as "unlicensed" rather than a site outage.
 */
export function intercardClientToken(): string {
  return process.env.INTERCARD_CLIENT_TOKEN || "";
}

export function intercardProductCode(): string {
  return process.env.INTERCARD_PRODUCT_CODE || "API-0331";
}

/**
 * Kill switch for the onsite path (repo rule: flags are kill switches ONLY —
 * a merged feature is ON, and a flag exists solely to turn it OFF in an
 * emergency, so it defaults ON via `!== "false"`).
 *
 * Set INTERCARD_ONSITE_ENABLED="false" to force every caller back onto the
 * proven SOAP client if the onsite relay misbehaves in production.
 */
export function isOnsiteEnabled(): boolean {
  return process.env.INTERCARD_ONSITE_ENABLED !== "false";
}

export type Brand = "headpinz" | "fasttrax";

export interface CenterConfig {
  /** Intercard location code (LocationID on the credit call). */
  code: number;
  label: string;
  brand: Brand;
  /** Square location id the sale books under. */
  squareLocation: string;
  /** Key the client PaymentForm maps to the same Square location for SDK init. */
  paymentFormKey: "fasttrax" | "headpinz" | "naples";
}

/**
 * Customer-facing launch locations (corp 6283). All three have known Square
 * location IDs. Bowland sites, HeadPinz Cape Coral, and Home Office are out of
 * scope until their Square location IDs are available.
 */
export const CENTERS: Record<number, CenterConfig> = {
  12: {
    code: 12,
    label: "HeadPinz Fort Myers",
    brand: "headpinz",
    squareLocation: SQUARE_LOCATIONS.HEADPINZ_FM,
    paymentFormKey: "headpinz",
  },
  6: {
    code: 6,
    label: "HeadPinz Naples",
    brand: "headpinz",
    squareLocation: SQUARE_LOCATIONS.HEADPINZ_NAP,
    paymentFormKey: "naples",
  },
  13: {
    code: 13,
    label: "FastTrax Fort Myers",
    brand: "fasttrax",
    squareLocation: SQUARE_LOCATIONS.FASTTRAX_FM,
    paymentFormKey: "fasttrax",
  },
};

/** Ordered list for the location picker UI. */
export const CENTER_LIST: CenterConfig[] = [CENTERS[12], CENTERS[6], CENTERS[13]];

export function getCenter(code: number): CenterConfig | null {
  return CENTERS[code] ?? null;
}

/**
 * Canonical Intercard location code for a kiosk's (booking) center + brand.
 * Use this everywhere instead of hand-rolled maps — a wrong code makes
 * `getCenter()` return null and the purchase throws UNKNOWN_LOCATION.
 * ("naples" is HeadPinz-only; Fort Myers splits by brand.)
 */
export function centerCodeFor(center: string, brand: Brand): number {
  if (center === "naples") return 6; // HeadPinz Naples
  return brand === "headpinz" ? 12 : 13; // HeadPinz FM : FastTrax FM
}

export function isValidLocationCode(code: number): boolean {
  return code in CENTERS;
}
