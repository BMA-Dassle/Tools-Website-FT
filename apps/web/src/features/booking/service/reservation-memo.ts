/**
 * Single BMI reservation private memo — composes EVERY applicable note in one
 * string, in priority order.
 *
 * Why this exists: BMI's `booking/memo` writes a SINGLE field that OVERWRITES on
 * each call. v1 (and the v2 confirmation page it was copied to) fired separate
 * writes for Express Lane, POV codes, and group reservations, and the package
 * (Ultimate Qualifier) memo was written separately server-side — so the last
 * write won and clobbered the others. That's the "3-race pack overrode the
 * express-lane memo" bug. Build ONE memo here and write it once so nothing is
 * lost.
 *
 * Priority (high → low): Combo (Ultimate VIP) note, Express Lane, Booking URL,
 * Ultimate Qualifier, 3-Race Pack, POV codes, group-related reservations,
 * amount paid.
 */

/** Staff-facing note for combo 3-race packs. */
export const THREE_RACE_PACK_MEMO =
  "** 3-RACE PACK ** Customer purchased a 3-race pack — all 3 heats are booked on this one bill/reservation.";

export interface ReservationMemoParts {
  /** Combo special (Ultimate VIP) staff note — VIP banner, prepaid-includes,
   *  visit plan, assigned bowling lane, qualify fallback. Highest priority so
   *  it leads the memo. From features/combos comboReservationNote(). */
  comboNote?: string | null;
  /** Reservation number when the party is Express Lane eligible (all returning
   *  racers hold valid waivers → skip Guest Services). */
  expressLaneResNumber?: string | null;
  /** Confirmation page URL for this booking (so staff can pull it up). */
  bookingUrl?: string | null;
  /** Ultimate Qualifier (or other package) staff disclaimer — pkg.disclaimers.billMemo. */
  ultimateQualifierNote?: string | null;
  /** True when a combo 3-race pack is on the order. */
  isThreeRacePack?: boolean;
  /** Claimed ViewPoint (POV) camera codes, already emailed/texted to the guest. */
  povCodes?: string[] | null;
  /** Other reservations in the same group booking (e.g. "W123 (Alex), W124 (Sam)"). */
  relatedReservations?: string | null;
  /** Amount the guest paid online (dollars). */
  amountPaid?: number | null;
}

/** Compose the combined memo. Returns "" when no part applies. */
export function buildReservationMemo(parts: ReservationMemoParts): string {
  const lines: string[] = [];

  if (parts.comboNote) {
    lines.push(parts.comboNote);
  }
  if (parts.expressLaneResNumber) {
    lines.push(
      `** EXPRESS LANE ** ${parts.expressLaneResNumber} — all waivers valid; skip Guest Services.`,
    );
  }
  if (parts.bookingUrl) {
    lines.push(`Booking: ${parts.bookingUrl}`);
  }
  if (parts.ultimateQualifierNote) {
    lines.push(parts.ultimateQualifierNote);
  }
  if (parts.isThreeRacePack) {
    lines.push(THREE_RACE_PACK_MEMO);
  }
  if (parts.povCodes && parts.povCodes.length > 0) {
    lines.push(`POV Codes: ${parts.povCodes.join(", ")} — emailed & texted to guest.`);
  }
  if (parts.relatedReservations) {
    lines.push(`Group — related reservations: ${parts.relatedReservations}`);
  }
  if (typeof parts.amountPaid === "number" && parts.amountPaid > 0) {
    lines.push(`Paid online: $${parts.amountPaid.toFixed(2)}`);
  }

  return lines.join("\n");
}
