import { describe, expect, it } from "vitest";
import { COMP_TOKEN_DENOMINATIONS } from "~/features/game-cards/vouchers/grants";
import { NATIVE_GRANT_DENOMINATIONS } from "~/features/game-cards/service/native-voucher";
import { DEAL_CATALOG, FLASH_SALE_ENDS_AT, getDeal, type DealCatalogEntry } from "../catalog";
import { dealNeedsSoldCount, dealOfferEndsAt, resolveDealOffer } from "./offer";
import { NAPLES_OFFER_ENDS_AT } from "~/components/features/deals/naples-offer-window";

/**
 * The offer resolver decides what a buyer is owed, so these tests are about
 * boundaries rather than happy paths: the exact instant an offer ends, the exact
 * pack that exhausts an allocation, and the two ways a deadline can land a day
 * out. Every case injects `now` and `packsSold` — nothing here reads a clock.
 */

const laser = getDeal("laser-tag-game-card-pack")!;

const BONUS_50 = {
  kind: "gamezone" as const,
  tokens: 0,
  bonusTokens: 50,
  bonusCashDollars: 0,
};

/** A deal with an offer bolted on, so the shipped catalog stays untouched. */
function withOffer(limitedOffer: DealCatalogEntry["limitedOffer"]): DealCatalogEntry {
  return { ...laser, limitedOffer };
}

const fiftyTokens = (extra: Partial<{ endsAt: string; allocation: number }> = {}) =>
  withOffer({
    bonusItems: [BONUS_50],
    label: "50 bonus tokens per pack",
    endsAt: "2026-09-07T23:59:59",
    ...extra,
  });

/** The catalog entry with any shipped offer stripped off. */
const noOfferDeal: DealCatalogEntry = { ...laser, limitedOffer: null };

describe("the shipped catalog", () => {
  // Owner 2026-08-10: "lets run a flash sale for additional 25% off." This
  // describe is the guard that an offer is never switched on OR off without
  // someone deciding to — it pins exactly what is configured, so any edit to
  // the catalog's `limitedOffer` fields has to come here and say so.
  it("runs the 25%-off flash sale on both packs, ending Friday 8/14", () => {
    for (const deal of DEAL_CATALOG) {
      expect(deal.limitedOffer).not.toBeNull();
      expect(deal.limitedOffer!.endsAt).toBe(FLASH_SALE_ENDS_AT);
      expect(deal.limitedOffer!.bonusItems).toEqual([]);
      // Exactly 25% off, to the cent — both regular prices are divisible by 4.
      expect(deal.limitedOffer!.salePriceCents).toBe(deal.priceCents * 0.75);
    }
  });

  it("charges the sale price while it runs and the regular price after", () => {
    for (const deal of DEAL_CATALOG) {
      const during = resolveDealOffer(deal, new Date("2026-08-10T12:00:00-04:00"), 0);
      const after = resolveDealOffer(deal, new Date("2026-08-15T12:00:00-04:00"), 0);
      expect(during.isOfferLive).toBe(true);
      expect(during.unitPriceCents).toBe(deal.priceCents * 0.75);
      expect(during.regularPriceCents).toBe(deal.priceCents);
      expect(after.isOfferLive).toBe(false);
      expect(after.unitPriceCents).toBe(deal.priceCents);
      // No bonus rides this sale — nothing extra to mint.
      expect(during.bonusItems).toEqual([]);
    }
  });

  it("keeps the flash sale and the Naples popup window on the same instant", () => {
    // The popup is the ad; the catalog is the price. If these drift apart the
    // ad either outlives the sale or dies before it — both are wrong.
    expect(NAPLES_OFFER_ENDS_AT).toBe(FLASH_SALE_ENDS_AT);
  });
});

describe("the Naples advertising window", () => {
  it("has a deadline that parses as ET wall-clock", () => {
    // The modal's own deadline, independent of the catalog. A typo here would
    // make `new Date()` return Invalid Date, and every comparison against NaN is
    // false — the window would read as "never closed". Fail at the typo.
    expect(() => dealOfferEndsAt(NAPLES_OFFER_ENDS_AT)).not.toThrow();
    expect(dealOfferEndsAt(NAPLES_OFFER_ENDS_AT)).toBe("2026-08-14T23:59:59-04:00");
  });

  it("closes at 11:59 PM Eastern on the advertised day", () => {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
    expect(fmt.format(new Date(dealOfferEndsAt(NAPLES_OFFER_ENDS_AT)))).toBe("Friday 23:59");
  });
});

