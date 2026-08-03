import { describe, expect, it } from "vitest";
import { COMP_TOKEN_DENOMINATIONS } from "~/features/game-cards/vouchers/grants";
import { NATIVE_GRANT_DENOMINATIONS } from "~/features/game-cards/service/native-voucher";
import { DEAL_CATALOG, getDeal, type DealCatalogEntry } from "../catalog";
import { dealNeedsSoldCount, dealOfferEndsAt, resolveDealOffer } from "./offer";

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

describe("the shipped flash sale", () => {
  it("carries a real deadline on every deal that runs it", () => {
    // An offer with no limit is not an offer, it is the pack. The type enforces
    // that one exists; this pins that the SHIPPED one is the deadline kind,
    // because the Naples popup's countdown has nothing to render without it.
    for (const deal of DEAL_CATALOG) {
      if (!deal.limitedOffer) continue;
      expect(deal.limitedOffer.endsAt ?? deal.limitedOffer.allocation).toBeDefined();
      if (deal.limitedOffer.endsAt) {
        expect(() => dealOfferEndsAt(deal.limitedOffer!.endsAt!)).not.toThrow();
      }
    }
  });

  it("describes in its label exactly what its items grant", () => {
    // The label is what every guest-facing surface prints. A label saying "50
    // bonus tokens" beside items granting 100 would be a promise the mint does
    // not keep, and nothing else in the system would catch it.
    for (const deal of DEAL_CATALOG) {
      const offer = deal.limitedOffer;
      if (!offer) continue;
      const tokens = offer.bonusItems
        .filter((i) => i.kind === "gamezone")
        .reduce((n, i) => n + (i.kind === "gamezone" ? i.tokens + i.bonusTokens : 0), 0);
      if (tokens > 0) expect(offer.label).toContain(String(tokens));
    }
  });

  it("never moves the price on any shipped deal", () => {
    for (const deal of DEAL_CATALOG) {
      const during = resolveDealOffer(deal, new Date("2026-08-04T12:00:00-04:00"), 0);
      const after = resolveDealOffer(deal, new Date("2027-01-01T12:00:00-05:00"), 0);
      expect(during.unitPriceCents).toBe(deal.priceCents);
      expect(after.unitPriceCents).toBe(deal.priceCents);
    }
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

describe("the price never moves", () => {
  it("charges the same before, during and after an offer", () => {
    const deal = fiftyTokens({ allocation: 200 });
    const during = resolveDealOffer(deal, new Date("2026-09-01T12:00:00-04:00"), 5);
    const afterDate = resolveDealOffer(deal, new Date("2026-09-09T12:00:00-04:00"), 5);
    const afterSellout = resolveDealOffer(deal, new Date("2026-09-01T12:00:00-04:00"), 200);
    for (const o of [during, afterDate, afterSellout]) {
      expect(o.unitPriceCents).toBe(3400);
    }
    // Only the contents differ.
    expect(during.bonusItems).toHaveLength(1);
    expect(afterDate.bonusItems).toHaveLength(0);
    expect(afterSellout.bonusItems).toHaveLength(0);
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
