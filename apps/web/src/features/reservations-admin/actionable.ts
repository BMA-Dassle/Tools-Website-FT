/**
 * Row-level action gates + confirmation links for the admin reservations board.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import type { ComboMergeInfo, Reservation } from "./types";

export function confirmPath(r: Reservation): string | null {
  // Prefer the canonical v2 (multi-activity) short link for BMI-bill legs
  // (race/attraction) — the same /s/{code} the guest gets by email/SMS and the
  // account dashboard shows, so a multi-activity booking opens the confirmation
  // hub instead of the single-activity v1 page. Falls back to the QAMF-only
  // bowling /s/{shortCode} confirmation for bowling/KBF rows (no bmiBillId).
  if (r.confirmationShortUrl) return r.confirmationShortUrl;
  return r.shortCode ? `/s/${r.shortCode}` : null;
}

/** Confirmation link for a (possibly combo) row. A combo's "View" opens the
 *  multi-attraction (v2) confirmation via the race leg's BMI bill — prefer the
 *  canonical short link (/s/{code}, matches the guest's email/SMS), falling
 *  back to the raw billId URL, then to the normal per-row short code. */
export function comboConfirmPath(r: Reservation & { comboMerge?: ComboMergeInfo }): string | null {
  if (r.comboMerge?.raceShortUrl) return r.comboMerge.raceShortUrl;
  if (r.comboMerge?.raceBillId) return `/book/confirmation/v2?billId=${r.comboMerge.raceBillId}`;
  return confirmPath(r);
}

/**
 * Check In + Cancel are bowling-only actions (QAMF lane open / bowling refund).
 * They don't apply to race/attraction rows, and we also hide them on a bowling
 * reservation that has attractions attached — cancelling/checking-in a mixed
 * bowling+attraction booking from here isn't safe (the attraction legs live in
 * BMI). So: only plain open/KBF bowling with no attraction add-ons.
 */
export function bowlingActionable(r: Reservation): boolean {
  const isBowling = r.productKind === "open" || r.productKind === "kbf";
  return isBowling && (r.attractionBookings?.length ?? 0) === 0;
}

/**
 * Cancel is an ALL-KINDS action (races, attractions, bowling±add-ons, and VIP
 * combos — the cascade resolves every leg server-side from any leg's neonId)
 * with two outcomes: refund to card, or a HeadPinz FastTrax Gift Card the guest
 * rebooks with. Row fields are a fast pre-filter only — the modal opens with
 * an authoritative server dry-run that catches anything these miss (e.g. a
 * day-of order tendered seconds ago).
 */
export function cancelActionable(r: Reservation): boolean {
  if (
    r.status === "cancelled" ||
    r.status === "completed" ||
    r.status === "no_show" ||
    r.status === "arrived"
  ) {
    return false;
  }
  if (r.dayofPaymentId) return false; // already paid at the venue — manual path
  return true;
}

/**
 * Refund is the money action for the rows Cancel deliberately refuses: the
 * guest has ARRIVED or the visit is DONE, so the booking must NOT be voided —
 * only money moves back. Cancel would rewrite history (and its cascade won't
 * touch a tendered day-of order anyway); the edit engine's money-only path
 * returns day-of order lines and walks the refund back to the guest's card.
 *
 * Row fields are a fast pre-filter only. The server's dry-run is authoritative
 * (it reads the LIVE Square order to pick the phase), and `capabilities.refund`
 * on the detail payload decides whether the button renders at all.
 */
export function refundActionable(r: Reservation): boolean {
  // A cancelled row already settled through the cancel cascade.
  if (r.status === "cancelled") return false;
  // Pre-arrival rows belong to Cancel — it voids the booking AND settles money.
  if (r.status !== "arrived" && r.status !== "completed" && r.status !== "no_show") return false;
  // There must be a day-of charge to refund. Without one nothing was collected
  // at the venue, so there is no paid order for an itemized return to target.
  return !!r.dayofPaymentId;
}
