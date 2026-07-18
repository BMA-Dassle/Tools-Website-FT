/**
 * Intercard game-card configuration (corp 6283).
 *
 * Auth model: the Intercard SOAP surface authenticates on the MAC id alone
 * (identity + tenant + routing). Corp 6283 is a single tenant, so ONE MAC
 * authenticates every reload regardless of which physical location the guest
 * picks — the card account resolves by number. The guest-picked location only
 * sets the credit call's `LocationID` (transaction attribution) and which
 * Square location the sale books under. Per-center MACs are a future
 * enhancement; today the MAC is constant.
 *
 * NEVER commit the MAC — it's the whole credential. Set INTERCARD_MAC in Vercel.
 */

import { SQUARE_LOCATIONS } from "~/features/booking/data/square-catalog-map";

export const CORP_ID = 6283;

/** Single MAC for all reloads (Vercel secret). Empty locally → calls fail closed. */
export const INTERCARD_MAC = process.env.INTERCARD_MAC || "";

/** Data-center SOAP endpoints (overridable via env; defaults are the live hosts). */
export const INTERCARD_TPI_URL =
  process.env.INTERCARD_TPI_URL ||
  "https://intercard.swflpassport.com/WS_ThirdPartyInterface/WS_ThirdPartyInterface.asmx";
export const INTERCARD_BALANCE_URL =
  process.env.INTERCARD_BALANCE_URL ||
  "https://intercard.swflpassport.com/WS_AccountHistory/WebServiceAccountHistory.asmx";

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
