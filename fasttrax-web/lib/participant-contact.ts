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

/**
 * Guardian / parent contact attached to a minor's participant record.
 * Pandora is rolling this out; field stays optional for the
 * transition window. Used by the video-notification path as a
 * fallback when the racer themselves has no usable / opted-in
 * contact (typical for under-13s).
 *
 * Same opt-in semantics as the racer record — `acceptSmsCommercial`
 * defaulting to undefined means "consent not on file"; we treat
 * that as eligible (legacy behavior) per `hasSmsConsent`.
 */
export interface GuardianContact {
  personId?: string | number;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  homePhone?: string | null;
  mobilePhone?: string | null;
  acceptMailCommercial?: boolean;
  acceptMailScores?: boolean;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;
}

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

  /** Kart number assigned by SMS-Timing during/after the race.
   *  Populated on past/in-progress sessions, `null` for upcoming
   *  (karts get assigned closer to race time). Surfaced on the
   *  camera-assign page once staff confirms the Pandora rollout. */
  kartNumber?: number | string | null;

  /** Payment status from the participant's linked bill. The Pandora
   *  proxy filters unpaid by default via `excludeUnpaid=true`; pass
   *  `excludeUnpaid=false` to see this field populated. */
  paid?: boolean;

  /** Optional guardian / parent contact. Only used when the racer
   *  themselves has no usable contact (no email, no phone, or
   *  explicit opt-out). See `pickVideoContact` for the fallback
   *  logic — currently scoped to the video-notification path only;
   *  pre-race + check-in e-tickets are still racer-only. */
  guardian?: GuardianContact | null;

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

// ── Contact picker with guardian fallback (videos + e-tickets) ─────────

/**
 * Compact view of "who, on what channel, with what consent" — the same
 * shape `pickContactWithGuardianFallback` produces for both racer and
 * guardian, so downstream consumers don't have to repeat the
 * field-preference logic.
 *
 * Used by both the video-match notify path and the pre-race +
 * check-in e-ticket crons. The `recipient` field drives body framing
 * ("Your race video" vs. "Race video ready for {Racer}",
 * "FastTrax e-tickets" vs. "FastTrax e-tickets for your racers").
 */
export interface ContactCandidate {
  /** Whose contact we're using — drives the SMS/email body framing.
   *  When "guardian" the body is reframed as "video ready for {racer
   *  first name}" / "FastTrax e-ticket for your racer" so the parent
   *  knows whose race this is. */
  recipient: "racer" | "guardian";
  /** Display name of the WHO (used for greeting in the email/SMS) */
  contactFirstName?: string;
  contactLastName?: string;
  /** E.164 phone iff usable (canonicalized + not opted out), else null */
  phone: string | null;
  /** Email iff present (consent-aware), else null */
  email: string | null;
}

/** Back-compat alias — older code referenced this by the video-only name. */
export type VideoContactCandidate = ContactCandidate;

/** Internal: compute one candidate set from a contact-bearing record. */
function evaluateContact(
  c: { email?: string | null; mobilePhone?: string | null; homePhone?: string | null; phone?: string | null; acceptSmsCommercial?: boolean; acceptMailCommercial?: boolean },
  who: "racer" | "guardian",
  firstName?: string,
  lastName?: string,
): ContactCandidate {
  const rawPhone = c.mobilePhone || c.homePhone || c.phone || null;
  const phoneOk = c.acceptSmsCommercial !== false; // absent -> eligible (legacy)
  const phone = phoneOk ? canonicalizePhone(rawPhone) : null;

  const emailOk = c.acceptMailCommercial !== false;
  const email = emailOk && c.email ? String(c.email).trim() || null : null;

  return {
    recipient: who,
    contactFirstName: firstName,
    contactLastName: lastName,
    phone,
    email,
  };
}

/**
 * Decide who to notify for a video / e-ticket event:
 *   1. If the racer has any usable contact (SMS-eligible phone OR email),
 *      use the racer.
 *   2. Else if a guardian is on file with usable contact, use the
 *      guardian — caller must reframe the SMS/email body so the
 *      parent knows it's their kid's race.
 *   3. Else null (no one to notify).
 *
 * Returns the candidate (or null). Callers separately render the body
 * based on `recipient` and the racer's name.
 */
export function pickContactWithGuardianFallback(
  racer: Participant | { personId?: string | number; firstName?: string; lastName?: string; email?: string | null; mobilePhone?: string | null; homePhone?: string | null; phone?: string | null; acceptSmsCommercial?: boolean; acceptMailCommercial?: boolean; guardian?: GuardianContact | null },
): ContactCandidate | null {
  // Treat placeholder personIds (e.g. "DRIVER 1 PLACEHOLDER") as no-contact
  // — same gate as pickContactChannel for the regular cron paths.
  if ("personId" in racer && racer.personId != null && PLACEHOLDER_PERSON_IDS.has(String(racer.personId))) {
    return null;
  }

  const racerCand = evaluateContact(racer, "racer", racer.firstName, racer.lastName);
  if (racerCand.phone || racerCand.email) return racerCand;

  const g = racer.guardian;
  if (g && (g.mobilePhone || g.homePhone || g.email)) {
    const gCand = evaluateContact(g, "guardian", g.firstName, g.lastName);
    if (gCand.phone || gCand.email) return gCand;
  }
  return null;
}

/** Back-compat alias — older code referenced this by the video-only name. */
export const pickVideoContact = pickContactWithGuardianFallback;
