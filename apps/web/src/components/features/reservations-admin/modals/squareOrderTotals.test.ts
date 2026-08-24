import { describe, expect, it } from "vitest";

/**
 * The Square Order modal footer must ADD UP. It did not: service charges live in their own
 * array on a Square order, never in `lineItems`, so a footer summed from line items was
 * short by the whole service charge and showed Subtotal + Tax against a bigger Total.
 *
 * Fixtures are the two real group events of 2026-08-18.
 */

import { squareOrderTotals } from "./squareOrderTotals";
import type { SquareLineItem, SquareServiceCharge } from "~/features/reservations-admin/types";

const li = (
  name: string,
  grossCents: number,
  over: Partial<SquareLineItem> = {},
): SquareLineItem => ({
  uid: `u-${name}`,
  name,
  quantity: 1,
  note: null,
  priceCents: grossCents,
  grossCents,
  taxCents: 0,
  discountCents: 0,
  totalCents: grossCents,
  catalogId: null,
  ...over,
});

const sc = (name: string, amountCents: number): SquareServiceCharge => ({
  uid: `sc-${name}`,
  name,
  amountCents,
  taxCents: 0,
  taxable: true,
});

/** H3134 Worthington Country Club: $1,793.00 + $268.95 svc + $134.03 tax = $2,195.98 */
const H3134_ITEMS = [
  li("VIP GF Mon-Thu 2hr", 114400),
  li('G/F 16" Pizza Meat Lovers', 4800),
  li('G/F 16" Pizza Pepperoni', 4000),
  li('G/F 16" Pizza Cheese', 3600),
  li("Nemos Wings", 52500),
];
const H3134_SC = [sc("GF Service Charge - 15%", 26895)];
const H3134_META = {
  totalCents: 219598,
  taxCents: 13403,
  discountCents: 0,
  serviceChargeCents: 26895,
};

describe("squareOrderTotals", () => {
  it("reconciles a group event: subtotal + service charge + tax = total", () => {
    const t = squareOrderTotals(H3134_ITEMS, H3134_SC, H3134_META);
    expect(t.subtotalCents).toBe(179300);
    expect(t.serviceChargeCents).toBe(26895);
    expect(t.taxCents).toBe(13403);
    expect(t.totalCents).toBe(219598);
    expect(t.reconciles).toBe(true);
  });

  it("does NOT reconcile when the service charge is ignored — the original bug", () => {
    // What the footer used to compute: line items + tax, service charge nowhere.
    const withoutSc = squareOrderTotals(H3134_ITEMS, [], {
      ...H3134_META,
      serviceChargeCents: 0,
    });
    expect(withoutSc.reconciles).toBe(false);
    // Short by exactly the service charge.
    expect(
      withoutSc.totalCents -
        (withoutSc.subtotalCents + withoutSc.serviceChargeCents + withoutSc.taxCents),
    ).toBe(26895);
  });

  it("falls back to summing the service-charge array when the order-level figure is absent", () => {
    const t = squareOrderTotals(H3134_ITEMS, H3134_SC, null);
    expect(t.serviceChargeCents).toBe(26895);
    // With no meta the total is derived, so it reconciles by construction.
    expect(t.totalCents).toBe(179300 + 26895);
    expect(t.reconciles).toBe(true);
  });

  it("sums multiple service charges — a contract can carry more than one", () => {
    const t = squareOrderTotals(
      [li("Duckpin", 24000)],
      [sc("GF Service Charge - 15% A", 15982), sc("GF Service Charge - 15% B", 15982)],
      null,
    );
    expect(t.serviceChargeCents).toBe(31964);
  });

  it("prefers Square's order-level totals over anything summed per line", () => {
    const items = [li("Thing", 10000, { taxCents: 999, discountCents: 111 })];
    const t = squareOrderTotals(items, [], {
      totalCents: 10650,
      taxCents: 650,
      discountCents: 0,
      serviceChargeCents: 0,
    });
    expect(t.taxCents).toBe(650);
    expect(t.discountCents).toBe(0);
    expect(t.reconciles).toBe(true);
  });

  it("still reconciles a plain bowling order with no service charge", () => {
    const t = squareOrderTotals([li("Lane 1hr", 5000)], [], {
      totalCents: 5325,
      taxCents: 325,
      discountCents: 0,
      serviceChargeCents: 0,
    });
    expect(t.serviceChargeCents).toBe(0);
    expect(t.reconciles).toBe(true);
  });

  it("handles a discount without breaking the sum", () => {
    const t = squareOrderTotals([li("Party", 20000)], [sc("Service charge", 3000)], {
      totalCents: 21495,
      taxCents: 1495,
      discountCents: 3000,
      serviceChargeCents: 3000,
    });
    expect(t.reconciles).toBe(true);
  });
});
