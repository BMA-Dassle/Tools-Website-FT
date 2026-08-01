/**
 * Live-repro (owner smoke 2026-07-31): a kiosk gel-blaster cart fully covered
 * by a V2 voucher leg must price to a $0 deposit — the preview instead built
 * a PAID order ("Card or gift card required"). This test feeds the server
 * pricing builder the exact session shape the kiosk posts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import { buildCombinedLineItems } from "./unified-reserve";
import { emptySession, newItem, type AttractionItem, type BookingSession } from "../state/types";

function kioskGelSession(vouchers: unknown[]): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    context: { kiosk: true },
    items: [
      {
        ...(newItem("attraction") as AttractionItem),
        id: "a1",
        slug: "gel-blaster",
        date: "2026-07-31",
        slot: "2026-07-31T01:15:00",
        qty: 1,
        productId: "8976680",
        price: 12,
        bmiLineId: "63000000000000001",
      } as AttractionItem,
    ],
    appliedVouchers: vouchers,
  } as BookingSession;
}

const LEGS = [
  { code: "HPWZ96RZ4SX", issuer: "native", itemIndex: 1, name: "Laser Tag / Gel Blaster comp" },
  { code: "HPWZ96RZ4SX", issuer: "native", itemIndex: 3, name: "Laser Tag / Gel Blaster comp" },
  { code: "HPWZ96RZ4SX", issuer: "native", itemIndex: 4, name: "Shuffly comp" },
];

describe("unified pricing — voucher-covered kiosk attraction cart", () => {
  it("prices the fully-covered gel line at $0 (a $0 line, not a paid one)", () => {
    const { sqLineItems } = buildCombinedLineItems(kioskGelSession(LEGS));
    expect(sqLineItems).toHaveLength(1);
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(0);
    expect(sqLineItems[0].quantity).toBe("1");
  });

  it("uncovered without vouchers: full price (control)", () => {
    const { sqLineItems } = buildCombinedLineItems(kioskGelSession([]));
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(1200);
  });
});

import { quoteUnifiedSession } from "./unified-reserve";

/** PR A parity (tasks/server-quote-pricing-plan.md): the PricedLine mirror
 *  must carry the same money as the Square lines, with covered units as
 *  their own tagged $0 lines. */
describe("quoteUnifiedSession — server quote mirror", () => {
  it("fully covered gel: $0 subtotal + $0 tax + a voucher-tagged $0 line", () => {
    const q = quoteUnifiedSession(kioskGelSession(LEGS));
    expect(q.subtotalCents).toBe(0);
    expect(q.taxCents).toBe(0);
    expect(q.totalCents).toBe(0);
    const covered = q.lines.find((l) => l.coverage?.kind === "voucher");
    expect(covered).toMatchObject({ quantity: 1, unitCents: 0 });
  });

  it("uncovered gel: charged line, 6.5% tax on the charged subtotal", () => {
    const q = quoteUnifiedSession(kioskGelSession([]));
    expect(q.subtotalCents).toBe(1200);
    expect(q.taxCents).toBe(78); // FL 6.5%
    expect(q.totalCents).toBe(1278);
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]).toMatchObject({ unitCents: 1200, quantity: 1 });
    expect(q.lines[0].coverage).toBeUndefined();
  });

  it("partial coverage (qty 2, one covered): one charged unit + one $0 voucher line", () => {
    const s = kioskGelSession([LEGS[0]]);
    (s.items[0] as { qty: number }).qty = 2;
    const q = quoteUnifiedSession(s);
    expect(q.subtotalCents).toBe(1200); // one unit charged
    const charged = q.lines.find((l) => !l.coverage);
    const covered = q.lines.find((l) => l.coverage?.kind === "voucher");
    expect(charged).toMatchObject({ quantity: 1, unitCents: 1200 });
    expect(covered).toMatchObject({ quantity: 1, unitCents: 0 });
  });

  it("covered line carries the covering CODE's tail and a pretty name (PR B labels)", () => {
    const q = quoteUnifiedSession(kioskGelSession(LEGS));
    const covered = q.lines.find((l) => l.coverage?.kind === "voucher");
    expect(covered?.coverage?.label).toBe("Voucher …Z4SX");
    expect(covered?.name).toBe("Gel Blaster");
  });

  it("mirror parity: priced-line money always equals the Square-line money", () => {
    for (const vouchers of [[], LEGS, [LEGS[0]]]) {
      const s = kioskGelSession(vouchers);
      const { sqLineItems, pricedLines, totalPriceCents } = buildCombinedLineItems(s);
      const sqCents = sqLineItems.reduce(
        (sum, l) => sum + (l.basePriceMoney?.amount ?? 0) * Number(l.quantity),
        0,
      );
      const quoteCents = pricedLines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
      expect(quoteCents).toBe(sqCents);
      expect(quoteCents).toBe(totalPriceCents);
    }
  });
});

import { overviewFromServerQuote } from "./server-quote";
import type { BillOverview } from "./checkout";

/** PR B: the review's BillOverview built FROM the quote — line sum === the
 *  quoted subtotal, coverage tags survive, and the untaxed Game Zone card
 *  lines from the client base layer back on top without double-counting. */
describe("overviewFromServerQuote — review mapping", () => {
  const emptyBase: BillOverview = {
    lines: [],
    subtotal: 0,
    tax: 0,
    total: 0,
    cashOwed: 0,
    creditApplied: 0,
    isCreditOrder: false,
  };

  it("fully covered gel: $0 credit order with a tagged $0 line", () => {
    const s = kioskGelSession(LEGS);
    const o = overviewFromServerQuote(quoteUnifiedSession(s), s, emptyBase);
    expect(o.total).toBe(0);
    expect(o.tax).toBe(0);
    expect(o.isCreditOrder).toBe(true);
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0]).toMatchObject({ amount: 0, coverageLabel: "Voucher …Z4SX" });
  });

  it("uncovered gel: line sum === subtotal, total carries the 6.5% tax", () => {
    const s = kioskGelSession([]);
    const o = overviewFromServerQuote(quoteUnifiedSession(s), s, emptyBase);
    expect(o.subtotal).toBe(12);
    expect(o.lines.reduce((sum, l) => sum + l.amount, 0)).toBe(o.subtotal);
    expect(o.tax).toBe(0.78);
    expect(o.total).toBe(12.78);
    expect(o.cashOwed).toBe(12.78);
    expect(o.isCreditOrder).toBe(false);
  });

  it("Game Zone card lines from the base ride on top, untaxed", () => {
    const s = kioskGelSession([]);
    const base: BillOverview = {
      ...emptyBase,
      lines: [{ name: "Game Zone — $25 Card", quantity: 1, amount: 25 }],
    };
    const o = overviewFromServerQuote(quoteUnifiedSession(s), s, base);
    expect(o.tax).toBe(0.78); // tax unchanged — cards are untaxed
    expect(o.total).toBe(37.78);
    expect(o.lines.some((l) => l.name === "Game Zone — $25 Card")).toBe(true);
  });
});