describe("no offer configured", () => {
  it("grants nothing extra and holds the price", () => {
    const o = resolveDealOffer(noOfferDeal, new Date("2026-08-03T12:00:00-04:00"), 0);
    expect(o.unitPriceCents).toBe(3400);
    expect(o.isOfferLive).toBe(false);
    expect(o.bonusItems).toEqual([]);
    expect(o.bonusLabel).toBeNull();
    expect(o.endsAt).toBeNull();
    expect(o.remaining).toBeNull();
  });

  it("needs no sold count without an allocation", () => {
    expect(dealNeedsSoldCount(noOfferDeal)).toBe(false);
    expect(dealNeedsSoldCount(fiftyTokens())).toBe(false);
    expect(dealNeedsSoldCount(fiftyTokens({ allocation: 200 }))).toBe(true);
  });
});

describe("a bonus-only offer never moves the price", () => {
  it("charges the same before, during and after the offer", () => {
    const deal = fiftyTokens({ allocation: 200 });
    const during = resolveDealOffer(deal, new Date("2026-09-01T12:00:00-04:00"), 5);
    const afterDate = resolveDealOffer(deal, new Date("2026-09-09T12:00:00-04:00"), 5);
    const afterSellout = resolveDealOffer(deal, new Date("2026-09-01T12:00:00-04:00"), 200);
    for (const o of [during, afterDate, afterSellout]) {
      expect(o.unitPriceCents).toBe(3400);
      expect(o.regularPriceCents).toBe(3400);
    }
    // Only the contents differ.
    expect(during.bonusItems).toHaveLength(1);
    expect(afterDate.bonusItems).toHaveLength(0);
    expect(afterSellout.bonusItems).toHaveLength(0);
  });
});

describe("a sale price is a genuine markdown or nothing", () => {
  const onSale = (salePriceCents: number | null) =>
    withOffer({
      bonusItems: [],
      label: "25% off flash sale",
      salePriceCents,
      endsAt: "2026-09-07T23:59:59",
    });
  const during = new Date("2026-09-01T12:00:00-04:00");
  const after = new Date("2026-09-08T12:00:00-04:00");

  it("charges the sale price while live and reverts the instant it ends", () => {
    const live = resolveDealOffer(onSale(2550), during, 0);
    expect(live.unitPriceCents).toBe(2550);
    expect(live.regularPriceCents).toBe(3400);
    const ended = resolveDealOffer(onSale(2550), after, 0);
    expect(ended.unitPriceCents).toBe(3400);
    expect(ended.regularPriceCents).toBe(3400);
  });

  it("reverts at the exact advertised second, like the bonus does", () => {
    const endsAtMs = new Date("2026-09-07T23:59:59-04:00").getTime();
    expect(resolveDealOffer(onSale(2550), new Date(endsAtMs - 1000), 0).unitPriceCents).toBe(2550);
    expect(resolveDealOffer(onSale(2550), new Date(endsAtMs), 0).unitPriceCents).toBe(3400);
  });

  it("also ends on a sold-out allocation", () => {
    const deal = withOffer({
      bonusItems: [],
      label: "25% off flash sale",
      salePriceCents: 2550,
      allocation: 200,
    });
    expect(resolveDealOffer(deal, during, 199).unitPriceCents).toBe(2550);
    expect(resolveDealOffer(deal, during, 200).unitPriceCents).toBe(3400);
  });

  it("throws on a zero, negative, fractional or MARK-UP sale price", () => {
    // This number lands on a Square order line — fail at the typo, never at
    // the charge.
    for (const bad of [0, -100, 25.5, 3400, 3900]) {
      expect(() => resolveDealOffer(onSale(bad), during, 0)).toThrow(/salePriceCents/);
    }
  });

  it("reports regular == unit when nothing is discounted", () => {
    const o = resolveDealOffer(noOfferDeal, during, 0);
    expect(o.regularPriceCents).toBe(o.unitPriceCents);
  });
});

describe("the deadline boundary", () => {
  const deal = fiftyTokens();
  // 23:59:59 on 7 Sep is EDT, so -04:00.
  const endsAtMs = new Date("2026-09-07T23:59:59-04:00").getTime();

  it("still grants the bonus one second before the end", () => {
    const o = resolveDealOffer(deal, new Date(endsAtMs - 1000), 0);
    expect(o.isOfferLive).toBe(true);
    expect(o.bonusItems).toEqual([BONUS_50]);
  });

  it("stops AT the advertised end, not after it", () => {
    const o = resolveDealOffer(deal, new Date(endsAtMs), 0);
    expect(o.isOfferLive).toBe(false);
    expect(o.bonusItems).toEqual([]);
  });

  it("still reports the deadline after it passes, so the UI can say it ended", () => {
    const o = resolveDealOffer(deal, new Date(endsAtMs + 1000), 0);
    expect(o.endsAt).toBe("2026-09-07T23:59:59-04:00");
    expect(o.isOfferLive).toBe(false);
  });
});

