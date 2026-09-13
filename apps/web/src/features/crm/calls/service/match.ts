/**
 * Matching a phone number to the CRM (brief §4 C3 "Match by E.164 to B3 contact
 * and lead helpers").
 *
 * Two halves:
 *   - PURE (`toE164`, `lastTen`, `sameNumber`, `repForExtension`,
 *     `callerLabel`) — no Neon, no network, unit-tested on their own;
 *   - ONE Neon read (`matchNumber`) that turns a number into
 *     `{contactId, leadId, repId}` by looking at `crm_contacts.phone_e164` and
 *     then the contact's most recent OPEN lead.
 *
 * WHY LAST TEN DIGITS. `crm_contacts.phone_e164` is written by B3's capture
 * from whatever the guest typed; 3CX hands us `+12395551234` on one leg and
 * bare `2395551234` on another, and a Vox-era row may hold `(239) 555-1234`.
 * Comparing the last ten digits is what actually matches a North-American
 * number across all three, and it is what `sameNumber` does. Anything shorter
 * than ten digits (an extension, `50`, a garbled trunk id) matches NOTHING —
 * deliberately, because a 2-digit "number" would otherwise match every row.
 */

import { isDbConfigured, sql } from "@ft/db";
import type { CrmRep } from "../../core/types";

/** A North-American number needs ten digits; below that we refuse to guess. */
export const MIN_MATCHABLE_DIGITS = 10;

/**
 * Best-effort E.164. Unlike `src/features/marketing/audience.ts`'s version this
 * NEVER throws: it is fed raw PBX fields, and a `null` is a perfectly ordinary
 * answer for an internal leg.
 */
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (plus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Anything else (an extension, a short code, an international number typed
  // without its `+`) is kept as digits with a `+` only when it is long enough
  // to be a real number; short ones stay unmatched by `lastTen`.
  return digits.length >= MIN_MATCHABLE_DIGITS ? `+${digits}` : digits;
}

/** The join key: the last ten digits, or null when there are not ten. */
export function lastTen(input: string | null | undefined): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  return digits.length >= MIN_MATCHABLE_DIGITS ? digits.slice(-MIN_MATCHABLE_DIGITS) : null;
}

/** Do these two numbers mean the same handset? */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = lastTen(a);
  const y = lastTen(b);
  return x !== null && x === y;
}

/** Is this DN one of ours (an extension), rather than a trunk or an E.164? */
export function isExtensionDn(dn: string | null | undefined): boolean {
  const v = String(dn ?? "").trim();
  return /^\d{1,6}$/.test(v);
}

/** The rep whose `threecx_extension` is this DN, or null. */
export function repForExtension(
  extension: string | null | undefined,
  reps: readonly CrmRep[],
): CrmRep | null {
  const dn = String(extension ?? "").trim();
  if (!dn) return null;
  return reps.find((r) => (r.threecxExtension ?? "").trim() === dn) ?? null;
}

/**
 * What the Calls list shows as the caller: the display name the PBX gave us,
 * unless it is just the number again (3CX repeats the E.164 in
 * `SourceDisplayName` for an unknown caller), in which case null so the UI
 * falls back to the number and the "Unknown" pill.
 */
export function callerLabel(
  displayName: string | null | undefined,
  number: string | null | undefined,
): string | null {
  const name = String(displayName ?? "").trim();
  if (!name) return null;
  if (sameNumber(name, number)) return null;
  if (name.replace(/\D/g, "") === String(number ?? "").replace(/\D/g, "")) return null;
  return name;
}

// ---------------------------------------------------------------------------
// The one Neon read
// ---------------------------------------------------------------------------

export interface NumberMatch {
  contactId: string | null;
  leadId: string | null;
  /** The lead's assignee — so a journalled call lands on the right rep's board. */
  repId: string | null;
  /** How we got there; shown in the tray and stored on the activity. */
  matchedBy: "phone" | "none";
}

export const NO_MATCH: NumberMatch = Object.freeze({
  contactId: null,
  leadId: null,
  repId: null,
  matchedBy: "none",
});

/**
 * Number → contact → their most useful lead.
 *
 * "Most useful" = the newest lead that is not archived, preferring one whose
 * status is still open (`crm_statuses.kind = 'open'`), because a guest ringing
 * back is almost always ringing about the enquiry that is still live rather
 * than last year's booking. Ties break on `created_at DESC`.
 */
export async function matchNumber(number: string | null | undefined): Promise<NumberMatch> {
  const key = lastTen(number);
  if (!key || !isDbConfigured()) return NO_MATCH;
  const q = sql();
  const rows = (await q.query(
    `SELECT c.id::text AS contact_id,
            l.id::text AS lead_id,
            l.assigned_rep_id::text AS rep_id
       FROM crm_contacts c
       LEFT JOIN LATERAL (
         SELECT l.id, l.assigned_rep_id
           FROM crm_leads l
           LEFT JOIN crm_statuses s ON s.id = l.status_id
          WHERE l.contact_id = c.id AND l.archived_at IS NULL
          ORDER BY (s.kind = 'open') DESC NULLS LAST, l.created_at DESC, l.id DESC
          LIMIT 1
       ) l ON TRUE
      WHERE right(regexp_replace(c.phone_e164, '\\D', '', 'g'), 10) = $1
      ORDER BY (l.id IS NOT NULL) DESC, c.updated_at DESC, c.id DESC
      LIMIT 1`,
    [key],
  )) as { contact_id: string; lead_id: string | null; rep_id: string | null }[];
  const hit = rows[0];
  if (!hit) return NO_MATCH;
  return {
    contactId: hit.contact_id,
    leadId: hit.lead_id ?? null,
    repId: hit.rep_id ?? null,
    matchedBy: "phone",
  };
}
