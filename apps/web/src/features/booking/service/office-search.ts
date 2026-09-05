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
 *  - Birthdate tokens work as `M/D/YYYY` with NO leading zeros ("3/14/2001";
 *    "03/14/2001" returns nothing). Combined "LastName M/D/YYYY" scopes the
 *    search to one human — the kiosk license lookup's vector (owner ask).
 */
import { isRelevantMembership } from "./race-products";

/**
 * How many hits to ask `search/person` for.
 *
 * It was 500, and that silently broke the phone sign-in for anyone whose
 * number is on a lot of records: the endpoint answers NEWEST-ID-FIRST, so a
 * cap truncates the OLDEST records — which are exactly the long-established
 * accounts carrying the licence, memberships and credits. Measured 2026-09-05:
 * one number sat on 628 person records, and the owner's real account was at
 * position 598, so it never reached the browser at all. The complete set came
 * back at maxResults=2000 (5000 returned the same 628 — 628 is everything
 * upstream has), so this is sized to not truncate rather than to page.
 */
export const OFFICE_SEARCH_MAX_RESULTS = 2000;

/** A birthdate marker in a description: "(3/14/2001)". Deliberately strict —
 *  a bare `(\d` also matches a parenthesised area code, "(239) 555-1212". */
const DOB_MARKER_RE = /\((\d{1,2}\/\d{1,2}\/\d{4})\)/;

export interface SearchCandidate {
  localId: string;
  description: string;
  score: number;
  /** Epoch ms parsed from the description's "Last seen: M/D/YYYY" (0 = none). */
  lastSeenAt: number;
  /** 2 = carries racing value, 1 = an identified human, 0 = bare stub. */
  tier: SubstanceTier;
}

/** Completeness score — richer descriptions usually mean the live record. */
export function scoreSearchResult(desc: string): number {
  let s = 0;
  if (DOB_MARKER_RE.test(desc)) s += 100;
  if (desc.includes("Memberships:")) s += 50;
  if (desc.includes("zip:")) s += 25;
  if (desc.includes("Last seen:")) s += 10;
  return s;
}

/** The `Memberships: a, b, c` tail of a description (the last field upstream
 *  emits), or `[]` when the record carries none. */
export function membershipsFromDescription(desc: string): string[] {
  const m = desc.match(/Memberships:\s*(.+)$/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type SubstanceTier = 0 | 1 | 2;

/**
 * How much this record is actually WORTH to the guest signing in.
 *
 *   2 — carries racing value: a licence, a pass, a qualification, race credit.
 *       `isRelevantMembership` is the same rule the account card and the
 *       product filter already use, so "substance" means one thing repo-wide.
 *       Note what it excludes: "Customer Registration" and "Default
 *       Membership" are granted automatically by the booking rails and sit on
 *       empty stubs too, so they prove nothing.
 *   1 — an identified human: a birthdate or an address was captured.
 *   0 — a bare stub: a name and a phone, nothing else. Cloud-mint duplicates
 *       and abandoned half-flows land here.
 */
export function substanceTier(desc: string): SubstanceTier {
  if (membershipsFromDescription(desc).some(isRelevantMembership)) return 2;
  if (DOB_MARKER_RE.test(desc) || desc.includes("zip:")) return 1;
  return 0;
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

/** "2001-03-14" → "3/14/2001" — the exact DOB token format the Office search
 *  indexes (M/D/YYYY, NO leading zeros — "03/14/2001" matches NOTHING;
 *  verified live 2026-07-23). Descriptions carry the same form as "(3/14/2001)". */
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
 * The one comparator this module ranks by: SUBSTANCE, then recency, then
 * completeness. Negative when `a` should come first.
 *
 * Recency alone was the rule (owner 2026-07-21: "the account the guest
 * actually uses should surface, not whichever duplicate the API listed
 * first"), and it holds — but only BETWEEN COMPARABLE RECORDS. Measured
 * 2026-09-05 on a number with 628 duplicates: every one of the ten most
 * recent was a value-less stub minted by a half-finished flow, while the real
 * account — licence, passes, qualifications, credits — was last used two
 * months earlier and never appeared. A stub is not a better answer for being
 * newer; it is an artefact of testing. So substance decides first, and
 * recency still decides among records that are worth the same.
 */
function byRank(a: SearchCandidate, b: SearchCandidate): number {
  return b.tier - a.tier || b.lastSeenAt - a.lastSeenAt || b.score - a.score;
}

function toCandidate(r: { localId: string; description: string }): SearchCandidate {
  return {
    localId: r.localId,
    description: r.description,
    score: scoreSearchResult(r.description),
    lastSeenAt: lastSeenFromDescription(r.description),
    tier: substanceTier(r.description),
  };
}

/**
 * Dedupe + rank raw search hits: one entry per localId, then ONE candidate per
 * person NAME (duplicate accounts abound — keep the BEST copy by `byRank`,
 * which is also the order the survivors come back in).
 *
 * The name collapse uses the same comparator as the sort on purpose: picking
 * the per-name winner by one rule and ordering by another is how the real
 * account got dropped before the ordering ever saw it.
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
    const candidate = toCandidate(r);
    const existing = byName.get(name);
    if (!existing || byRank(candidate, existing) < 0) byName.set(name, candidate);
  }
  return [...byName.values()].sort(byRank).slice(0, max);
}
