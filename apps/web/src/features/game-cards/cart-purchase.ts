/**
 * Game Zone cards riding the BOOKING CART (kiosk, owner 2026-07-18) — the ONE
 * place a `session.gameCardPurchase` is resolved into money: package prices,
 * the new-card activation fee, and the Square line items that ride the
 * DEPOSIT order (token catalog + activation-fee catalog — never a day-of
 * order). Pure data, safe on client AND server; both reserve rails and the
 * checkout display resolve through here so displayed == ordered == charged.
 *
 * The session entries are selection POINTERS (packageId + reload account) —
 * prices always re-derive from TOKEN_PACKAGES, never from the client.
 */
import {
  getPackage,
  activationFeeCents,
  ACTIVATION_FEE_CENTS,
  SQUARE_TOKEN_CATALOG_ID,
  SQUARE_ACTIVATION_FEE_CATALOG_ID,
  type TokenPackage,
} from "./constants";
import type { GameCardCartPurchase } from "~/features/booking/state/types";

export interface ResolvedCartCard {
  packageId: string;
  /** "" for a new card (account attached when the blank is dispensed). */
  accountNumber: string;
  pkg: TokenPackage;
}

export interface ResolvedCartPurchase {
  mode: "new_card" | "reload";
  cards: ResolvedCartCard[];
  /** Σ package prices + new-card activation fees — what the cards add to the charge. */
  totalCents: number;
  /** Square ITEM lines for the deposit order (token line per card + one fee line). */
  orderLines: Array<{
    name: string;
    quantity: string;
    catalogObjectId: string;
    amountCents: number;
  }>;
}

/**
 * Resolve a session's card purchase to authoritative money. Returns null when
 * there's nothing attached; THROWS on an unknown package or a reload entry
 * missing its account (callers surface it — never charge on bad pointers).
 */
export function resolveCartPurchase(
  p: GameCardCartPurchase | undefined | null,
): ResolvedCartPurchase | null {
  if (!p || p.cards.length === 0) return null;
  const cards: ResolvedCartCard[] = p.cards.map((c) => {
    const pkg = getPackage(c.packageId);
    if (!pkg) throw new Error(`Unknown token package: ${c.packageId}`);
    if (p.mode === "reload" && !c.accountNumber?.trim()) {
      throw new Error("A reload card is missing its account number");
    }
    return { packageId: c.packageId, accountNumber: c.accountNumber?.trim() ?? "", pkg };
  });
  // EVERY new card pays the one-time activation fee — checkout-upsell cards
  // included (owner 2026-07-21, reversing the earlier waiver: "add card
  // activation fee to upsell"). The upsell page displays the fee explicitly
  // so its CTA total matches this charge.
  const totalCents =
    cards.reduce((s, c) => s + c.pkg.priceCents, 0) + activationFeeCents(p.mode, cards.length);
  const orderLines: ResolvedCartPurchase["orderLines"] = cards.map((c) => ({
    name:
      p.mode === "new_card"
        ? `${c.pkg.label} (new card)`
        : `${c.pkg.label} → card ${c.accountNumber}`,
    quantity: "1",
    catalogObjectId: SQUARE_TOKEN_CATALOG_ID,
    amountCents: c.pkg.priceCents,
  }));
  if (p.mode === "new_card") {
    orderLines.push({
      name: "Card activation fee",
      quantity: String(cards.length),
      catalogObjectId: SQUARE_ACTIVATION_FEE_CATALOG_ID,
      amountCents: ACTIVATION_FEE_CENTS,
    });
  }
  return { mode: p.mode, cards, totalCents, orderLines };
}
