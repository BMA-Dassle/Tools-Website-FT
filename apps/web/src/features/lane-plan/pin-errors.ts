/**
 * Lane arrangement — reading QAMF's refusals. Pure.
 *
 * Pinning a lane can be refused for reasons that mean very different things, and the whole
 * fail-open contract depends on telling them apart. Both of these are RECOVERABLE — try
 * the next candidate lane — and neither should ever cost a booking:
 *
 *   409 `LanesNotCompatible`                     the lane is outside the web offer's
 *                                                Conqueror lane group. No endpoint exposes
 *                                                that group, so being told is the only way
 *                                                to learn it. Seen live 2026-08-25 pinning
 *                                                offer 154 to lane 6.
 *
 *   409 "Not enough resources available"         the lane is already taken for that window.
 *                                                Seen live 2026-08-25 deliberately pinning
 *                                                onto a booked birthday party on lane 25.
 *                                                **This is the vendor backstop working** —
 *                                                QAMF refuses a double-book even when we
 *                                                ask for one.
 *
 *   409 `ReservationItemOverlappedConcurrency`   "One or more resources are already booked
 *                                                for the selected time range" — somebody
 *                                                took the lane between our floor read and
 *                                                our create. Seen in PRODUCTION at Naples
 *                                                on 2026-08-31 and again 2026-09-01.
 *
 *   409 `BookingConflict`                        "Lanes already booked on Conqueror." The
 *                                                front desk is holding it and the web
 *                                                schedule had not caught up. Same nights.
 *
 * THE LAST TWO WERE MISSING, AND THE OMISSION UNDID THE GUARD. They are the refusals QAMF
 * actually returns under contention, and treating them as unrecognised meant one refusal
 * ended the walk and handed the choice back to QAMF — which auto-assigns off the schedule
 * and would happily return the occupied lane we had just avoided. A guest could be sent to
 * a lane somebody was on, by the very code meant to prevent it.
 *
 * One refusal is NOT recoverable, and is called out on its own because it means the bug is
 * ours:
 *
 *   400 validation error on `Lanes`             the set we asked for is not a legal set —
 *                                               in practice, not adjacent. Naples X89042,
 *                                               2026-09-04: 17+19, 19+21, 21+23 all refused,
 *                                               and QAMF then seated it on 23+24 itself.
 *                                               `wholePairSets` now makes this unreachable;
 *                                               it is named so that if it ever returns, the
 *                                               decision log says so instead of `unknown`.
 *
 * Anything else is not something a different lane would fix, so stop trying lanes and fall
 * open: drop `Lanes` and let QAMF assign. A lane preference is never worth a lost booking.
 */

export interface PinFailure {
  /** Would a different lane plausibly succeed? */
  tryNextLane: boolean;
  /** Short machine-ish reason, for logging into `lane_plan_decisions`. */
  code: "lanes_not_compatible" | "lane_unavailable" | "lanes_invalid" | "unknown";
  /** Human-readable, for staff-facing output. */
  why: string;
}

/**
 * Classify a `createReservation` / `moveReservationLanes` failure.
 *
 * Matches on the `detail` text as well as the `code`, because the vendor's own spec and
 * server disagree about codes — the v1.4 yaml documents `DifferentPriceKeyInTheCart` for a
 * condition the server actually reports as `ReservationConflict`. The detail string is the
 * more reliable signal.
 */
export function classifyPinFailure(message: string): PinFailure {
  const m = message.toLowerCase();

  if (m.includes("lanesnotcompatible")) {
    return {
      tryNextLane: true,
      code: "lanes_not_compatible",
      why: "409 LanesNotCompatible — lane is outside this offer's lane group",
    };
  }

  // Every way the vendor says "that lane is taken". The first two come from the spec; the
  // last three are what production actually returns, which is not the same list — matching
  // on `detail` as well as `code` because the two disagree.
  //
  // `already booked` deliberately catches BOTH observed details, since they differ only in
  // who took it: "One or more resources are already booked for the selected time range"
  // (another guest, mid-flight) and "Lanes already booked on Conqueror." (the front desk).
  if (
    m.includes("not enough resources") ||
    m.includes("lanesnotavailable") ||
    m.includes("already booked") ||
    m.includes("overlapped") ||
    m.includes("bookingconflict")
  ) {
    return {
      tryNextLane: true,
      code: "lane_unavailable",
      why: "409 — lane already taken for that window (QAMF refused the double-book)",
    };
  }

  // A 400 on the `Lanes` field is the vendor rejecting the SHAPE of the set, not its
  // availability — contention is always a 409. `tryNextLane: false` on purpose: a malformed
  // set means the enumerator is wrong, and the next set it produced is malformed the same
  // way, so retrying just burns the budget. Fall open and let QAMF choose, which is exactly
  // what recovered X89042.
  if (m.includes("validation error") && m.includes('"lanes"')) {
    return {
      tryNextLane: false,
      code: "lanes_invalid",
      why: "400 — QAMF rejected the lane set itself (lanes must be adjacent)",
    };
  }

  return {
    tryNextLane: false,
    code: "unknown",
    why: message.slice(0, 200),
  };
}

/** True when the failure means we should stop pinning and let QAMF choose. */
export function shouldFailOpen(message: string): boolean {
  return !classifyPinFailure(message).tryNextLane;
}
