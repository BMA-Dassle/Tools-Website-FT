/**
 * The Conversations URL key — ONE ENTRY PER PERSON, so the key names a person
 * and not a carrier thread (a guest who has texted two reps has two rows in
 * `crm_sms_threads` and exactly one row on the screen).
 *
 *   `c-<contactId>`   we know who they are
 *   `p-<digits>`      all we have is the number
 *
 * PATH-SAFE BY CONSTRUCTION: only `[a-z0-9-]`, so it drops straight into
 * `/admin/crm/conversations/<key>` and `/api/admin/crm/sms/threads/<key>` with
 * no encoding, and a mistyped key can never become a path traversal.
 *
 * CLIENT-SAFE: no imports at all. The deal's Text button builds a key from a
 * phone number without a round trip, and the server parses the same key.
 */

export type ConversationKey =
  | { kind: "contact"; contactId: string }
  | { kind: "phone"; digits: string };

/** Digits only, at most 15 (E.164's own limit). */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D+/g, "").slice(0, 15);
}

export function contactKey(contactId: string): string {
  return `c-${contactId}`;
}

export function phoneKey(phone: string): string {
  return `p-${phoneDigits(phone)}`;
}

/** `null` for anything that is not one of the two shapes. */
export function parseConversationKey(key: string): ConversationKey | null {
  const raw = (key ?? "").trim();
  const contact = /^c-(\d{1,18})$/.exec(raw);
  if (contact) return { kind: "contact", contactId: contact[1] };
  const phone = /^p-(\d{7,15})$/.exec(raw);
  if (phone) return { kind: "phone", digits: phone[1] };
  return null;
}

/**
 * A US 10-digit or 11-digit number back to E.164. Deliberately narrow: the
 * canonical form is produced server-side by `canonicalizePhone`, and this only
 * has to undo `phoneDigits` for a key we minted ourselves.
 */
export function e164FromDigits(digits: string): string | null {
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{11,15}$/.test(digits)) return `+${digits}`;
  return null;
}
