/**
 * Which race seats are still free when a party checks in HALF NOW, HALF LATER.
 *
 * `booking_metadata.heats[].bmiPersonId` is never written back after the kiosk
 * seats someone, so every heat still looks open on a second finalize. Until now
 * the only thing preventing a double-seat was `completed_at` ending check-in
 * for the day outright — which is also why the late half of a party silently
 * never reached the grid. Resuming safely means reconstructing what the earlier
 * pass consumed, and the record of that is `kiosk_checkin_people.bound_heats`.
 *
 * This is a MULTISET take, not a filter: two racers can share one heatId (two
 * seats, same race), so a heat with two seats and one prior racer still has one
 * seat free. Filtering by heatId would wrongly close both.
 */

export interface SeatHeat {
  heatId?: string;
  productId?: string | null;
}

/** Identity of a SEAT's race — heat time plus product, never the person. */
function seatKey(h: SeatHeat): string {
  return `${h.heatId ?? ""}|${h.productId ?? ""}`;
}

/**
 * Drop one entry per heat a previous pass already filled, preserving order.
 *
 * @param entries    open seats, each carrying its heat
 * @param priorBound heats bound by people already on the grid
 */
export function consumePriorSeats<T extends { heat: SeatHeat }>(
  entries: T[],
  priorBound: SeatHeat[],
): T[] {
  const remaining = new Map<string, number>();
  for (const h of priorBound) {
    const k = seatKey(h);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  return entries.filter((e) => {
    const k = seatKey(e.heat);
    const n = remaining.get(k) ?? 0;
    if (n <= 0) return true;
    remaining.set(k, n - 1);
    return false;
  });
}
