/**
 * Shared guest-facing copy for the "eticket time = karting check-in,
 * not race start" clarification. The time printed on an e-ticket is the
 * KARTING check-in cut-off for the heat (1st Floor karting desk).
 *
 * THERE ARE TWO CHECK-INS IN THIS BUILDING AND THEY ARE HALF AN HOUR APART:
 *   1. RESERVATION check-in — Guest Services, 2nd Floor, ~30 min before the heat.
 *   2. KARTING check-in     — 1st Floor counter, AT the heat minute. <- this file
 * Express Lane skips #1 entirely; Ultimate VIP parties meet in the infield VIP
 * Room instead. So a label that says only "Check In By" is true of two different
 * times on two different floors, and a guest cannot tell which one he is reading.
 *
 * RULE: every deadline names its DESK, never the bare act. A guest navigating a
 * building thinks in destinations, not in stages of a process. Do not add a
 * generic "check in by" string to this file — there is deliberately no such
 * export, so a surface cannot reach for the ambiguous one.
 *
 * STILL NO DURATION CLAIMS IN THIS FILE — but the pace has now been measured, so
 * here is what the measurement says, for whoever reaches for a duration next.
 *
 * This file used to say "your race begins about 30 min after check-in" — an
 * AVERAGE claim, and wrong by ~3x. Deleted 2026-08-13 with the note "say
 * SEQUENCE, not duration, until the pace has been measured across weekends".
 *
 * Measured twice since, on the KARTING anchor both times (booked slot -> green
 * flag):
 *
 *   2026-08-13   n=65    p50  9.4   p95 15.7   max 23.9   min -2.5
 *   2026-08-16   n=100   p50 16.1   p90 24.9   max 32.0   (blue+red, Saturday)
 *
 * So the honest form is an ALLOWANCE, not an estimate: "allow up to 30 minutes"
 * is true of ~99 heats in 100 and is safe in the direction that matters — a
 * guest who plans for 30 and races at +16 is early, which costs nothing, while
 * the old "about 30" sent people away for half an hour.
 *
 * CAVEATS THE NEXT PERSON MUST KNOW BEFORE TRUSTING THE 30:
 *  - it is EXCEEDED. One heat in the 8/16 sample took 32.0 min. "Up to" is a
 *    planning allowance, not a guarantee, and the copy must never promise it.
 *  - only ONE weekend day is in the sample, so the 8/13 bar ("across weekends")
 *    is not fully met. The number is an owner decision (2026-08-17) taken on
 *    this evidence, not a statistic that earned its own way in.
 *  - it is anchored to KARTING check-in, never to Guest Services. Adding 30 to
 *    the Guest Services time lands a standard guest exactly on the karting
 *    cut-off, which is the original defect this file exists to prevent.
 *
 * WHERE THE ALLOWANCE ACTUALLY LIVES: the kiosk heat grid quotes it, from the
 * i18n catalog (`race.heat.bannerAllowance`, EN + ES) with the number computed
 * per-day in features/racing/on-time.ts — today's p90 where the night has run
 * enough heats, this 30 as the floor when it has not. It is NOT exported from
 * here, because a Spanish twin is required and this module is English-only. The
 * guard test still fails the build on any duration string added to THIS file.
 *
 * Imported by both client components (app/t/[id]/*) and server-side
 * email/SMS builders, so wording changes land everywhere at once.
 */

/** Big-time label on eticket cards. Names the desk, never the bare act. */
export const KARTING_CHECKIN_LABEL = "Be at the Karting Desk by";

/** Tight surfaces — full-screen ticket, wallet pass, kiosk chips. */
export const KARTING_CHECKIN_LABEL_SHORT = "Karting Desk by";

/** Past / invalid cards. */
export const KARTING_CHECKIN_CLOSED_LABEL = "Karting check-in closed";

/** Where the karting desk is. Pair with either label above. */
export const KARTING_CHECKIN_PLACE = "1st Floor, by the Red Track";

/** Sub-line rendered directly under the big time value on web surfaces. */
export const KARTING_CHECKIN_SUBLINE =
  "This is not your race time — racing starts after your safety briefing.";

/** One-liner for email bodies listing multiple heats/times. */
export const KARTING_CHECKIN_EMAIL_NOTE =
  "Times shown are karting check-in times, not race times. Racing starts after your safety briefing.";

/**
 * SMS note line. MUST stay GSM-7-safe: plain ASCII only — no em-dash,
 * arrows, or middots (they force UCS-2 and double segment cost).
 */
export const KARTING_CHECKIN_SMS_NOTE = "Karting check-in, not race time. Race after briefing.";

/* -------------------------------------------------------------------------
 * RESERVATION check-in — Guest Services, 2nd Floor. A DIFFERENT check-in,
 * ~30 min earlier, which Express Lane parties skip entirely. These live in the
 * same file on purpose: the two labels only stay distinguishable if a change to
 * one is made with the other on screen.
 * ---------------------------------------------------------------------- */

/** Big-time label for the Guest Services deadline. Names the desk. */
export const GUEST_SERVICES_LABEL = "Be at Guest Services by";

/** Where Guest Services is. */
export const GUEST_SERVICES_PLACE = "2nd Floor";

/**
 * Bridge line for the standard (non-express) journey: Guest Services first,
 * then the karting desk. Naming both stops in one sentence is what stops a
 * guest adding a duration to whichever time happens to be on screen.
 */
export function thenKartingBy(kartingTime: string): string {
  return `Then the Karting Desk, 1st Floor by ${kartingTime} — that is your karting check-in, not your race time.`;
}
