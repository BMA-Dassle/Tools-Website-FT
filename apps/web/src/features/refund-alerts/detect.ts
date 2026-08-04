/**
 * Refund policy alerts — sanctioned-vs-external classification. Pure, no I/O.
 *
 * A refund is SANCTIONED (quiet) when our own system created or recorded it:
 *   1. It is the refund id stamped on the reservation (square_refund_id —
 *      written by the cancel cascade, the QAMF-cancel webhook consumer, and
 *      every other in-app refund path via updateBowlingReservationCancelled).
 *   2. It appears in reservation_cancel_events.refund_ids (the cascade records
 *      EVERY refund it issues there; square_refund_id only carries the first).
 *   3. Legacy fallback: the reservation is already cancelled with a recorded
 *      refund amount — an older flow refunded before ids were stamped.
 *
 * Anything else on a reservation-linked payment means a human refunded
 * directly in the Square Dashboard / POS — the policy violation we alert on.
 */

export interface RefundLite {
  id: string;
  paymentId: string;
  status: string;
  amountCents: number;
  reason: string | null;
  createdAt: string;
  /** Present when a human issued the refund from the Dashboard/POS. */
  teamMemberId: string | null;
}

export interface ReservationLite {
  id: number;
  guestName: string | null;
  status: string;
  productKind: string;
  centerCode: string | null;
  totalCents: number;
  refundCents: number;
  squareRefundId: string | null;
  qamfReservationId: string | null;
}

export function isSanctionedRefund(
  refund: RefundLite,
  reservation: ReservationLite,
  recordedRefundIds: ReadonlySet<string>,
): boolean {
  if (reservation.squareRefundId && refund.id === reservation.squareRefundId) return true;
  if (recordedRefundIds.has(refund.id)) return true;
  if (reservation.status === "cancelled" && reservation.refundCents > 0) return true;
  return false;
}

export interface ExternalRefund {
  refund: RefundLite;
  reservation: ReservationLite;
}

/** Pair recent Square refunds with their reservations and keep only the
 *  external (unsanctioned) ones, oldest first so the chat reads in order. */
export function findExternalRefunds(
  refunds: RefundLite[],
  reservationsByPaymentId: ReadonlyMap<string, ReservationLite>,
  recordedRefundIds: ReadonlySet<string>,
): ExternalRefund[] {
  const out: ExternalRefund[] = [];
  for (const refund of refunds) {
    // Failed/rejected refunds never moved money — nothing to yell about.
    if (refund.status === "FAILED" || refund.status === "REJECTED") continue;
    const reservation = reservationsByPaymentId.get(refund.paymentId);
    if (!reservation) continue; // not one of ours (group functions, POS sales…)
    if (isSanctionedRefund(refund, reservation, recordedRefundIds)) continue;
    out.push({ refund, reservation });
  }
  out.sort((a, b) => a.refund.createdAt.localeCompare(b.refund.createdAt));
  return out;
}

/* ───────────────────── deal packs (non-reservation sales) ───────────────── */

/**
 * The deal-pack half of the same problem.
 *
 * A refund against a `deal_purchases` payment matches no reservation, and
 * `findExternalRefunds` DROPS unmatched refunds as "not one of ours". So until
 * this existed, a human refunding a deal pack in the Square Dashboard was
 * completely invisible — the same silent-zero-monitoring hole that was already
 * fixed once for edit payments.
 *
 * Kept as a PARALLEL type rather than widening `ReservationLite` into a union:
 * the card builder and every existing test are shaped around reservations, and
 * an additive path cannot regress the rail that already works.
 */
export interface DealPurchaseLite {
  id: number;
  buyerName: string | null;
  buyerEmail: string | null;
  dealSlug: string;
  totalCents: number;
  refundedCents: number;
}

export interface ExternalDealRefund {
  refund: RefundLite;
  purchase: DealPurchaseLite;
}

/**
 * Sanctioned = we recorded the id, full stop.
 *
 * NO legacy fallback, unlike the reservation rail. The `deal_refunds` ledger
 * exists from the first line of this feature and every refund it issues writes
 * its Square id there before resolving, so "we did this" is always answerable
 * exactly. A cancelled-with-an-amount style heuristic here would only create a
 * way for a real Dashboard refund to pass as ours.
 */
export function isSanctionedDealRefund(
  refund: RefundLite,
  recordedRefundIds: ReadonlySet<string>,
): boolean {
  return recordedRefundIds.has(refund.id);
}

/** Deal-pack refunds nobody in this system issued, oldest first. */
export function findExternalDealRefunds(
  refunds: RefundLite[],
  purchasesByPaymentId: ReadonlyMap<string, DealPurchaseLite>,
  recordedRefundIds: ReadonlySet<string>,
): ExternalDealRefund[] {
  const out: ExternalDealRefund[] = [];
  for (const refund of refunds) {
    // Failed/rejected refunds never moved money — nothing to yell about.
    if (refund.status === "FAILED" || refund.status === "REJECTED") continue;
    const purchase = purchasesByPaymentId.get(refund.paymentId);
    if (!purchase) continue;
    if (isSanctionedDealRefund(refund, recordedRefundIds)) continue;
    out.push({ refund, purchase });
  }
  out.sort((a, b) => a.refund.createdAt.localeCompare(b.refund.createdAt));
  return out;
}
