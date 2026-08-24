import type { SquareLineItem, SquareServiceCharge } from "~/features/reservations-admin/types";

/**
 * The money footer for a Square order, as the Square Order modal shows it.
 *
 * Extracted and tested because the thing that goes wrong here is silent: a Square order's
 * SERVICE CHARGES are not line items, so a footer built only from `lineItems` renders
 * `Subtotal + Tax` against a larger `Total` and the gap looks like nothing at all. Group
 * events carry a 12-15% service charge, so the gap was hundreds of dollars per event.
 *
 * The invariant this exists to hold, asserted in the tests:
 *   subtotal + serviceCharge + tax - discount === total
 *
 * Order-level figures from Square win over anything summed from line items — Square's
 * arithmetic is authoritative, and per-line values are absent on some order shapes.
 */
export interface SquareOrderMeta {
  totalCents: number;
  taxCents: number;
  discountCents: number;
  serviceChargeCents: number;
}

export interface SquareOrderTotals {
  subtotalCents: number;
  serviceChargeCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  /** False when the parts do not sum to the total — a display bug worth surfacing. */
  reconciles: boolean;
}

export function squareOrderTotals(
  lineItems: SquareLineItem[],
  serviceCharges: SquareServiceCharge[],
  meta: SquareOrderMeta | null,
): SquareOrderTotals {
  const subtotalCents = lineItems.reduce((s, li) => s + li.grossCents, 0);
  const taxCents = meta?.taxCents ?? lineItems.reduce((s, li) => s + li.taxCents, 0);
  const discountCents = meta?.discountCents ?? lineItems.reduce((s, li) => s + li.discountCents, 0);
  const serviceChargeCents =
    meta?.serviceChargeCents ?? serviceCharges.reduce((s, sc) => s + sc.amountCents, 0);
  const totalCents =
    meta?.totalCents ?? subtotalCents + serviceChargeCents + taxCents - discountCents;

  return {
    subtotalCents,
    serviceChargeCents,
    taxCents,
    discountCents,
    totalCents,
    reconciles: subtotalCents + serviceChargeCents + taxCents - discountCents === totalCents,
  };
}
