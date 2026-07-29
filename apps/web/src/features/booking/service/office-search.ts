/**
 * Pure helpers over BMI Office `search/person` results — extracted from
 * ReturningRacerLookup so the description parsing + ranking rules are
 * testable in isolation.
 *
 * An Office search hit is `{ localId, description }` where the description is
 * a display string like "JANE DOE (239) 555-1212 zip: 33901 Last seen:
 * 3/1/2024" — these helpers parse it; they never fetch.
 *
 * TOKEN GOTCHAS (verified live 2026-07-23):
 *  - The upstream endpoint 500s under Node fetch/undici for slash-bearing or
 *    single-word tokens — call it via raw `https.get` (app/api/bmi-office and
 *    the kiosk license lookup both do); person/{id} fetches are fine on fetch.
 *  - Birthdate tokens work as `M/D/YYYY` with NO leading zeros ("8/20/2002";
 *    "08/20/2002" returns nothing). Combined "LastName M/D/YYYY" scopes the
 *    search to one human — the kiosk license lookup's vector (owner ask).
 */

export interface SearchCandidate {
  localId: string;
  description: string;
  score: number;
  /** Epoch ms parsed from the description's "Last seen: M/D/YYYY" (0 = none). */
  lastSeenAt: number;
}

/** Completeness score — richer descriptions usually mean the live record. */
export function scoreSearchResult(desc: string): number {
  let s = 0;
  if (/\(\d/.test(desc)) s += 100;
  if (desc.includes("Memberships:")) s += 50;
  if (desc.includes("zip:")) s += 25;
  if (desc.includes("Last seen:")) s += 10;
  return s;
}

export function lastSeenFromDescription(desc: string): number {
  const m = desc.match(/Last seen:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (!m) return 0;
  const t = new Date(m[1]).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** The person-name prefix of a description (everything before phone/zip/etc). */
export function nameFromDescription(desc: string): string {
  const nameMatch = desc.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
  return (nameMatch ? nameMatch[1].trim() : desc.split(" phone:")[0].trim()) || desc.trim();
}

/** "2002-08-20" → "8/20/2002" — the exact DOB token format the Office search
 *  indexes (M/D/YYYY, NO leading zeros — "08/20/2002" matches NOTHING;
 *  verified live 2026-07-23). Descriptions carry the same form as "(8/20/2002)". */
export function dobTokenOf(dobIso: string): string {
  const [y, m, d] = dobIso.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

/** Whole-word, case-insensitive last-name test against the NAME part only —
 *  "DOE" matches "JANE DOE" but not "JANE DOEBER". */
export function descriptionMatchesLastName(desc: string, lastName: string): boolean {
  const name = nameFromDescription(desc);
  const esc = lastName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return false;
  return new RegExp(`(^|[^A-Za-z])${esc}([^A-Za-z]|$)`, "i").test(name);
}

/** Loose given-name affinity for RANKING (never filtering): exact = 2, one a
 *  prefix of the other = 1 (license "ALEXANDER" ↔ account "Alex"), else 0. */
export function firstNameAffinity(a: string | null | undefined, b: string | null | undefined) {
  const x = String(a ?? "")
    .trim()
    .toLowerCase();
  const y = String(b ?? "")
    .trim()
    .toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 2;
  if (x.startsWith(y) || y.startsWith(x)) return 1;
  return 0;
}

/**
 * Dedupe + rank raw search hits: one entry per localId, then ONE candidate per
 * person NAME (duplicate accounts abound — keep the most recently used copy,
 * ties broken by description completeness), ordered most-recent-first.
 */
export function rankSearchResults(
  results: Array<{ localId: string; description: string }>,
  max: number,
): SearchCandidate[] {
  const byId = new Map<string, { localId: string; description: string }>();
  for (const r of results) {
    if (r?.localId && !byId.has(r.localId)) byId.set(r.localId, r);
  }
  const byName = new Map<string, SearchCandidate>();
  for (const r of byId.values()) {
    const name = nameFromDescription(r.description).toLowerCase();
    const score = scoreSearchResult(r.description);
    const lastSeenAt = lastSeenFromDescription(r.description);
    const existing = byName.get(name);
    if (
      !existing ||
      lastSeenAt > existing.lastSeenAt ||
      (lastSeenAt === existing.lastSeenAt && score > existing.score)
    ) {
      byName.set(name, { localId: r.localId, description: r.description, score, lastSeenAt });
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.score - a.score)
    .slice(0, max);
}
