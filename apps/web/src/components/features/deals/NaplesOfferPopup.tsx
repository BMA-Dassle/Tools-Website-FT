/**
 * HeadPinz Naples limited-time offer modal — SERVER shell.
 *
 * WHAT IT ADVERTISES NOW (owner 2026-08-10): a FLASH SALE — a genuine 25%
 * markdown configured as `salePriceCents` on the catalog's `limitedOffer`, ending
 * Friday night. Unlike the 8/3 run (where the only limited thing was ACCESS —
 * "we don't advertise them anywhere" — and the comments here stressed that the
 * price was NOT changing), this time the price really is what changes: $25.50
 * and $33.75 through Friday, $34 and $45 after. The countdown is honest because
 * the discount genuinely ends, enforced by the same resolver the charge path
 * re-resolves at charge time. What remains banned is the reverse claim — a
 * countdown to a REGULAR-price rise nobody intends to perform.
 *
 * The modal stays the single urgency surface (owner 2026-08-03: no on-page
 * urgency), with its own flag and its own window. The window date
 * (`naples-offer-window.ts`) is kept equal to the catalog's FLASH_SALE_ENDS_AT
 * so the ad can never outlive the sale it advertises. If the two ever diverge,
 * the popup shows regular prices — wrong-looking, never wrong-charging, because
 * prices and savings come from the same resolver and `dealValue` the checkout
 * uses.
 *
 * Kill switch: `DEALS_NAPLES_POPUP=false` (server-read, no rebuild needed).
 */

import { ATTRACTIONS } from "@/lib/attractions-data";
import { currentDealOffer, DEAL_CATALOG, dealIsSellable, dealValue } from "~/features/deals";
import { dealsNaplesPopupEnabled } from "~/features/deals/flags";
import { money } from "~/features/deals/format";
import { dealOfferEndsAt } from "~/features/deals/service/offer";
import { NAPLES_OFFER_ENDS_AT, naplesOfferIsOpen } from "./naples-offer-window";
import {
  NaplesOfferPopupClient,
  type NaplesOfferContent,
  type NaplesOfferDeal,
} from "./NaplesOfferPopupClient";

/** The venue this is scoped to. Naples only, by owner decision. */
const LOCATION = "naples" as const;

export async function NaplesOfferPopup() {
  if (!dealsNaplesPopupEnabled()) return null;

  const endsAt = dealOfferEndsAt(NAPLES_OFFER_ENDS_AT);
  // Past the deadline this renders nothing at all — the component is
  // structurally incapable of advertising an offer that has closed.
  if (!(await naplesOfferIsOpen(endsAt))) return null;

  const sellable = DEAL_CATALOG.filter((d) => dealIsSellable(d) && d.locations.includes(LOCATION));
  if (sellable.length === 0) return null;

  const deals: NaplesOfferDeal[] = await Promise.all(
    sellable.map(async (deal) => {
      const offer = await currentDealOffer(deal);
      const value = dealValue(deal, LOCATION, offer.unitPriceCents, offer.bonusItems);
      return {
        slug: deal.slug,
        name: deal.name,
        priceLabel: money(offer.unitPriceCents),
        // The strikethrough, present only while a sale genuinely discounts it.
        wasLabel:
          offer.unitPriceCents < offer.regularPriceCents ? money(offer.regularPriceCents) : null,
        savingsLabel: money(value.savingsCents),
        savingsPct: value.savingsPct,
        accent: ATTRACTIONS[deal.scheduleSlug]?.color ?? "#fd5b56",
        image: deal.media.hero,
      };
    }),
  );

  const content: NaplesOfferContent = {
    endsAt,
    deals,
    // Says what is actually limited: the sale price, with the real after-number.
    note: "25% off ends Friday night — after that these packs return to their regular prices. We don't list them anywhere else on our site.",
  };

  return <NaplesOfferPopupClient content={content} />;
}
