/**
 * HeadPinz Naples flash-sale popup — SERVER shell.
 *
 * Advertises the prepaid deal packs on the site itself. Those pages are
 * deliberately unlinked from navigation (owner 2026-08-02) so they can serve
 * paid search without cannibalising the main site; this is a deliberate, scoped
 * exception (owner 2026-08-03: "advertise these deals that would normally not be
 * available straight on our website"), not a reversal of that — nothing else
 * links to /deals, and this popup only appears while an offer is actually
 * running.
 *
 * EVERY FACT COMES FROM THE SAME RESOLVER THE CHECKOUT USES. The price, the
 * saving, the bonus and the deadline are all `currentDealOffer` + `dealValue`,
 * so an ad can never promise something the buy panel will not honour — the
 * failure mode that matters most for an unsolicited popup, because the guest did
 * not go looking for it and will judge the whole brand on whether it was true.
 *
 * IT SELF-HIDES WHEN THERE IS NOTHING TO ADVERTISE. No live offer, no deadline,
 * or no sellable deal ⇒ renders nothing. A "flash sale" with no flash is the
 * fake-urgency pattern, and the cheapest way never to ship it is to make the
 * component structurally incapable of rendering without a real one.
 *
 * Kill switches: `DEALS_URGENCY_UI=false` (server-read, no rebuild needed) turns
 * off every urgency surface including this one.
 */

import { ATTRACTIONS } from "@/lib/attractions-data";
import {
  currentDealOffer,
  DEAL_CATALOG,
  dealIsSellable,
  dealValue,
} from "~/features/deals";
import { dealsUrgencyUiEnabled } from "~/features/deals/flags";
import { money } from "~/features/deals/format";
import { FlashSalePopupClient, type FlashSaleContent, type FlashSaleDeal } from "./FlashSalePopupClient";

/** The venue this popup is scoped to. Naples only, by owner decision. */
const LOCATION = "naples" as const;

export async function FlashSalePopup() {
  if (!dealsUrgencyUiEnabled()) return null;

  const resolved = await Promise.all(
    DEAL_CATALOG.filter((d) => dealIsSellable(d) && d.locations.includes(LOCATION)).map(
      async (deal) => ({ deal, offer: await currentDealOffer(deal) }),
    ),
  );

  // A deadline is required, not optional: the countdown IS the creative, and an
  // allocation-only offer has nothing to tick down to.
  const live = resolved.filter((r) => r.offer.isOfferLive && r.offer.endsAt && r.offer.bonusLabel);
  if (live.length === 0) return null;

  // All live offers share one clock — the soonest deadline, so the countdown can
  // never outlive the thing it is counting down to.
  const endsAt = live
    .map((r) => r.offer.endsAt!)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];

  const deals: FlashSaleDeal[] = live.map(({ deal, offer }) => {
    const value = dealValue(deal, LOCATION, offer.unitPriceCents, offer.bonusItems);
    return {
      slug: deal.slug,
      name: deal.name,
      priceLabel: money(offer.unitPriceCents),
      savingsLabel: money(value.savingsCents),
      bonusLabel: offer.bonusLabel!,
      accent: ATTRACTIONS[deal.scheduleSlug]?.color ?? "#fd5b56",
      image: deal.media.hero,
    };
  });

  const content: FlashSaleContent = {
    endsAt,
    deals,
    // The line that keeps the word "sale" honest. These packs ARE below the door
    // price permanently; what ends on Thursday is the bonus, and saying so
    // plainly is what stops a guest who comes back on Friday feeling tricked.
    priceNote: "Pack prices don't change after that — the bonus tokens are what end.",
  };

  return <FlashSalePopupClient content={content} />;
}
