import { describe, expect, it } from "vitest";
import { DEAL_CATALOG, dealVoucherItems, getDeal } from "../catalog";
import {
  PackShapeError,
  assertPackShape,
  packLabel,
  packLegMap,
  packOfLeg,
  packUnitKey,
} from "./pack-legs";

const LASER = getDeal("laser-tag-game-card-pack")!;

describe("packLegMap — combined (one code carries every pack)", () => {
  it("splits the flattened legs pack-major", () => {
    const map = packLegMap({ combine: true, qty: 3, codes: ["HPWAAA"], itemsPerPack: 4 });
    expect(map).toEqual([
      { pack: 0, code: "HPWAAA", legIndexes: [0, 1, 2, 3] },
      { pack: 1, code: "HPWAAA", legIndexes: [4, 5, 6, 7] },
      { pack: 2, code: "HPWAAA", legIndexes: [8, 9, 10, 11] },
    ]);
  });

  it("puts leg 5 in pack 1 and NOT pack 0", () => {
    // The mapping exists to prevent exactly this confusion: a guest who redeemed
    // one leg of pack 1 must not make pack 0 look used, and vice versa.
    const map = packLegMap({ combine: true, qty: 3, codes: ["HPWAAA"], itemsPerPack: 4 });
    expect(map[0].legIndexes).not.toContain(5);
    expect(map[1].legIndexes).toContain(5);
  });

  it("covers every leg exactly once, with no gaps", () => {
    const map = packLegMap({ combine: true, qty: 5, codes: ["HPWAAA"], itemsPerPack: 4 });
    const all = map.flatMap((p) => p.legIndexes);
    expect(all).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(new Set(all).size).toBe(20);
  });
});

describe("packLegMap — split (one code per pack)", () => {
  it("gives each pack its own code with slots restarting at zero", () => {
    const map = packLegMap({ combine: false, qty: 3, codes: ["A", "B", "C"], itemsPerPack: 4 });
    expect(map).toEqual([
      { pack: 0, code: "A", legIndexes: [0, 1, 2, 3] },
      { pack: 1, code: "B", legIndexes: [0, 1, 2, 3] },
      { pack: 2, code: "C", legIndexes: [0, 1, 2, 3] },
    ]);
  });
});

describe("packLegMap agrees with what dealVoucherItems actually mints", () => {
  it.each(DEAL_CATALOG.map((d) => [d.slug, d] as const))(
    "%s: a combined 3-pack maps every minted leg",
    (_slug, deal) => {
      // The contract under test: the mapping must describe the SAME array the
      // mint produced. If dealVoucherItems ever stops being pack-major, this is
      // the test that catches it.
      const minted = dealVoucherItems(deal, 3);
      const L = deal.items.length;
      expect(minted).toHaveLength(L * 3);

      const map = packLegMap({ combine: true, qty: 3, codes: ["HPWAAA"], itemsPerPack: L });
      for (const { pack, legIndexes } of map) {
        // Every leg a pack claims must equal the corresponding leg of one pack.
        legIndexes.forEach((legIndex, slot) => {
          expect(minted[legIndex]).toEqual(deal.items[slot]);
          expect(packOfLeg({ combine: true, legIndex, codeIndex: 0, itemsPerPack: L })).toBe(pack);
        });
      }
    },
  );
});

describe("packOfLeg", () => {
  it("derives the pack from the leg index when combined", () => {
    expect(packOfLeg({ combine: true, legIndex: 0, codeIndex: 0, itemsPerPack: 4 })).toBe(0);
    expect(packOfLeg({ combine: true, legIndex: 3, codeIndex: 0, itemsPerPack: 4 })).toBe(0);
    expect(packOfLeg({ combine: true, legIndex: 4, codeIndex: 0, itemsPerPack: 4 })).toBe(1);
    expect(packOfLeg({ combine: true, legIndex: 11, codeIndex: 0, itemsPerPack: 4 })).toBe(2);
  });

  it("derives the pack from the code when split", () => {
    expect(packOfLeg({ combine: false, legIndex: 3, codeIndex: 2, itemsPerPack: 4 })).toBe(2);
  });

  it("refuses a pack with no legs rather than dividing by zero", () => {
    expect(() => packOfLeg({ combine: true, legIndex: 0, codeIndex: 0, itemsPerPack: 0 })).toThrow(
      PackShapeError,
    );
  });
});

describe("assertPackShape", () => {
  it("accepts the two legitimate shapes", () => {
    expect(() => assertPackShape({ combine: true, qty: 3, codes: ["A"] })).not.toThrow();
    expect(() => assertPackShape({ combine: false, qty: 2, codes: ["A", "B"] })).not.toThrow();
  });

  it("refuses a combined purchase carrying more than one code", () => {
    expect(() => assertPackShape({ combine: true, qty: 2, codes: ["A", "B"] })).toThrow(PackShapeError);
  });

  it("refuses a split purchase whose code count does not match qty", () => {
    expect(() => assertPackShape({ combine: false, qty: 3, codes: ["A", "B"] })).toThrow(PackShapeError);
  });

  it("refuses a purchase with no codes at all", () => {
    // A charged-but-unminted row has no legs; callers must handle it before
    // asking which pack owns what.
    expect(() => assertPackShape({ combine: true, qty: 1, codes: [] })).toThrow(PackShapeError);
  });
});

describe("labels and keys", () => {
  it("numbers packs for a human, and stays quiet for a single pack", () => {
    expect(packLabel(0, 3)).toBe("Pack 1 of 3");
    expect(packLabel(2, 3)).toBe("Pack 3 of 3");
    expect(packLabel(0, 1)).toBe("Pack");
  });

  it("keys a unit by code AND pack, since neither alone is unique across shapes", () => {
    // Combined: one code, many packs. Split: many codes, one pack each.
    expect(packUnitKey("HPWAAA", 0)).toBe("HPWAAA#p0");
    expect(packUnitKey("HPWAAA", 1)).not.toBe(packUnitKey("HPWAAA", 0));
    expect(packUnitKey("A", 0)).not.toBe(packUnitKey("B", 0));
  });

  it("uses the real catalog leg count", () => {
    expect(LASER.items).toHaveLength(4);
  });
});
