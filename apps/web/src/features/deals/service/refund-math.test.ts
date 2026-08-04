import { describe, expect, it } from "vitest";
import { DEAL_CATALOG, DEAL_LOCATIONS, dealVoucherItems, getDeal } from "../catalog";
import {
  allowanceConsumed,
  choosePacksToRefund,
  legPaidCents,
  packStates,
  selectPacksByUnitKey,
  spentWarning,
} from "./refund-math";

const LASER = getDeal("laser-tag-game-card-pack")!;
const GEL = getDeal("gel-blaster-game-card-pack")!;

const spent = (code: string, indexes: number[]) => new Map([[code, new Set(indexes)]]);

/**
 * `legPaidCents` for a catalog deal at its catalog price.
 *
 * The real callers pass the items AS SOLD (base plus any frozen offer bonus) and
 * the price ACTUALLY PAID, because both are purchase-specific now. These helpers
 * keep the catalog cases readable while the bonus-item cases below pass their own.
 */
const legsFor = (deal: typeof LASER, location: Parameters<typeof legPaidCents>[0]["location"]) =>
  legPaidCents({
    items: deal.items,
    location,
    pricePaidCents: deal.priceCents,
    dealSlug: deal.slug,
  });

const statesFor = (args: {
  deal: typeof LASER;
  location: "headpinz" | "naples";
  combine: boolean;
  qty: number;
  codes: string[];
  spentByCode: Map<string, Set<number>>;
  refundedPackIndexes?: number[];
  bonusItems?: Parameters<typeof dealVoucherItems>[2];
  pricePaidCents?: number;
}) =>
  packStates({
    items: dealVoucherItems(args.deal, 1, args.bonusItems ?? []),
    location: args.location,
    pricePaidCents: args.pricePaidCents ?? args.deal.priceCents,
    dealSlug: args.deal.slug,
    combine: args.combine,
    qty: args.qty,
    codes: args.codes,
    spentByCode: args.spentByCode,
    refundedPackIndexes: args.refundedPackIndexes,
  });

describe("legPaidCents", () => {
  it.each(
    DEAL_CATALOG.flatMap((d) => DEAL_LOCATIONS.map((loc) => [d.slug, d, loc] as const)),
  )("%s at %s sums EXACTLY to the pack price", (_slug, deal, location) => {
    // No cent may be created or lost by the pro-rata split, at any location.
    const legs = legsFor(deal, location);
    expect(legs).toHaveLength(deal.items.length);
    expect(legs.reduce((a, b) => a + b, 0)).toBe(deal.priceCents);
  });

  it("does NOT split evenly when the legs are worth different amounts", () => {
    // The gel pack is [gel, gel, gz150, gz150]: a battle is $12 à la carte and
    // 150 tokens is $15, so an even split would understate how much of the pack
    // a guest who burned both token legs had actually used — and refund them too
    // generously by real money.
    const [gel1, , tokens1] = legsFor(GEL, "headpinz");
    expect(tokens1).toBeGreaterThan(gel1);
    expect(gel1).not.toBe(Math.round(GEL.priceCents / 4));
  });

  it("does split evenly when the catalog says the legs ARE equal", () => {
    // Laser tag and 100 tokens are both $10 at HeadPinz, so the laser pack's
    // four legs really are worth the same. Pinned so a future price change shows
    // up here as a deliberate decision rather than a surprise.
    const legs = legsFor(LASER, "headpinz");
    expect(new Set(legs).size).toBe(1);
    expect(legs[0]).toBe(LASER.priceCents / 4);
  });

  it("throws loudly for an attraction with no price at that location", () => {
    const broken = { ...LASER, items: [{ kind: "attraction", slug: "nope", qty: 1 }] } as never;
    expect(() => legsFor(broken, "headpinz")).toThrow(/no nope product/);
  });

  it("throws for a leg kind it cannot weight rather than scoring it zero", () => {
    const broken = { ...LASER, items: [{ kind: "race", qty: 1 }] } as never;
    expect(() => legsFor(broken, "headpinz")).toThrow(/cannot weight/);
  });
});

