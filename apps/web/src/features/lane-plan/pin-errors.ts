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
 * Anything else is not something a different lane would fix, so stop trying lanes and fall
 * open: drop `Lanes` and let QAMF assign. A lane preference is never worth a lost booking.
 */

export interface PinFailure {
  /** Would a different lane plausibly succeed? */
  tryNextLane: boolean;
  /** Short machine-ish reason, for logging into `lane_plan_decisions`. */
  code: "lanes_not_compatible" | "lane_unavailable" | "unknown";
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

  // "Not enough resources available for the request" is what QAMF returns when the lane is
  // occupied for the window. `LanesNotAvailable` covers the same ground on other endpoints.
  if (m.includes("not enough resources") || m.includes("lanesnotavailable")) {
    return {
      tryNextLane: true,
      code: "lane_unavailable",
      why: "409 — lane already taken for that window (QAMF refused the double-book)",
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
