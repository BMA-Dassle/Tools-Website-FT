import type { BrandKey } from "./types";

/**
 * The three Square locations under our single seller account
 * (SQUARE_MERCHANT_ID=2Z728TECCNWSE). Cards are customer-scoped, so a saved
 * card is reusable across all three. Used to label/group subscriptions and to
 * scope SearchSubscriptions.
 */
export const SQUARE_LOCATIONS: Record<string, { label: string; brand: BrandKey }> = {
  LAB52GY480CJF: { label: "FastTrax — Fort Myers", brand: "fasttrax" },
  TXBSQN0FEKQ11: { label: "HeadPinz — Fort Myers", brand: "headpinz" },
  PPTR5G2N0QXF7: { label: "HeadPinz — Naples", brand: "headpinz" },
};

export const LOCATION_IDS = Object.keys(SQUARE_LOCATIONS);

// ── OTP ──────────────────────────────────────────────────────────────────
export const CODE_TTL_SEC = 300; // 5 minutes
export const MAX_VERIFY_ATTEMPTS = 5;
export const LOCKOUT_TTL_SEC = 900; // 15 min lockout after attempts exhausted
export const RESEND_COOLDOWN_SEC = 60;
export const SEND_PER_CONTACT_PER_HOUR = 5;
export const SEND_PER_IP_PER_HOUR = 20;

// ── Session ──────────────────────────────────────────────────────────────
export const SESSION_IDLE_TTL_SEC = 1800; // 30 min sliding idle expiry
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000; // 12h hard cap

export const SESSION_COOKIE = "acct_session";
export const CSRF_HEADER = "x-account-csrf";