describe("packStates", () => {
  const base = {
    deal: LASER,
    location: "headpinz" as const,
    combine: true,
    qty: 3,
    codes: ["HPWAAA"],
  };

  it("attributes a spent leg to the RIGHT pack", () => {
    // Leg 5 is pack 1, slot 1. Pack 0 must stay untouched — the whole reason the
    // pack↔leg mapping exists.
    const states = statesFor({ ...base, spentByCode: spent("HPWAAA", [5]) });
    expect(states[0].fullyUnspent).toBe(true);
    expect(states[1].fullyUnspent).toBe(false);
    expect(states[1].spentSlots).toEqual([1]);
    expect(states[2].fullyUnspent).toBe(true);
  });

  it("values a partly-used pack at what is actually left", () => {
    const legs = legsFor(LASER, "headpinz");
    const states = statesFor({ ...base, spentByCode: spent("HPWAAA", [0]) });
    expect(states[0].spentCents).toBe(legs[0]);
    expect(states[0].unspentCents).toBe(LASER.priceCents - legs[0]);
  });

  it("marks a fully-consumed pack as worth nothing", () => {
    const states = statesFor({ ...base, spentByCode: spent("HPWAAA", [0, 1, 2, 3]) });
    expect(states[0].spentCents).toBe(LASER.priceCents);
    expect(states[0].unspentCents).toBe(0);
  });

  it("keeps split purchases independent per code", () => {
    const states = statesFor({
      deal: LASER,
      location: "headpinz",
      combine: false,
      qty: 3,
      codes: ["A", "B", "C"],
      spentByCode: new Map([["B", new Set([1])]]),
    });
    expect(states[0].fullyUnspent).toBe(true);
    expect(states[1].fullyUnspent).toBe(false);
    expect(states[2].fullyUnspent).toBe(true);
  });

  it("flags packs an earlier refund already took", () => {
    const states = statesFor({ ...base, spentByCode: new Map(), refundedPackIndexes: [0] });
    expect(states[0].alreadyRefunded).toBe(true);
    expect(states[1].alreadyRefunded).toBe(false);
  });

  it("gives each pack a unit key unique across both shapes", () => {
    const combined = statesFor({ ...base, spentByCode: new Map() });
    expect(new Set(combined.map((s) => s.unitKey)).size).toBe(3);
  });
});

describe("choosePacksToRefund", () => {
  const states = (spentByCode: Map<string, Set<number>>, refunded?: number[]) =>
    statesFor({
      deal: LASER,
      location: "headpinz",
      combine: true,
      qty: 3,
      codes: ["HPWAAA"],
      spentByCode,
      refundedPackIndexes: refunded,
    });

  it("prefers untouched packs, in order", () => {
    const sel = choosePacksToRefund(states(spent("HPWAAA", [0])), 2);
    expect(sel.packIndexes).toEqual([1, 2]);
    expect(sel.spentValueIncludedCents).toBe(0);
    expect(sel.needsOverride).toBe(false);
  });

  it("reaches into used packs only when asked for more, and demands an override", () => {
    const sel = choosePacksToRefund(states(spent("HPWAAA", [0])), 3);
    expect(sel.packIndexes).toEqual([1, 2, 0]);
    expect(sel.spentValueIncludedCents).toBeGreaterThan(0);
    expect(sel.needsOverride).toBe(true);
  });

  it("accepts the override once it is explicit", () => {
    expect(choosePacksToRefund(states(spent("HPWAAA", [0])), 3, true).needsOverride).toBe(false);
  });

  it("takes the LEAST-used pack first when it has to reach", () => {
    // Pack 0 has 2 legs gone, pack 1 has 1. Refunding one dirty pack should give
    // away the smaller amount.
    const sel = choosePacksToRefund(states(new Map([["HPWAAA", new Set([0, 1, 4])]])), 2);
    expect(sel.packIndexes[0]).toBe(2); // the clean one
    expect(sel.packIndexes[1]).toBe(1); // then the least-spent dirty one
  });

  it("never offers a pack an earlier refund already took", () => {
    const sel = choosePacksToRefund(states(new Map(), [0]), 5);
    expect(sel.packIndexes).toEqual([1, 2]);
    expect(sel.refundablePacks).toBe(2);
  });

  it("reports the default selection size as the untouched-pack count", () => {
    const sel = choosePacksToRefund(states(spent("HPWAAA", [4])), 0);
    expect(sel.fullyUnspentPacks).toBe(2);
    expect(sel.packIndexes).toEqual([]);
  });
});

describe("selectPacksByUnitKey", () => {
  it("resolves an explicit selection and ignores keys it does not know", () => {
    const states = statesFor({
      deal: LASER,
      location: "headpinz",
      combine: true,
      qty: 3,
      codes: ["HPWAAA"],
      spentByCode: new Map(),
    });
    const picked = selectPacksByUnitKey(states, [states[2].unitKey, "made-up-key"]);
    expect(picked.map((s) => s.pack)).toEqual([2]);
  });

  it("refuses to re-select an already-refunded pack even if asked by key", () => {
    const states = statesFor({
      deal: LASER,
      location: "headpinz",
      combine: true,
      qty: 2,
      codes: ["HPWAAA"],
      spentByCode: new Map(),
      refundedPackIndexes: [0],
    });
    expect(selectPacksByUnitKey(states, [states[0].unitKey])).toEqual([]);
  });
});

