/**
 * De-duplication: does this cold row describe somebody we already have?
 *
 * THE ORDER IS THE REST OF THE CRM'S ORDER, not a new one. `upsertContact`
 * matches on `phone_e164` then `email_key` (`leads/data/contacts-db.ts`), and
 * `bmi_person_id` is the Office identity that outranks both because it is the
 * one id two systems agree on. Accounts match on `accountNameKey`. So:
 *
 *   1. `bmi_person_id`   — the same person in Office
 *   2. `phone_e164`      — the same number
 *   3. `email_key`       — the same mailbox
 *   4. account `name_key`— the same business
 *   5. `in_file`         — the same phone or email TWICE in this upload
 *
 * WHAT A MATCH DOES NOT DO: it never drops the row and never quietly merges
 * it. The row is stored either way (it was in the file; the file is ours now),
 * the match is recorded, and the operator decides on the review step — link,
 * skip, or import anyway. Silently dropping loses a prospect the rep meant to
 * ring; silently duplicating gives two reps the same business to cold-call.
 *
 * PURE AND CLIENT-SAFE: the caller hands in the candidates it read from Neon
 * and the account name key it computed with the leads sub's `accountNameKey`,
 * so this module imports no database.
 */

import type { ColdDecision, ColdMatchKey } from "./contracts";
import type { ColdProjection } from "./mapping";

/** The keys one cold row can match on. */
export interface ColdMatchKeys {
  bmiPersonId: string | null;
  phoneE164: string | null;
  emailKey: string | null;
  nameKey: string | null;
}

/** A row we already have, as the lookup returns it. */
export interface ColdCandidate {
  contactId: string | null;
  accountId: string | null;
  accountName: string | null;
  contactName: string | null;
  bmiPersonId: string | null;
  phoneE164: string | null;
  emailKey: string | null;
  nameKey: string | null;
}

export interface ColdMatch {
  key: ColdMatchKey;
  contactId: string | null;
  accountId: string | null;
  /** What the review table shows: the account name, else the contact's name. */
  label: string | null;
}

/**
 * The keys to look this row up by. `nameKey` is supplied rather than computed
 * (it needs `accountNameKey`, which lives beside Neon); everything else comes
 * straight off the projection.
 */
export function matchKeysFor(p: ColdProjection, nameKey: string | null): ColdMatchKeys {
  return {
    bmiPersonId: p.bmiPersonId,
    phoneE164: p.phoneE164,
    emailKey: p.emailKey,
    nameKey: nameKey && nameKey.trim() ? nameKey.trim() : null,
  };
}

/** True when nothing about this row could match anything. */
export function hasNoKeys(k: ColdMatchKeys): boolean {
  return !k.bmiPersonId && !k.phoneE164 && !k.emailKey && !k.nameKey;
}

function labelFor(c: ColdCandidate): string | null {
  return c.accountName ?? c.contactName ?? null;
}

/**
 * The first candidate that matches, in the documented order. A candidate list
 * is the small set the lookup returned for THIS row's keys, so the scan is
 * over a handful of rows, not the table.
 */
export function pickMatch(
  keys: ColdMatchKeys,
  candidates: readonly ColdCandidate[],
): ColdMatch | null {
  if (keys.bmiPersonId) {
    const hit = candidates.find((c) => c.bmiPersonId && c.bmiPersonId === keys.bmiPersonId);
    if (hit) {
      return {
        key: "bmi_person_id",
        contactId: hit.contactId,
        accountId: hit.accountId,
        label: labelFor(hit),
      };
    }
  }
  if (keys.phoneE164) {
    const hit = candidates.find((c) => c.phoneE164 && c.phoneE164 === keys.phoneE164);
    if (hit) {
      return {
        key: "phone",
        contactId: hit.contactId,
        accountId: hit.accountId,
        label: labelFor(hit),
      };
    }
  }
  if (keys.emailKey) {
    const hit = candidates.find((c) => c.emailKey && c.emailKey === keys.emailKey);
    if (hit) {
      return {
        key: "email",
        contactId: hit.contactId,
        accountId: hit.accountId,
        label: labelFor(hit),
      };
    }
  }
  if (keys.nameKey) {
    const hit = candidates.find((c) => c.nameKey && c.nameKey === keys.nameKey);
    if (hit) {
      return {
        key: "account_name",
        contactId: hit.contactId,
        accountId: hit.accountId,
        label: labelFor(hit) ?? hit.accountName,
      };
    }
  }
  return null;
}

/**
 * The running set of phones and emails already seen in THIS upload, so the
 * second "(239) 555-3110" in a file is flagged instead of becoming a second
 * row a second rep rings.
 */
export class ColdSeenKeys {
  private readonly phones = new Set<string>();
  private readonly emails = new Set<string>();

  /** Records the keys and answers whether either had been seen before. */
  add(keys: ColdMatchKeys): boolean {
    let dup = false;
    if (keys.phoneE164) {
      if (this.phones.has(keys.phoneE164)) dup = true;
      else this.phones.add(keys.phoneE164);
    }
    if (keys.emailKey) {
      if (this.emails.has(keys.emailKey)) dup = true;
      else this.emails.add(keys.emailKey);
    }
    return dup;
  }

  get size(): number {
    return this.phones.size + this.emails.size;
  }
}

/**
 * The whole verdict for one row: the CRM match if there is one, else the
 * in-file duplicate flag, plus the decision it defaults to.
 *
 * Defaults, and why: a CRM match defaults to LINK because that is the
 * prototype's promise ("They will be linked, not duplicated"); an in-file
 * duplicate defaults to SKIP because the first copy is already in the list;
 * everything else imports. The operator can change any of them.
 */
export interface ColdVerdict {
  match: ColdMatch | null;
  matchedBy: ColdMatchKey | null;
  duplicateInFile: boolean;
  decision: ColdDecision;
}

export function verdictFor(
  keys: ColdMatchKeys,
  candidates: readonly ColdCandidate[],
  duplicateInFile: boolean,
): ColdVerdict {
  const match = pickMatch(keys, candidates);
  if (match) {
    return { match, matchedBy: match.key, duplicateInFile, decision: "link" };
  }
  if (duplicateInFile) {
    return { match: null, matchedBy: "in_file", duplicateInFile: true, decision: "skip" };
  }
  return { match: null, matchedBy: null, duplicateInFile: false, decision: "new" };
}
