import { describe, expect, it } from "vitest";
import { getDeal, type DealCatalogEntry } from "../catalog";
import type { DealPurchaseRow } from "../data/deal-purchases-db";
import { resolveDealOffer } from "./offer";
import { abandonReturnUrl, abandonUrgencyLine, renderAbandonEmail } from "./abandon-recovery";

/**
 * The send path itself is exercised by the cron's dryRun and by rendering the
 * template to disk; what is worth pinning here is everything that could put a
 * WRONG number or a false claim in front of a guest.
 */

const laser = getDeal("laser-tag-game-card-pack")!;

function row(over: Partial<DealPurchaseRow> = {}): DealPurchaseRow {
  return {
    id: 42,
    dealSlug: "laser-tag-game-card-pack",
    locationKey: "headpinz",
    centerCode: 12,
    qty: 1,
    combine: true,
    unitPriceCents: 3400,
    subtotalCents: 3400,
    taxCents: 221,
    totalCents: 3621,
    buyerName: "Dana Reyes",
    buyerEmail: "dana@example.com",
    buyerPhone: "+12395550123",
    smsOptIn: false,
    status: "pending",
    squareOrderId: null,
    squarePaymentId: null,
    idempotencyKey: "k",
    voucherBatchId: null,
    codes: [],
    utm: null,
    clickwrapVersion: null,
    lastError: null,
    refundedAt: null,
    refundReason: null,
    abandonEmailSentAt: null,
    bonusItems: [],
    // Not a gift. A gift's recovery email would need to address the BUYER about
    // a purchase for someone else — out of scope here, and the sweep has no
    // special handling for it, so these stay at their non-gift defaults.
    isGift: false,
    recipientName: null,
    recipientEmail: null,
    recipientPhone: null,
    giftMessage: null,
    giftSendAt: null,
    giftSentAt: null,
    createdAt: "2026-08-03T14:00:00.000Z",
    chargedAt: null,
    mintedAt: null,
    sentAt: null,
    ...over,
  };
}

const BONUS_50 = { kind: "gamezone" as const, tokens: 0, bonusTokens: 50, bonusCashDollars: 0 };

function withOffer(extra: Partial<{ endsAt: string; allocation: number }> = {}): DealCatalogEntry {
  return {
    ...laser,
    limitedOffer: {
      bonusItems: [BONUS_50],
      label: "50 bonus tokens per pack",
      endsAt: "2026-09-07T23:59:59",
      ...extra,
    },
  };
}

// The catalog ships a live flash sale, so the "nothing running" cases have to
// strip it off explicitly rather than relying on the registry being empty.
const noOfferDeal: DealCatalogEntry = { ...laser, limitedOffer: null };
const noOffer = resolveDealOffer(noOfferDeal, new Date("2026-08-03T18:00:00Z"), 0);

describe("abandonReturnUrl", () => {
  it("returns them to the same deal at the same venue, tagged for attribution", () => {
    const url = new URL(abandonReturnUrl(row()));
    expect(url.pathname).toBe("/deals/laser-tag-game-card-pack");
    expect(url.searchParams.get("location")).toBe("headpinz");
    expect(url.searchParams.get("utm_campaign")).toBe("deal_abandon_recovery");
    // qty 1 is the default; no need to clutter the link with it.
    expect(url.searchParams.get("qty")).toBeNull();
  });

  it("carries the quantity back when they were buying more than one", () => {
    const url = new URL(abandonReturnUrl(row({ qty: 3, locationKey: "naples" })));
    expect(url.searchParams.get("qty")).toBe("3");
    expect(url.searchParams.get("location")).toBe("naples");
  });
});

describe("abandonUrgencyLine", () => {
  it("says nothing when there is no offer running — no invented hurry", () => {
    expect(abandonUrgencyLine(noOffer)).toBeNull();
  });

  it("names the real bonus and the real deadline, and denies a price rise", () => {
    const offer = resolveDealOffer(withOffer(), new Date("2026-09-01T12:00:00-04:00"), 0);
    expect(abandonUrgencyLine(offer)).toBe(
      "Right now it also includes 50 bonus tokens per pack, through Monday, September 7. " +
        "The price is the same afterwards — the bonus is what goes.",
    );
  });

  it("falls back to packs remaining when the offer is allocation-only", () => {
    const allocationOnly = { ...withOffer({ allocation: 200 }) };
    // Strip the deadline so the allocation branch is the one under test.
    allocationOnly.limitedOffer = {
      bonusItems: [BONUS_50],
      label: "50 bonus tokens per pack",
      allocation: 200,
    };
    const offer = resolveDealOffer(allocationOnly, new Date("2026-09-01T12:00:00-04:00"), 188);
    expect(abandonUrgencyLine(offer)).toBe(
      "Right now it also includes 50 bonus tokens per pack, on the last 12 packs. " +
        "The price is the same afterwards — the bonus is what goes.",
    );
  });

  it("says nothing once the offer is over", () => {
    const offer = resolveDealOffer(withOffer(), new Date("2026-09-08T12:00:00-04:00"), 0);
    expect(abandonUrgencyLine(offer)).toBeNull();
  });

  it("states the real before-and-after numbers for a genuine sale price", () => {
    const saleDeal: DealCatalogEntry = {
      ...laser,
      limitedOffer: {
        bonusItems: [],
        label: "25% off flash sale",
        salePriceCents: 2550,
        endsAt: "2026-09-07T23:59:59",
      },
    };
    const offer = resolveDealOffer(saleDeal, new Date("2026-09-01T12:00:00-04:00"), 0);
    expect(abandonUrgencyLine(offer)).toBe(
      "Right now it is $25.50 instead of the regular $34, through Monday, September 7. " +
        "After that it goes back to the regular price.",
    );
    // The subject names the price that is about to end, never a vague hurry.
    expect(renderAbandonEmail({ row: row(), deal: saleDeal, offer }).subject).toBe(
      "Your Laser Tag + Game Card Pack is still here — and still $25.50 for now",
    );
  });
});

