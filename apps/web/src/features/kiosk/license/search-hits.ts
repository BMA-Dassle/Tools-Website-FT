/**
 * Pure shaping of Pandora `GET /bmi/person/search` hits (license lookup).
 * No server deps — unit-tested. See docs/pandora-api.md § person search.
 *
 * The endpoint already filters by last name + birthdate and orders by
 * lastVisit (most recent first), but real data is messy — verified live
 * 2026-07-23 against the owner's own scan: FOUR records came back for one
 * human (duplicate accounts abound), one of them with firstName null. This
 * module collapses that to what the kiosk should act on.
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
 * Collapse raw search hits to at most one record per PERSON:
 *  - exact-match guard on last name + DOB (belt-and-braces over upstream);
 *  - one hit per first name — the search's most-recent-first order picks the
 *    live duplicate, EXCEPT a later same-name duplicate with a CURRENT waiver
 *    beats a more recent one without (signing in against the waiver-carrying
 *    record spares the guest a pointless re-sign);
 *  - firstName-null hits are stale/incomplete duplicates: dropped whenever a
 *    named hit survived (ambiguous between twins otherwise), kept (first one,
 *    waiver-valid preferred) only when NOTHING named matched;
 *  - final order: scanned-first-name affinity, then the search's own order.
 */
export function collapseSearchHits(
  hits: readonly PandoraSearchHit[],
  lastName: string,
  dobIso: string,
  scannedFirstName?: string,
): PandoraSearchHit[] {
  const exact = hits.filter(
    (h) =>
      h?.id &&
      norm(h.lastName) === norm(lastName) &&
      String(h.birthdate ?? "").slice(0, 10) === dobIso,
  );

  const byFirst = new Map<string, PandoraSearchHit>();
  const nameless: PandoraSearchHit[] = [];
  for (const h of exact) {
    const key = norm(h.firstName);
    if (!key) {
      nameless.push(h);
      continue;
    }
    const kept = byFirst.get(key);
    if (!kept) byFirst.set(key, h);
    else if (!hitWaiverValid(kept) && hitWaiverValid(h)) byFirst.set(key, h);
  }
  let collapsed = [...byFirst.values()];
  if (collapsed.length === 0 && nameless.length > 0) {
    collapsed = [nameless.find(hitWaiverValid) ?? nameless[0]];
  }

  // Stable sort: affinity to the scanned given name first, search order after.
  return collapsed
    .map((h, i) => ({ h, i, aff: firstNameAffinity(h.firstName, scannedFirstName) }))
    .sort((a, b) => b.aff - a.aff || a.i - b.i)
    .map(({ h }) => h);
}
