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
