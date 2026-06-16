/**
 * Deposit gift-card GAN (Gift card Account Number) construction — single source
 * of truth for the prefix scheme so web vs contract deposits are tellable apart
 * at a glance in Square.
 *
 * Scheme: `{CHANNEL}{CENTER_TAG}` + a per-flow suffix.
 *   Channel:  GF  = group-function contract deposit
 *             WEB = self-serve web booking deposit
 *   Center:   HPFM = HeadPinz Fort Myers · FT = FastTrax · HPN = HeadPinz Naples
 *
 *   Contracts: GFHPFM… / GFFT… / GFHPN…
 *   Web:       WEBHPFM… / WEBFT… / WEBHPN…
 *
 * IMPORTANT — these GANs are an internal staff accounting instrument, NOT a
 * customer payment method. `isInternalDepositGan` (lib/square-gift-card.ts)
 * matches every prefix below so such a card can never be redeemed as payment at
 * checkout. Square GANs are IMMUTABLE once minted, so legacy prefixes must stay
 * in {@link KNOWN_DEPOSIT_GAN_PREFIXES} forever — old cards keep their GANs.
 */

export type GanChannel = "GF" | "WEB";

/**
 * Square location id (and centerCode alias) → short center tag used in GANs.
 * Some callers pass a Square location id, others a centerCode — accept both so
 * buildGanPrefix is robust regardless of which the call site has on hand.
 */
export const CENTER_TAG_BY_LOCATION: Record<string, string> = {
  // Square location ids
  TXBSQN0FEKQ11: "HPFM", // HeadPinz Fort Myers
  LAB52GY480CJF: "FT", // FastTrax (racing brand, Fort Myers)
  PPTR5G2N0QXF7: "HPN", // HeadPinz Naples
  // centerCode aliases
  "fort-myers": "HPFM",
  fasttrax: "FT",
  naples: "HPN",
};

/** Safe default tag when a location/center is unrecognized (FM is the hub). */
const DEFAULT_CENTER_TAG = "HPFM";

/**
 * Build the deposit-GAN prefix for a channel + Square location (or centerCode).
 * e.g. buildGanPrefix("WEB", "LAB52GY480CJF") → "WEBFT".
 */
export function buildGanPrefix(channel: GanChannel, locationOrCenter: string): string {
  const tag = CENTER_TAG_BY_LOCATION[locationOrCenter] ?? DEFAULT_CENTER_TAG;
  return `${channel}${tag}`;
}

/**
 * Legacy prefixes still live in the wild on already-minted (immutable) cards.
 * Never remove an entry — doing so would let an old deposit card be redeemed.
 *   HPFM/HPN  bowling deposits · RACE/ATTR  v2 race & attraction deposits
 *   GRPF      old group-function deposits · DEPX  oldest bowling refund format
 */
export const LEGACY_DEPOSIT_GAN_PREFIXES = ["HPFM", "HPN", "DEPX", "RACE", "ATTR", "GRPF"] as const;

/** Current scheme (channel + center). Emitted by buildGanPrefix + the GF map. */
export const CURRENT_DEPOSIT_GAN_PREFIXES = [
  "GFHPFM",
  "GFFT",
  "GFHPN",
  "WEBHPFM",
  "WEBFT",
  "WEBHPN",
] as const;

/** Every deposit-GAN prefix ever issued — the set isInternalDepositGan blocks. */
export const KNOWN_DEPOSIT_GAN_PREFIXES: readonly string[] = [
  ...LEGACY_DEPOSIT_GAN_PREFIXES,
  ...CURRENT_DEPOSIT_GAN_PREFIXES,
];

/** Square custom-GAN length window. Outside this, Square auto-generates one. */
export const GAN_MIN_LEN = 8;
export const GAN_MAX_LEN = 20;

/**
 * Compose a custom GAN guaranteed to fit Square's 8–20 char window, so a custom
 * GAN is ALWAYS used when the prefix fits. This is a safety guarantee, not a
 * nicety: if a GAN exceeds 20 chars Square silently issues an auto-generated
 * NUMERIC gan, which isInternalDepositGan would not recognize — making that
 * deposit card redeemable as payment. We strip non-alphanumerics and trim the
 * suffix tail (the prefix is the meaningful part, so it's preserved) to fit.
 *
 * Returns `useCustom: false` only when the prefix alone can't satisfy the 8–20
 * window (prefix < 8 with no suffix, or prefix > 20) — caller then lets Square
 * auto-generate.
 */
export function composeGan(prefix: string, suffix: string): { gan: string; useCustom: boolean } {
  const cleanPrefix = (prefix || "").replace(/[^A-Za-z0-9]/g, "");
  let cleanSuffix = (suffix || "").replace(/[^A-Za-z0-9]/g, "");

  const room = GAN_MAX_LEN - cleanPrefix.length;
  if (cleanSuffix.length > room) {
    // Keep the tail of the suffix (most-significant/most-unique digits of a
    // bill/reservation id live at the end via the .slice(-8) callers).
    cleanSuffix = room > 0 ? cleanSuffix.slice(-room) : "";
  }

  const gan = `${cleanPrefix}${cleanSuffix}`;
  const useCustom = gan.length >= GAN_MIN_LEN && gan.length <= GAN_MAX_LEN;
  return { gan, useCustom };
}
