/**
 * Express Lane eligibility for kiosk check-in — pure predicates, no I/O.
 *
 * Express Lane means the party needs NOTHING from the kiosk: every racer is a
 * resolved returning racer whose waiver is already on file, so they skip the
 * front desk, Guest Services AND kiosk check-in and go straight to Race
 * Check-In. Because of that, an express reservation is never OTP'd and never
 * walked through check-in — the kiosk only tells them where to go
 * (owner, repeatedly; kiosk-checkin-plan §11A got this wrong by badging EVERY
 * racing row as express).
 *
 * Two predicates, deliberately in one file so they can't drift apart:
 *  - `isExpressBooking` — the CHEAP one for the browse list. Trusts the
 *    `fastLane` flag checkout wrote (`booking/service/checkout.ts`), because
 *    per-row live Pandora waiver reads across every reservation in the window
 *    would be slow and would leak waiver status into an unauthenticated,
 *    PII-lean list.
 *  - `isExpressRoster` — the LIVE one for the itinerary, once we've already
 *    paid for the per-racer Pandora waiver read. Strictly stronger: it catches
 *    a waiver that lapsed between booking and race day.
 *
 * Both enforce the 2026-06-13 lesson (tasks/lessons.md § "Express Lane
 * eligibility must judge the WHOLE party"): a racer with no personId has no
 * waiver on record BY DEFINITION, so an unresolved racer DISQUALIFIES the party
 * — it is never "skip this one." Ops caught four reservations (W40849, W40705,
 * W40712, W40861) waved through express with an unregistered second racer.
 */

/** The subset of a Redis booking record express eligibility reads. */
export interface ExpressBookingRecord {
  fastLane?: boolean;
  racers?: Array<{ personId?: string | null }>;
}

/** One racer as the itinerary resolves them (identity + LIVE waiver status). */
export interface ExpressRosterRacer {
  identified: boolean;
  waiverValid: boolean;
}

/**
 * Booking-time express check for the browse list.
 *
 * `racingOnly` is a hard gate: a bowling or attraction leg still needs the
 * kiosk (lane open, per-attraction waivers), so a combo is NEVER express even
 * when every racer is set — sending that guest straight to Race Check-In would
 * strand their bowling lane.
 */
export function isExpressBooking(args: {
  record: ExpressBookingRecord | null | undefined;
  racingOnly: boolean;
}): boolean {
  if (!args.racingOnly) return false;
  const rec = args.record;
  if (!rec || rec.fastLane !== true) return false;
  const racers = rec.racers ?? [];
  return racers.length > 0 && racers.every((r) => !!r.personId);
}

/**
 * Live express check for the itinerary — every racer identified AND holding a
 * currently-valid waiver. A failed/unknown Pandora read resolves `waiverValid`
 * to false upstream, so an outage degrades to normal check-in (safe direction).
 */
export function isExpressRoster(args: {
  racers: ExpressRosterRacer[];
  racingOnly: boolean;
}): boolean {
  if (!args.racingOnly) return false;
  return args.racers.length > 0 && args.racers.every((r) => r.identified && r.waiverValid === true);
}