describe("allowanceConsumed", () => {
  it("gives back exactly the packs a partial refund returned", () => {
    expect(allowanceConsumed({ qty: 3, refundedPacks: 1, vouchersVoidedAt: null })).toBe(2);
  });

  it("consumes nothing once the row is voided", () => {
    expect(allowanceConsumed({ qty: 3, refundedPacks: 0, vouchersVoidedAt: "2026-08-03" })).toBe(0);
  });

  it("never returns a negative allowance from bad data", () => {
    expect(allowanceConsumed({ qty: 1, refundedPacks: 5, vouchersVoidedAt: null })).toBe(0);
  });
});

describe("spentWarning", () => {
  const states = statesFor({
    deal: LASER,
    location: "headpinz",
    combine: true,
    qty: 3,
    codes: ["HPWAAA"],
    spentByCode: spent("HPWAAA", [0]),
  });

  it("stays silent when nothing has been used", () => {
    expect(spentWarning([states[1], states[2]], 10863, 2)).toBeNull();
  });

  it("names the packs, the items and the money when it has to warn", () => {
    const warning = spentWarning([states[0]], 10863, 1)!;
    expect(warning).toMatch(/already been partly used/);
    expect(warning).toMatch(/\$\d+\.\d{2} of the \$108\.63 paid/);
  });
});

describe("limited-offer bonus items", () => {
  // A limited offer appends bonus items to every pack and freezes them on the
  // row. That changes LEGS PER PACK, so anything deriving the leg count from
  // `deal.items.length` mis-attributes every leg of an offer purchase — the exact
  // class of bug the pack mapping exists to prevent.
  const BONUS = [{ kind: "gamezone", tokens: 0, bonusTokens: 50, bonusCashDollars: 0 }] as const;

  it("gives a pack MORE legs when the offer added a bonus", () => {
    const plain = statesFor({
      deal: LASER,
      location: "headpinz",
      combine: true,
      qty: 2,
      codes: ["HPWAAA"],
      spentByCode: new Map(),
    });
    const withBonus = statesFor({
      deal: LASER,
      location: "headpinz",
      combine: true,
      qty: 2,
      codes: ["HPWAAA"],
      spentByCode: new Map(),
      bonusItems: BONUS as never,
    });
    expect(plain[0].legIndexes).toHaveLength(4);
    expect(withBonus[0].legIndexes).toHaveLength(5);
  });

  it("maps pack 1 to legs 5-9, not 4-7, once a bonus leg exists", () => {
    // The concrete mis-attribution: with 5 legs per pack, leg 5 belongs to pack 1
    // slot 0. Assuming 4 would have called it pack 1 slot 1 and left pack 0
    // looking untouched when it was not.
    const states = statesFor({
      deal: LASER,
      location: "headpinz",
      combine: true,
      qty: 2,
      codes: ["HPWAAA"],
      spentByCode: spent("HPWAAA", [4]),
      bonusItems: BONUS as never,
    });
    expect(states[0].legIndexes).toEqual([0, 1, 2, 3, 4]);
    expect(states[1].legIndexes).toEqual([5, 6, 7, 8, 9]);
    // Leg 4 is the BONUS leg of pack 0 — so pack 0 is dirty and pack 1 is clean.
    expect(states[0].fullyUnspent).toBe(false);
    expect(states[1].fullyUnspent).toBe(true);
  });

  it("still sums a pack's legs exactly to the price paid, bonus included", () => {
    // The bonus was free, but it is consumable value the guest received, so it
    // shares the pro-rata basis. What must not change is the total.
    const legs = legPaidCents({
      items: dealVoucherItems(LASER, 1, BONUS as never),
      location: "headpinz",
      pricePaidCents: 2900,
      dealSlug: LASER.slug,
    });
    expect(legs).toHaveLength(5);
    expect(legs.reduce((a, b) => a + b, 0)).toBe(2900);
  });

  it("prices legs off what was PAID, not today's catalog price", () => {
    // Deal pricing is dynamic. Quoting a historical sale at the current price
    // would refund the wrong amount in whichever direction the price has moved.
    const atOfferPrice = statesFor({
      deal: LASER,
      location: "headpinz",
      combine: true,
      qty: 1,
      codes: ["HPWAAA"],
      spentByCode: new Map(),
      pricePaidCents: 2900,
    });
    expect(atOfferPrice[0].unspentCents).toBe(2900);
    expect(atOfferPrice[0].unspentCents).not.toBe(LASER.priceCents);
  });
});
