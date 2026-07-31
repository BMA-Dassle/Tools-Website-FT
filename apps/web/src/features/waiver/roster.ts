/**
 * "Who is on this reservation, and who is already covered" — the roster the
 * public /waiver page preloads for an ONLINE booking (racing / laser / gel), so
 * a guest opening a forwarded link sees the party that is actually on the
 * booking instead of an empty list and a demand to retype eight people
 * (owner 2026-07-30). Group-function parties are deliberately NOT rostered here:
 * they come back through the contract confirmation page.
 *
 * This is the projection layer ONLY. `unionValidWithJoins` in
 * ~/features/kiosk/waiver/valid-count stays the authority on how many people are
 * covered; this module maps that same union onto per-person rows so the roster
 * and the "N of M" fraction are one result and can never disagree.
 *
 * PII: rows carry a redacted "First L." display name (makeDisplayName) and
 * nothing else about the human — never a full name, email, phone or birthdate.
 * BMI/Pandora person ids are 17-digit and stay STRINGS end to end.
 *
 * Every displayName that leaves this module is re-reduced through
 * `displayNameFromFull` — see `redactRosterName` below for why the fixed shared
 * helper is not enough on its own.
 */
import { displayNameFromFull } from "@/lib/display-name";
import {
  unionValidWithJoins,
  type RegisteredPerson,
  type WaiverJoinRow,
} from "~/features/kiosk/waiver/valid-count";

/** One person on the reservation, in the only shape a FORWARDABLE link may carry. */
export interface WaiverRosterEntry {
  /** BMI/Pandora person id — 17-digit safe, ALWAYS a string. Never Number()'d. */
  personId: string;
  /**
   * Redacted "Ann A." — the same makeDisplayName shape the kiosk roster returns,
   * and by construction NEVER more than a given name plus one initial: every row
   * passes `redactRosterName` on the way out, whatever the source sent.
   */
  displayName: string;
  /** Holds a currently-valid waiver right now (Pandora waiverExpiry ∪ our Neon joins). */
  waiverValid: boolean;
}

/**
 * Case/whitespace-insensitive display-name key — the union dedupes on names, so
 * the projection has to key them the same way or the two would drift.
 *
 * Deliberately keys the RAW name, NOT `redactRosterName(name)`: it has to be the
 * same key `unionValidWithJoins` uses, or the pre-folded join it is meant to make
 * the union swallow stops being swallowed and `validCount` no longer equals the
 * number of covered rows.
 */
function nameKey(displayName: string): string {
  return displayName.trim().toLowerCase();
}

/**
 * The last gate before a name goes on a FORWARDABLE link.
 *
 * Fixing `makeDisplayName` (2026-07-30) stops anything new arriving unredacted,
 * but it cannot clean rows already AT REST: `kiosk_waiver_joins.displayName` was
 * written by the old helper, so a guest who typed their whole name into the
 * kiosk's first-name box has a full name sitting in Neon right now — and
 * join-only signers are appended to this roster straight from those rows. So every
 * name is re-reduced on the way out, registered rows included.
 *
 * `displayNameFromFull` is idempotent ("Ann A." → "Ann A."), so this is a guard,
 * not a second competing rule: it is the same shared rule applied once more.
 */
function redactRosterName(displayName: string): string {
  return displayNameFromFull(displayName);
}

/**
 * Build the roster and the covered count from ONE pass, so the fraction the
 * header shows is literally the number of `waiverValid` rows in the list below it.
 *
 * The one wrinkle: a kiosk/waiver join carries the SHORT Pandora person id while
 * BMI projectPersons may surface the 17-digit Office id for the same human. Left
 * alone, `unionValidWithJoins` would count that join as a stranger standing NEXT
 * to the registered row instead of marking the row itself. So we fold the joins
 * into the per-person flag first (by id, else by display name — the same two keys
 * the union dedupes on) and hand the union those flags. The union then dedupes
 * that join away, which makes the total byte-for-byte identical to what it was
 * before this roster existed, while the flag lands on the row the guest
 * recognizes.
 *
 * Union members that match no registered row at all — someone signed whose BMI
 * attach failed, or who was never added to the booking — are appended as covered
 * rows: they ARE signed, and the flow must not ask them to sign again.
 *
 * Pure and synchronous: unit-testable without Pandora or Neon.
 */
export function buildWaiverRoster(
  registered: RegisteredPerson[],
  pandoraValidFlags: boolean[],
  joins: WaiverJoinRow[],
): { roster: WaiverRosterEntry[]; validCount: number } {
  const joinIds = new Set(joins.map((j) => j.personId));
  const joinNames = new Set(joins.map((j) => nameKey(j.displayName)));

  const covered = registered.map(
    (p, i) =>
      pandoraValidFlags[i] === true ||
      joinIds.has(p.personId) ||
      joinNames.has(nameKey(p.displayName)),
  );

  // Still the shared count rule — not a re-implementation of it.
  const valid = unionValidWithJoins(registered, covered, joins);

  const registeredIds = new Set(registered.map((p) => p.personId));
  const registeredNames = new Set(registered.map((p) => nameKey(p.displayName)));

  const roster: WaiverRosterEntry[] = registered.map((p, i) => ({
    personId: p.personId,
    displayName: redactRosterName(p.displayName),
    waiverValid: covered[i],
  }));
  for (const v of valid) {
    if (registeredIds.has(v.personId)) continue;
    if (registeredNames.has(nameKey(v.displayName))) continue;
    roster.push({
      personId: v.personId,
      // A join-only signer's name comes from a Neon row, possibly written by the
      // pre-2026-07-30 helper — this is the one place it can still be a full name.
      displayName: redactRosterName(v.displayName),
      waiverValid: true,
    });
  }

  // Invariant, by construction: roster.filter(r => r.waiverValid).length === validCount.
  return { roster, validCount: valid.length };
}
