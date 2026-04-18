/**
 * Participant shape returned by the Pandora session-participants endpoint,
 * plus the opt-in-aware channel picker that both race-alert crons use.
 *
 * Pandora schema (current):
 *   personId:              string   // note: Pandora started sending this as string
 *   firstName, lastName
 *   email:                 string | null
 *   homePhone:             string | null
 *   mobilePhone:           string | null
 *   acceptMailCommercial:  boolean  // consent to marketing email
 *   acceptMailScores:      boolean  // consent to score-related email
 *   acceptSmsCommercial:   boolean  // consent to marketing SMS  <-- our gate
 *   acceptSmsScores:       boolean  // consent to score-related SMS
 *
 * Legacy fields (`phone`) kept optional for the transition period in case
 * Pandora has any endpoint that still returns the old shape.
 */

export interface Participant {
  personId: string | number;
  firstName: string;
  lastName: string;
  email: string | null;

  // New (preferred) fields
  homePhone?: string | null;
  mobilePhone?: string | null;
  acceptMailCommercial?: boolean;
  acceptMailScores?: boolean;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;

  // Legacy — may still appear briefly
  phone?: string | null;
}

export type ContactChannel =
  | { channel: "sms"; phone: string }
  | { channel: "email"; email: string }
  | { channel: "none"; reason: string };

/**
 * Decide which channel to use for a participant.
 *
 * SMS gating is `acceptSmsCommercial === true` AND they have a mobilePhone.
 * Email is a fallback, gated by `acceptMailCommercial` when present.
 *
 * During the schema transition we fall back to the legacy `phone` field if
 * the opt-in flags are absent. (Pandora can't retroactively know an old
 * record's consent state — treat undefined as "unknown, skip SMS" going
 * forward once we're sure every response has the new fields.)
 */
export function pickContactChannel(p: Participant): ContactChannel {
  // 1. SMS path — explicit opt-in + mobile number
  if (p.acceptSmsCommercial === true && p.mobilePhone) {
    return { channel: "sms", phone: p.mobilePhone };
  }

  // 2. Legacy fallback: opt-in field absent + plain phone field present.
  //    Remove this branch once Pandora confirms every record has the new shape.
  if (p.acceptSmsCommercial === undefined && !p.mobilePhone && p.phone) {
    return { channel: "sms", phone: p.phone };
  }

  // 3. Email path — allow when commercial consent is true OR not provided
  //    (transition period). Once Pandora's response is stable, tighten to
  //    `=== true` only.
  const emailAllowed = p.acceptMailCommercial !== false;
  if (emailAllowed && p.email) {
    return { channel: "email", email: p.email };
  }

  return { channel: "none", reason: "no consented channel" };
}
