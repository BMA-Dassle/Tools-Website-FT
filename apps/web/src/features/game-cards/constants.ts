/**
 * Game-card product catalog. Token packages the guest can buy to reload a card.
 *
 * ONE Square catalog item (`SQUARE_TOKEN_CATALOG_ID`) backs every package; the
 * price is overridden per package (Square catalog id is for dashboard
 * categorization, not pricing — same pattern as race packs). The server always
 * re-derives price + token counts from the package id; client-sent amounts are
 * ignored (price↔charge pairing hard rule).
 *
 * `tokens` credit the card's Tokens bucket; `bonusTokens` credit the separate
 * BonusTokens bucket (purchased vs promo are tracked/refunded separately).
 */

import { SQUARE_CATALOG_IDS } from "~/features/booking/data/square-catalog-map";

/** One Square catalog item backs every token package (price overridden per package). */
export const SQUARE_TOKEN_CATALOG_ID = SQUARE_CATALOG_IDS.GAME_TOKENS;

/**
 * A brand-NEW physical card carries a one-time $2 activation fee — its OWN
 * Square catalog id so reporting separates activation fees from token sales
 * (owner 2026-07-18). Charged once per new card; reloads never activate, so no
 * fee. The fee is a separate order line ON TOP of the token package price
 * (e.g. a new 50-token card = $5 tokens + $2 = $7), threaded identically through
 * the reader charge and the server-side finalize so displayed == charged.
 */
export const SQUARE_ACTIVATION_FEE_CATALOG_ID = "YEUGYDCTUUHSCVJU45LPN7BR";
export const ACTIVATION_FEE_CENTS = 200;

/** The activation fee owed for a purchase of `cardCount` NEW cards (0 for reloads). */
export function activationFeeCents(kind: "new_card" | "reload", cardCount: number): number {
  return kind === "new_card" ? ACTIVATION_FEE_CENTS * Math.max(0, cardCount) : 0;
}

export interface TokenPackage {
  id: string;
  label: string;
  priceCents: number;
  tokens: number;
  bonusTokens: number;
  /**
   * Checkout-upsell special (owner 2026-07-21): offered ONLY on the kiosk's
   * post-"Review & Pay" upsell page. Implies, everywhere the pack flows:
   *   - hidden from the /reload grid and the standalone Game Zone grids;
   *   - the $2 new-card activation fee is WAIVED (the marketed price is the
   *     whole price — "$5" must never ring up as $7);
   *   - quantity capped at one card per person on the transaction (client
   *     stepper + reserve-time guard);
   *   - `compareAtCents` renders the strikethrough "was" price — DISPLAY
   *     ONLY, `priceCents` stays the charge authority.
   */
  upsell?: { compareAtCents: number };
}

export const TOKEN_PACKAGES: readonly TokenPackage[] = [
  { id: "tok-50", label: "50 Tokens", priceCents: 500, tokens: 50, bonusTokens: 0 },
  { id: "tok-100", label: "100 Tokens", priceCents: 1000, tokens: 100, bonusTokens: 0 },
  { id: "tok-200", label: "200 Tokens", priceCents: 2000, tokens: 200, bonusTokens: 0 },
  { id: "tok-300", label: "300 Tokens + 50 Bonus", priceCents: 3000, tokens: 300, bonusTokens: 50 },
  {
    id: "tok-500",
    label: "500 Tokens + 100 Bonus",
    priceCents: 5000,
    tokens: 500,
    bonusTokens: 100,
  },
  {
    id: "tok-1000",
    label: "1000 Tokens + 250 Bonus",
    priceCents: 10000,
    tokens: 1000,
    bonusTokens: 250,
  },
  // Checkout upsell (owner 2026-07-21): "100 tokens for $5 — 50% off". The
  // marketed 100 tokens load as 50 regular (matching the $5 at the normal
  // 10¢/token rate) + 50 bonus making up the discount — reg vs bonus buckets
  // are tracked/refunded separately end-to-end. APPEND-ONLY position: grids
  // default to TOKEN_PACKAGES[1], so this must stay last.
  {
    id: "tok-upsell-100",
    label: "100 Tokens — Checkout Special",
    priceCents: 500,
    tokens: 50,
    bonusTokens: 50,
    upsell: { compareAtCents: 1000 },
  },
] as const;

export function getPackage(id: string): TokenPackage | null {
  return TOKEN_PACKAGES.find((p) => p.id === id) ?? null;
}
