import { describe, it, expect } from "vitest";
import {
  formatVoucherExpiry,
  groupVoucherItems,
  voucherItemDisplayLabel,
} from "./display";
import type { VoucherItem } from "../data/vouchers-db";

const gz = (bonusTokens: number): VoucherItem => ({
  kind: "gamezone",
  tokens: 0,
  bonusTokens,
  bonusCashDollars: 0,
});
const attraction = (slug: string, qty = 1): VoucherItem => ({ kind: "attraction", slug, qty });

/** Shape `groupVoucherItems` consumes (a subset of VoucherItemState). */
function entries(items: VoucherItem[], spentIndexes: number[] = []) {
  return items.map((item, index) => ({ item, index, spent: spentIndexes.includes(index) }));
}

describe("voucherItemDisplayLabel", () => {
  it("uses catalog product names, properly cased", () => {
    // Not slug.replace(/-/g," ") — that yields "gel blaster", and these are
    // product names the rest of the site already spells a particular way.
    expect(voucherItemDisplayLabel(attraction("laser-tag"))).toBe("Laser Tag");
    expect(voucherItemDisplayLabel(attraction("gel-blaster"))).toBe("Gel Blasters");
  });

  it("prices game cards in dollars, not tokens", () => {
    // "100 bonus tokens" is Intercard's unit; the buyer paid dollars.
    expect(voucherItemDisplayLabel(gz(100))).toBe("$10 Game Card");
    expect(voucherItemDisplayLabel(gz(150))).toBe("$15 Game Card");
  });

  it("title-cases an unknown slug rather than leaking it raw", () => {
    expect(voucherItemDisplayLabel(attraction("future-thing"))).toBe("Future Thing");
  });

  it("renders a choice leg and a qty>1 leg", () => {
    expect(
      voucherItemDisplayLabel({ kind: "attraction-choice", slugs: ["laser-tag", "gel-blaster"], qty: 1 }),
    ).toBe("Laser Tag or Gel Blasters");
    expect(voucherItemDisplayLabel(attraction("laser-tag", 3))).toBe("3 × Laser Tag");
  });
});

describe("groupVoucherItems", () => {
  it("collapses a combined 3-pack's twelve legs into two rows", () => {
    // The owner's screenshot: a combined voucher listed every leg individually.
    // Same complaint the kiosk receipt already answered by grouping on the label.
    const items = [
      attraction("laser-tag"),
      attraction("laser-tag"),
      gz(100),
      gz(100),
      attraction("laser-tag"),
      attraction("laser-tag"),
      gz(100),
      gz(100),
      attraction("laser-tag"),
      attraction("laser-tag"),
      gz(100),
      gz(100),
    ];
    const groups = groupVoucherItems(entries(items));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ label: "Laser Tag", route: "attraction", total: 6, spent: 0 });
    expect(groups[1]).toMatchObject({
      label: "$10 Game Card",
      route: "gamezone",
      total: 6,
      spent: 0,
    });
    // First-appearance order, indexes ascending.
    expect(groups[0].indexes).toEqual([0, 1, 4, 5, 8, 9]);
    expect(groups[1].indexes).toEqual([2, 3, 6, 7, 10, 11]);
  });

  it("keeps SPENT legs in their own row so a row is never half-used", () => {
    const items = [attraction("laser-tag"), attraction("laser-tag"), attraction("laser-tag")];
    const groups = groupVoucherItems(entries(items, [1]));
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.spent === 0)).toMatchObject({ total: 2 });
    expect(groups.find((g) => g.spent > 0)).toMatchObject({ total: 1, spent: 1 });
  });

  it("does not merge different denominations", () => {
    const groups = groupVoucherItems(entries([gz(100), gz(150), gz(100)]));
    expect(groups.map((g) => [g.label, g.total])).toEqual([
      ["$10 Game Card", 2],
      ["$15 Game Card", 1],
    ]);
  });

  it("routes race legs separately from attractions", () => {
    const groups = groupVoucherItems(
      entries([{ kind: "race", qty: 1 }, attraction("laser-tag")]),
    );
    expect(groups.map((g) => g.route)).toEqual(["race", "attraction"]);
  });

  it("is empty for an empty voucher", () => {
    expect(groupVoucherItems([])).toEqual([]);
  });
});

describe("formatVoucherExpiry", () => {
  it("formats in ET, so the stored end-of-day instant reads as the right day", () => {
    // 2027-08-04T03:59:59Z IS Aug 3 23:59:59 in EDT — the DST-correct instant.
    expect(formatVoucherExpiry("2027-08-03T23:59:59-04:00")).toBe("August 3, 2027");
    expect(formatVoucherExpiry(null)).toBeNull();
  });
});
