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
 * Pick the best phone number for SMS. Prefer mobilePhone (guaranteed SMS-capable),
 * fall back to homePhone, then legacy `phone`. Returns null if none are present.
 */
export function pickPhone(p: Participant): string | null {
  return p.mobilePhone || p.homePhone || p.phone || null;
}

/**
 * Decide which channel to use for a participant.
 *
 * Priority:
 *   1. SMS if `acceptSmsCommercial === true` AND any phone is present
 *      (mobile preferred, home secondary, legacy last).
 *   2. SMS fallback during schema transition — if consent flags are absent
 *      but a phone is present, still send (legacy behavior).
 *   3. Email if `acceptMailCommercial !== false` AND email is present.
 *   4. Otherwise skip.
 */
export function pickContactChannel(p: Participant): ContactChannel {
  const phone = pickPhone(p);

  // 1. SMS path — explicit opt-in + any phone (prefer mobile)
  if (p.acceptSmsCommercial === true && phone) {
    return { channel: "sms", phone };
  }

  // 2. Legacy fallback: consent flag absent + any phone present.
  //    Remove once every Pandora response guarantees the opt-in field.
  if (p.acceptSmsCommercial === undefined && phone) {
    return { channel: "sms", phone };
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