describe("the allocation boundary", () => {
  const deal = fiftyTokens({ allocation: 200 });
  const now = new Date("2026-09-01T12:00:00-04:00");

  it("grants the bonus on the last pack of the allocation", () => {
    const o = resolveDealOffer(deal, now, 199);
    expect(o.isOfferLive).toBe(true);
    expect(o.remaining).toBe(1);
  });

  it("stops once the allocation is exactly met", () => {
    const o = resolveDealOffer(deal, now, 200);
    expect(o.isOfferLive).toBe(false);
    expect(o.remaining).toBe(0);
  });

  it("clamps remaining at zero when concurrent buyers oversold it", () => {
    // Two buyers both saw "1 left" and both bought two. We do not decline a card
    // to defend a counter — the number just floors at zero.
    const o = resolveDealOffer(deal, now, 203);
    expect(o.remaining).toBe(0);
    expect(o.packsSold).toBe(203);
  });

  it("leaves remaining null when the offer is time-limited only", () => {
    const o = resolveDealOffer(fiftyTokens(), now, 5_000);
    expect(o.remaining).toBeNull();
    expect(o.isOfferLive).toBe(true);
  });
});

describe("whichever limit lands first ends the offer", () => {
  const deal = fiftyTokens({ allocation: 200 });

  it("ends on the allocation while the deadline is still days away", () => {
    expect(resolveDealOffer(deal, new Date("2026-09-01T12:00:00-04:00"), 200).isOfferLive).toBe(
      false,
    );
  });

  it("ends on the deadline while packs are still allocated", () => {
    const o = resolveDealOffer(deal, new Date("2026-09-08T12:00:00-04:00"), 3);
    expect(o.isOfferLive).toBe(false);
    expect(o.remaining).toBe(197);
  });

  it("runs while both limits are unmet", () => {
    const o = resolveDealOffer(deal, new Date("2026-09-01T12:00:00-04:00"), 3);
    expect(o.isOfferLive).toBe(true);
  });
});

describe("bonus denominations", () => {
  it("any Game Zone bonus must be on BOTH allowlists", () => {
    // The trap this repo has already been bitten by: the MINT validates against
    // NATIVE_GRANT_DENOMINATIONS and throws loudly, but the LOAD path re-derives
    // through COMP_TOKEN_DENOMINATIONS and an unrecognised value credits NOTHING
    // with no error at all. 50 has to be on both for the bonus to be real.
    expect([...NATIVE_GRANT_DENOMINATIONS]).toContain(50);
    expect([...COMP_TOKEN_DENOMINATIONS]).toContain(50);
    expect([...NATIVE_GRANT_DENOMINATIONS]).toEqual([...COMP_TOKEN_DENOMINATIONS]);
  });

  it("holds for every denomination a shipped offer actually uses", () => {
    for (const deal of DEAL_CATALOG) {
      for (const item of deal.limitedOffer?.bonusItems ?? []) {
        if (item.kind !== "gamezone") continue;
        const tokens = item.tokens + item.bonusTokens;
        expect([...NATIVE_GRANT_DENOMINATIONS]).toContain(tokens);
        expect([...COMP_TOKEN_DENOMINATIONS]).toContain(tokens);
      }
    }
  });
});

describe("dealOfferEndsAt — the DST trap", () => {
  it("uses EDT for a summer deadline and EST for a winter one", () => {
    expect(dealOfferEndsAt("2026-08-31T23:59:59")).toBe("2026-08-31T23:59:59-04:00");
    expect(dealOfferEndsAt("2026-01-31T23:59:59")).toBe("2026-01-31T23:59:59-05:00");
  });

  it("keeps 11:59 PM on the advertised DAY in both halves of the year", () => {
    // The bug this guards: a hardcoded -05:00 makes an August 23:59:59 land at
    // 00:59:59 on the FOLLOWING day in America/New_York, so an offer advertised
    // as ending Monday night quietly runs an hour into Tuesday.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
    expect(fmt.format(new Date(dealOfferEndsAt("2026-08-31T23:59:59")))).toBe("8/31, 23:59");
    expect(fmt.format(new Date(dealOfferEndsAt("2026-01-31T23:59:59")))).toBe("1/31, 23:59");
  });

  it("throws on a malformed deadline rather than running the offer forever", () => {
    expect(() => dealOfferEndsAt("2026-09-07")).toThrow(/wall-clock/);
    expect(() => dealOfferEndsAt("2026-09-07T23:59:59Z")).toThrow(/wall-clock/);
    expect(() => dealOfferEndsAt("2026-09-07T23:59:59-04:00")).toThrow(/wall-clock/);
  });

  it("is reached through resolveDealOffer, so a bad deadline cannot ship quietly", () => {
    expect(() => resolveDealOffer(fiftyTokens({ endsAt: "next Sunday" }), new Date(), 0)).toThrow(
      /wall-clock/,
    );
  });
});
