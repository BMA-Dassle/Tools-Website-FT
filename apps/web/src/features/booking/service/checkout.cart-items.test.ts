import { describe, expect, it } from "vitest";
import { cartItemsFromOverview, type BillOverview } from "./checkout";
import { emptySession } from "../state/types";

/**
 * The /reserve cart mapping — the last line of defense against a negative
 * base_price_money reaching Square (live 2026-07-31: two gel covers zeroed a
 * kiosk cart; the credit path shipped the negative voucher review lines and
 * Square 400'd the whole booking). Voucher carts are ROUTED to the unified
 * rail now; this guard covers any future misroute.
 */

const session = emptySession({ entryBrand: "fasttrax" });

function overview(lines: BillOverview["lines"], isCreditOrder: boolean): BillOverview {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  return {
    lines,
    subtotal,
    tax: 0,
    total: subtotal,
    cashOwed: subtotal,
    creditApplied: 0,
    isCreditOrder,
    promoCode: null,
  } as BillOverview;
}

const gel = { name: "Nexus Gel Blaster", quantity: 2, amount: 24, bmiProductId: "8976680" };
const negVoucher = { name: "Gel Blaster comp — …Z4SX", quantity: 1, amount: -12 };
const creditLine = { name: "Race (credit)", quantity: 1, amount: 0, bmiProductId: "24960859" };

describe("cartItemsFromOverview", () => {
  it("maps positive lines with per-unit cents", () => {
    const items = cartItemsFromOverview(session, overview([gel], false));
    expect(items).toEqual([
      { bmiProductId: "8976680", name: "Nexus Gel Blaster", quantity: 2, unitPriceCents: 1200 },
    ]);
  });

  it("NEVER passes a negative line — cash order", () => {
    const items = cartItemsFromOverview(session, overview([gel, negVoucher], false));
    expect(items.map((i) => i.name)).toEqual(["Nexus Gel Blaster"]);
    for (const i of items) expect(i.unitPriceCents).toBeGreaterThanOrEqual(0);
  });

  it("NEVER passes a negative line — $0 credit order (the live failure)", () => {
    const items = cartItemsFromOverview(
      session,
      overview([gel, negVoucher, negVoucher], true),
    );
    expect(items.map((i) => i.name)).toEqual(["Nexus Gel Blaster"]);
    for (const i of items) expect(i.unitPriceCents).toBeGreaterThanOrEqual(0);
  });

  it("keeps $0 credit lines on credit orders (cart must stay non-empty)", () => {
    const items = cartItemsFromOverview(session, overview([creditLine], true));
    expect(items).toEqual([
      { bmiProductId: "24960859", name: "Race (credit)", quantity: 1, unitPriceCents: 0 },
    ]);
  });

  it("drops $0 lines on cash orders (unchanged behavior)", () => {
    const items = cartItemsFromOverview(session, overview([gel, creditLine], false));
    expect(items.map((i) => i.name)).toEqual(["Nexus Gel Blaster"]);
  });
});