describe("renderAbandonEmail", () => {
  it("resolves the offer NOW, so an ended bonus is never promised", () => {
    // The row was written while a 50-token offer was running. It has since
    // ended. Dangling an extra that no longer exists in front of someone we are
    // asking to come back and pay is worse than not mailing at all.
    const deal = withOffer();
    const offer = resolveDealOffer(deal, new Date("2026-09-08T12:00:00-04:00"), 0);
    const { html, text } = renderAbandonEmail({ row: row(), deal, offer });
    for (const part of [html, text]) {
      expect(part).not.toContain("bonus");
      expect(part).toContain("$34 plus tax");
    }
  });

  it("never implies the price is about to rise", () => {
    // The one claim this whole feature refuses to make. A bonus ends; the price
    // does not move, and no surface may suggest otherwise.
    const deal = withOffer();
    const live = resolveDealOffer(deal, new Date("2026-09-01T12:00:00-04:00"), 0);
    const { html, text, subject } = renderAbandonEmail({ row: row(), deal, offer: live });
    for (const part of [html, text, subject]) {
      expect(part).not.toMatch(/price (goes|moves) up|after that it is \$|\$39/i);
    }
    expect(text).toContain("The price is the same afterwards");
  });

  it("changes the subject line only when there is a real bonus to name", () => {
    const running = resolveDealOffer(withOffer(), new Date("2026-09-01T12:00:00-04:00"), 0);
    expect(renderAbandonEmail({ row: row(), deal: withOffer(), offer: running }).subject).toMatch(
      /bonus that ends soon/,
    );
    expect(renderAbandonEmail({ row: row(), deal: noOfferDeal, offer: noOffer }).subject).toBe(
      "You left your Laser Tag + Game Card Pack behind",
    );
  });

  it("carries the CAN-SPAM requirements in both parts", () => {
    const { html, text } = renderAbandonEmail({ row: row(), deal: noOfferDeal, offer: noOffer });
    for (const part of [html, text]) {
      expect(part).toContain("14513 Global Pkwy, Fort Myers, FL 33913");
      expect(part.toLowerCase()).toContain("unsubscribe");
      // The one-and-done promise is part of the deal we are making with them.
      expect(part).toContain("will not email you about it again");
    }
  });

  it("greets by first name only, and copes with no name at all", () => {
    expect(renderAbandonEmail({ row: row(), deal: noOfferDeal, offer: noOffer }).text).toContain(
      "Hi Dana,",
    );
    const anon = renderAbandonEmail({
      row: row({ buyerName: null }),
      deal: laser,
      offer: noOffer,
    });
    expect(anon.text.startsWith("Hi,")).toBe(true);
  });

  it("escapes a name that contains markup", () => {
    const { html } = renderAbandonEmail({
      row: row({ buyerName: "<script>alert(1)</script> Reyes" }),
      deal: laser,
      offer: noOffer,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("states the basket, and the link restores it", () => {
    // The copy and the link have to agree. `?qty=` is read and clamped by
    // app/deals/[slug]/page.tsx and handed to the panel as initialQty — if that
    // ever stops happening, this email promises a basket the page throws away.
    const { html, text } = renderAbandonEmail({
      row: row({ qty: 3 }),
      deal: laser,
      offer: noOffer,
    });
    expect(html).toContain("You had 3 in your basket");
    expect(text).toContain("You had 3 in your basket");
    expect(html).toContain("qty=3");
  });

  it("says it in the singular for one pack", () => {
    const { html } = renderAbandonEmail({ row: row(), deal: noOfferDeal, offer: noOffer });
    expect(html).toContain("It is $34 plus tax.");
    expect(html).not.toContain("in your basket");
  });

  it("names the venue they picked", () => {
    const { html } = renderAbandonEmail({
      row: row({ locationKey: "naples" }),
      deal: laser,
      offer: noOffer,
    });
    expect(html).toContain("HeadPinz Naples");
  });
});
