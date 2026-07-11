/**
 * Shared guest-facing copy for the "eticket time = karting check-in,
 * not race start" clarification. The time printed on an e-ticket is the
 * KARTING check-in cut-off for the heat (1st Floor karting desk) — the
 * race itself runs ~30 min after check-in. This is distinct from the
 * RESERVATION check-in at Guest Services (2nd Floor, ~30 min early);
 * never use these strings for reservation-check-in guidance.
 *
 * Imported by both client components (app/t/[id]/*) and server-side
 * email/SMS builders, so wording changes land everywhere at once.
 */

/** Big-time label on eticket cards. */
export const KARTING_CHECKIN_LABEL = "Karting Check-In Closes";

/** Sub-line rendered directly under the big time value on web surfaces. */
export const KARTING_CHECKIN_SUBLINE =
  "This is your karting check-in time, not your race time. Your race begins about 30 min after check-in.";

/** One-liner for email bodies listing multiple heats/times. */
export const KARTING_CHECKIN_EMAIL_NOTE =
  "Times shown are karting check-in times, not race times. Races begin about 30 minutes after check-in.";

/**
 * SMS note line. MUST stay GSM-7-safe: plain ASCII only — no em-dash,
 * arrows, or middots (they force UCS-2 and double segment cost).
 */
export const KARTING_CHECKIN_SMS_NOTE = "Time = karting check-in, race starts after";
