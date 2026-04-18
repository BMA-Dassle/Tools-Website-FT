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
 * Pandora placeholder personIds — unassigned-seat stand-ins that carry bogus
 * contact info (e.g. phone "2222222222"). Never notify these.
 */
const PLACEHOLDER_PERSON_IDS: ReadonlySet<string> = new Set([
  "17750277", // DRIVER 1 PLACEHOLDER
]);

function isPlaceholderPerson(p: Participant): boolean {
  return PLACEHOLDER_PERSON_IDS.has(String(p.personId));
}

/**
 * Pick the best phone number for SMS. Prefer mobilePhone (guaranteed SMS-capable),
 * fall back to homePhone, then legacy `phone`. Returns null if none are present.
 */
export function pickPhone(p: Participant): string | null {
  return p.mobilePhone || p.homePhone || p.phone || null;
}

/**
 * Canonicalize a US phone number to E.164 (`+1XXXXXXXXXX`). Returns null for
 * anything that isn't a 10-digit US number or an 11-digit number starting with 1.
 * Used as both the SMS `to` value and the grouping key when bucketing family
 * members who share a phone.
 */
export function canonicalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
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
  if (isPlaceholderPerson(p)) {
    return { channel: "none", reason: "placeholder person" };
  }

  const phone = canonicalizePhone(pickPhone(p));

  // SMS eligibility. Consent is applied at the PHONE level by the cron, not
  // here: shared-phone family bookings where ANY member consented still get
  // the grouped SMS covering everyone. Here we just say "SMS is possible".
  if (phone) {
    return { channel: "sms", phone };
  }

  // Email fallback when no phone is on file.
  if (p.email) {
    return { channel: "email", email: p.email };
  }

  return { channel: "none", reason: "no contact info" };
}

/**
 * True when this participant has not opted out of SMS (flag true or absent).
 * Used at the phone-bucket level in the race-alert crons — if ANY member at
 * the phone returns true, the household gets the grouped SMS.
 */
export function hasSmsConsent(p: Participant): boolean {
  return p.acceptSmsCommercial !== false;
}
