/**
 * EXTRA CARD SLOTS on the Collateral screen — the seam C5 needs.
 *
 * The prototype's collateral screen renders the quote-template card between
 * the file grid and the message templates:
 *
 *     ${window.UI && window.UI.quoteTemplatesCard ? window.UI.quoteTemplatesCard() : ""}
 *                                                     — crm-shared.js:484
 *
 * That conditional is the whole design, and this is its typed equivalent.
 * `collateral/QuoteTemplatesCard.tsx` belongs to C5 (it reads
 * `crm_quote_templates`, which C5 owns), but the SCREEN belongs to C6. Rather
 * than have C5 edit `CollateralScreen.tsx` — a component with its own state,
 * queries and tests — it replaces ONE LINE here, exactly as a feature PR
 * replaces one line of `core/screens.ts` (brief §3.5).
 *
 *     "quote-templates": () => import("~/components/features/crm/collateral/QuoteTemplatesCard"),
 *
 * `null` means "that PR has not landed": the screen renders nothing at all for
 * the slot — no placeholder, no empty card, no mention of a feature a rep
 * cannot use. `extra-cards.test.ts` pins that every id has an entry and that a
 * `null` entry renders nothing, so C5's flip cannot silently do nothing.
 */

import type { ComponentType } from "react";
import type { CentreCode } from "../core/types";

/** What every extra card receives: the screen's current centre filter. */
export interface CollateralExtraCardProps {
  /** null = the "All" folder. */
  centre: CentreCode | null;
}

export type CollateralExtraCard = ComponentType<CollateralExtraCardProps>;

export type CollateralExtraCardLoader = () => Promise<{ default: CollateralExtraCard }>;

/**
 * Slot order IS render order, between the file grid and the message templates
 * — the prototype's position for the quote-template card.
 */
export const COLLATERAL_EXTRA_CARD_IDS = ["quote-templates"] as const;

export type CollateralExtraCardId = (typeof COLLATERAL_EXTRA_CARD_IDS)[number];

/** One line per slot. A feature PR replaces exactly its own line. */
export const COLLATERAL_EXTRA_CARDS: Record<
  CollateralExtraCardId,
  CollateralExtraCardLoader | null
> = {
  "quote-templates": null,
};

/** The slots that actually have a component today, in render order. */
export function shippedExtraCards(): {
  id: CollateralExtraCardId;
  load: CollateralExtraCardLoader;
}[] {
  const out: { id: CollateralExtraCardId; load: CollateralExtraCardLoader }[] = [];
  for (const id of COLLATERAL_EXTRA_CARD_IDS) {
    const load = COLLATERAL_EXTRA_CARDS[id];
    if (load) out.push({ id, load });
  }
  return out;
}
