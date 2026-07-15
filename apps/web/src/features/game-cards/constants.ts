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

export interface TokenPackage {
  id: string;
  label: string;
  priceCents: number;
  tokens: number;
  bonusTokens: number;
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
] as const;

export function getPackage(id: string): TokenPackage | null {
  return TOKEN_PACKAGES.find((p) => p.id === id) ?? null;
}
