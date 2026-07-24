/**
 * Pure shaping of Pandora `GET /bmi/person/search` hits (license lookup).
 * No server deps — unit-tested. See docs/pandora-api.md § person search.
 *
 * The endpoint already filters by last name + birthdate and orders by
 * lastVisit (most recent first). This module ONLY guards + ranks — it never
 * hides records: guests genuinely have several duplicate accounts (the
 * owner's own scan returns four), and the owner wants every match SHOWN so
 * the guest picks theirs on the account cards (owner 2026-07-23: ">1 result
 * → use our existing return racer selector"; earlier collapse-to-one was
 * wrong — it silently auto-signed-in and the selector never appeared).
 */

export interface PandoraSearchHit {
  /** BMI person id — 17-digit modern or legacy short form, RAW digit string
   *  (parseWithRawIds upstream; never Number() it). */
  id: string;
  firstName: string | null;
  lastName: string;
  /** ISO datetime; date part is the birthdate. */
  birthdate: string;
  waiverExpiry: string | null;
  lastVisit: string | null;
}

const norm = (s: string | null | undefined) =>
  String(s ?? "")
    .trim()
    .toLowerCase();

export function hitWaiverValid(hit: PandoraSearchHit): boolean {
  if (!hit.waiverExpiry) return false;
  const d = new Date(hit.waiverExpiry);
  return !Number.isNaN(d.getTime()) && d > new Date();
}

/** Loose given-name affinity for RANKING (never filtering): exact, or one is
 *  a prefix of the other (license "ALEXANDER" ↔ account "Alex"). */
export function firstNameAffinity(a: string | null | undefined, b: string | null | undefined) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 2;
  if (x.startsWith(y) || y.startsWith(x)) return 1;
  return 0;
}

/**
 * Guard + rank raw search hits — EVERY exact match survives:
 *  - exact-match guard on last name + DOB (belt-and-braces over upstream —
 *    the search must never return a different human);
 *  - order: scanned-first-name affinity first (twins with distinct names
 *    sort the cardholder up), then the search's own most-recent-first order,
 *    with nameless legacy records naturally sinking (affinity 0).
 * One hit → the kiosk signs in directly; several → the account picker shows
 * them all, best first.
 */
export function filterAndRankHits(
  hits: readonly PandoraSearchHit[],
  lastName: string,
  dobIso: string,
  scannedFirstName?: string,
): PandoraSearchHit[] {
  return hits
    .filter(
      (h) =>
        h?.id &&
        norm(h.lastName) === norm(lastName) &&
        String(h.birthdate ?? "").slice(0, 10) === dobIso,
    )
    .map((h, i) => ({ h, i, aff: firstNameAffinity(h.firstName, scannedFirstName) }))
    .sort((a, b) => b.aff - a.aff || a.i - b.i)
    .map(({ h }) => h);
}
