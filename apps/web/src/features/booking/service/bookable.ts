/**
 * Is a bowling/KBF cart item actually BOOKABLE against QAMF?
 *
 * Pure predicates, no I/O — the last line of defence between the cart and
 * `createReservation`. Born from a real orphan (2026-07-28, FastTrax kiosk): a
 * guest tapped the Duck Pin tile, hit Back on the first step, and booked racing
 * instead. Back-at-step-0 deliberately KEEPS the draft in the cart
 * (KioskFlow.tsx), and duckpin is priced through QAMF/Square rather than the BMI
 * bill — so the untouched leg was $0, invisible in the cart total, and still got
 * handed to QAMF at confirm time as
 *
 *     centerId=11542 holdId=NONE webOfferId=0 optionId=null bookedAt=<now, with ms>
 *
 * QAMF 400'd ("BookedAt: Millisecond must be 0" + a PhoneNumber rule) AFTER the
 * $234.21 was captured, which took the paid RACE booking down with it.
 *
 * Two things make a leg bookable, and it needs one of them:
 *   - a live lane hold (`qamfReservationId`) — the hold already carries the time
 *     and the offer, so confirm attaches the customer and flips the status; or
 *   - a picked slot: BOTH `bookedAt` (which slot) and `webOfferId` (which offer).
 *
 * An item with neither cannot produce a reservation no matter what we send, so
 * the reserve pipeline drops it rather than failing a paid booking over it.
 * Anything that DID reach the vendor or the guest's wallet is never dropped:
 * pricing lives downstream of `webOfferId`, so no-offer means no charge.
 */
import type { BowlingItem, KbfItem } from "../state/types";

/** The subset of BowlingItem/KbfItem that decides bookability. */
export interface BookableFields {
  bookedAt?: string | null;
  webOfferId?: number | null;
  qamfReservationId?: string | null;
}

export type UnbookableReason = "no-slot" | "no-offer" | "no-time";

/**
 * Why this leg can't be booked, or null when it can.
 *
 * - `no-slot`  — nothing at all was chosen (the phantom draft).
 * - `no-time`  — an offer without a `bookedAt`.
 * - `no-offer` — a `bookedAt` without a `webOfferId`.
 *
 * A hold short-circuits all three: the hold IS the slot.
 */
export function unbookableReason(item: BookableFields): UnbookableReason | null {
  if (item.qamfReservationId) return null;
  const hasTime = !!item.bookedAt;
  // webOfferId 0 is as absent as null — QAMF has no offer 0, and 0 is exactly
  // what the `item.webOfferId ?? 0` fallback produced in the incident.
  const hasOffer = !!item.webOfferId;
  if (hasTime && hasOffer) return null;
  if (!hasTime && !hasOffer) return "no-slot";
  return hasTime ? "no-offer" : "no-time";
}

/** True when this leg can produce a QAMF reservation. */
export function isBookableBowlingLeg(item: BookableFields): boolean {
  return unbookableReason(item) === null;
}

/**
 * Split bowling-like items into the legs the reserve pipeline may act on and
 * the legs it must drop. Order is preserved within each side — a combo's two
 * legs stay in cart order, and the day-of order lines keep their shape.
 */
export function partitionBookableLegs<T extends BowlingItem | KbfItem>(
  items: T[],
): { bookable: T[]; dropped: Array<{ item: T; reason: UnbookableReason }> } {
  const bookable: T[] = [];
  const dropped: Array<{ item: T; reason: UnbookableReason }> = [];
  for (const item of items) {
    const reason = unbookableReason(item);
    if (reason) dropped.push({ item, reason });
    else bookable.push(item);
  }
  return { bookable, dropped };
}

/** One-line audit description of a dropped leg — goes to logs + reserve_attempts. */
export function describeDroppedLeg(item: BowlingItem | KbfItem, reason: UnbookableReason): string {
  const duckpin = item.kind === "bowling" && item.isDuckpin ? " duckpin" : "";
  return (
    `${item.kind}${duckpin} id=${item.id} reason=${reason} ` +
    `date=${item.date ?? "-"} bookedAt=${item.bookedAt ?? "-"} ` +
    `webOfferId=${item.webOfferId ?? "-"} hold=${item.qamfReservationId ?? "-"} ` +
    `center=${item.qamfCenterId ?? "-"}`
  );
}
