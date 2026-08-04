import { describe, expect, it } from "vitest";
import { DEAL_CATALOG, DEAL_LOCATIONS, getDeal } from "../catalog";
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

describe("legPaidCents", () => {
  it.each(
    DEAL_CATALOG.flatMap((d) => DEAL_LOCATIONS.map((loc) => [d.slug, d, loc] as const)),
  )("%s at %s sums EXACTLY to the pack price", (_slug, deal, location) => {
    // No cent may be created or lost by the pro-rata split, at any location.
    const legs = legPaidCents(deal, location);
    expect(legs).toHaveLength(deal.items.length);
    expect(legs.reduce((a, b) => a + b, 0)).toBe(deal.priceCents);
  });

  it("does NOT split evenly when the legs are worth different amounts", () => {
    // The gel pack is [gel, gel, gz150, gz150]: a battle is $12 à la carte and
    // 150 tokens is $15, so an even split would understate how much of the pack
    // a guest who burned both token legs had actually used — and refund them too
    // generously by real money.
    const [gel1, , tokens1] = legPaidCents(GEL, "headpinz");
    expect(tokens1).toBeGreaterThan(gel1);
    expect(gel1).not.toBe(Math.round(GEL.priceCents / 4));
  });

  it("does split evenly when the catalog says the legs ARE equal", () => {
    // Laser tag and 100 tokens are both $10 at HeadPinz, so the laser pack's
    // four legs really are worth the same. Pinned so a future price change shows
    // up here as a deliberate decision rather than a surprise.
    const legs = legPaidCents(LASER, "headpinz");
    expect(new Set(legs).size).toBe(1);
    expect(legs[0]).toBe(LASER.priceCents / 4);
  });

  it("throws loudly for an attraction with no price at that location", () => {
    const broken = { ...LASER, items: [{ kind: "attraction", slug: "nope", qty: 1 }] } as never;
    expect(() => legPaidCents(broken, "headpinz")).toThrow(/no nope product/);
  });

  it("throws for a leg kind it cannot weight rather than scoring it zero", () => {
    const broken = { ...LASER, items: [{ kind: "race", qty: 1 }] } as never;
    expect(() => legPaidCents(broken, "headpinz")).toThrow(/cannot weight/);
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
    const states = packStates({ ...base, spentByCode: spent("HPWAAA", [5]) });
    expect(states[0].fullyUnspent).toBe(true);
    expect(states[1].fullyUnspent).toBe(false);
    expect(states[1].spentSlots).toEqual([1]);
    expect(states[2].fullyUnspent).toBe(true);
  });

  it("values a partly-used pack at what is actually left", () => {
    const legs = legPaidCents(LASER, "headpinz");
    const states = packStates({ ...base, spentByCode: spent("HPWAAA", [0]) });
    expect(states[0].spentCents).toBe(legs[0]);
    expect(states[0].unspentCents).toBe(LASER.priceCents - legs[0]);
  });

  it("marks a fully-consumed pack as worth nothing", () => {
    const states = packStates({ ...base, spentByCode: spent("HPWAAA", [0, 1, 2, 3]) });
    expect(states[0].spentCents).toBe(LASER.priceCents);
    expect(states[0].unspentCents).toBe(0);
  });

  it("keeps split purchases independent per code", () => {
    const states = packStates({
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
    const states = packStates({ ...base, spentByCode: new Map(), refundedPackIndexes: [0] });
    expect(states[0].alreadyRefunded).toBe(true);
    expect(states[1].alreadyRefunded).toBe(false);
  });

  it("gives each pack a unit key unique across both shapes", () => {
    const combined = packStates({ ...base, spentByCode: new Map() });
    expect(new Set(combined.map((s) => s.unitKey)).size).toBe(3);
  });
});

describe("choosePacksToRefund", () => {
  const states = (spentByCode: Map<string, Set<number>>, refunded?: number[]) =>
    packStates({
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
    const states = packStates({
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
    const states = packStates({
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
  const states = packStates({
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
