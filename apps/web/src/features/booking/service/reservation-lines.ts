/**
 * Guest food selections → Neon reservation lines.
 *
 * ONE implementation, deliberately, because having two is what caused the bug
 * this file exists to prevent.
 *
 * The $0 pass-through items (Pizza Bowl pizza + soda pitcher, carrying the
 * guest's topping and drink choices as notes) are guest-provided data. Per the
 * standing rule, anything a guest gives us that we forward to Square / QAMF /
 * BMI must ALSO be written to our own DB at capture — our DB is the source of
 * truth, the external order is a downstream sync.
 *
 * History: on 2026-06-21 the toppings and soda were sent only to the Square
 * order and never stored in Neon; when they failed to attach, the data was
 * unrecoverable. The bowling-only rail (`app/api/bowling/v2/reserve`) was fixed
 * then. The UNIFIED rail was not — so a MIXED cart (bowling plus a race,
 * attraction or game-card leg, which is the ordinary kiosk shape) still lost
 * them. Both rails now call this.
 *
 * Safety properties the callers rely on:
 *   - `unitPriceCents` is 0, and pricing is computed from the product/Square
 *     line items, never from these rows — so they move no total.
 *   - No `squareProductId`, so the product-backed day-of order map skips them
 *     and they are never double-added to the Square order.
 */
import type { ReservationLine } from "@/lib/bowling-db";

/** The `$0` pass-through shape carried on a bowling/KBF cart item. */
export interface RawFoodItem {
  catalogObjectId: string;
  name: string;
  quantity: number;
  /** Guest's choices, e.g. "Lane 1: Pepperoni" or "Lane 2: Coke". */
  note?: string;
}

/**
 * Render the guest's $0 food picks as reservation lines.
 *
 * The label folds the note in ("Pizza Bowl Pizza — Lane 1: Pepperoni") because
 * `bowling_reservation_lines` has no note column; that string is what the admin
 * board and the recovery path read back.
 */
export function rawFoodItemsToReservationLines(
  rawItems: readonly RawFoodItem[] | null | undefined,
): ReservationLine[] {
  return (rawItems ?? []).map((ri) => ({
    label: ri.note ? `${ri.name} — ${ri.note}` : ri.name,
    quantity: ri.quantity,
    unitPriceCents: 0,
  }));
}
