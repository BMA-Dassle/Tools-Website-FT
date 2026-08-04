/**
 * HeadPinz Naples limited-time offer modal — SERVER shell.
 *
 * WHY THIS IS A LIMITED-TIME OFFER, AND WHY THAT IS TRUE (owner 2026-08-03):
 * "These deals are NOT available to just anyone and we don't advertise them
 * anywhere on our website… therefore they can be treated as a limited time
 * offer. /deals is a google based offer."
 *
 * That is the whole basis of the claim, and it is worth being precise about what
 * it does and does not say. The PRICE is not changing on Friday — the packs will
 * still be $34/$45 to anyone who reaches `/deals` through search afterwards. What
 * ends is THIS OFFER: the window in which HeadPinz Naples visitors are told the
 * packs exist at all, on a site that otherwise links to them from nowhere. So the
 * copy below advertises exactly that and never implies a price rise. A guest who
 * comes back on Saturday and finds the same price has not been misled — they were
 * told the offer was open through Friday, and through Friday is when it was open
 * to them.
 *
 * NO BONUS, NO ON-PAGE URGENCY. Both were tried and dropped (owner: "we're
 * ditching the 50 token thing and all the urgency UI"). This modal is the single
 * urgency surface that remains, and it is INDEPENDENT — its own flag, its own
 * deadline, no dependency on the deal catalog's offer mechanism.
 *
 * Prices and savings still come from the same resolver and `dealValue` the
 * checkout uses, so an ad can never quote a number the buy panel will not honour.
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

  const sellable = DEAL_CATALOG.filter(
    (d) => dealIsSellable(d) && d.locations.includes(LOCATION),
  );
  if (sellable.length === 0) return null;

  const deals: NaplesOfferDeal[] = await Promise.all(
    sellable.map(async (deal) => {
      const offer = await currentDealOffer(deal);
      const value = dealValue(deal, LOCATION, offer.unitPriceCents, offer.bonusItems);
      return {
        slug: deal.slug,
        name: deal.name,
        priceLabel: money(offer.unitPriceCents),
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
    // Says what is actually limited. Not "prices go up" — they do not.
    note: "We don't list these anywhere else on our site. This offer is open to Naples guests through Friday.",
  };

  return <NaplesOfferPopupClient content={content} />;
}
