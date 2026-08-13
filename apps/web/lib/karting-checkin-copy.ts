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
 * NO DURATION CLAIMS LIVE HERE. This file used to say "your race begins about
 * 30 min after check-in". Measured against `race_timings` (n=65): booked slot ->
 * green flag is p50 9.4 min, p95 15.7, max 23.9, and min -2.5 — some heats go
 * green BEFORE the booked minute. The 30 was wrong by ~3x in the direction that
 * costs guests their grid slot, and its "after check-in" anchor named whichever
 * desk the surrounding page was about (a standard guest reading it beside the
 * Guest Services time computes 7:15 + 30 = 7:45, landing exactly on the karting
 * cut-off — our own copy handing him the arithmetic for the mistake).
 * Say SEQUENCE, not duration, until the pace has been measured across weekends.
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
