/**
 * Roster identity merge — one row per human, resolved against the SYSTEMS OF
 * RECORD rather than by array position.
 *
 * ── Why this exists (live failure, W57387, 2026-08-07) ──────────────────────
 * `listBindableParty` unions five sources. Its old dedupe key was
 * `personId ?? \`name:${full.toLowerCase()}\``, so the SAME human arriving twice —
 * once as an id-less booking label ("THOMAS KING", typed at booking, personId
 * null) and once as a real BMI projectPerson ("Thomas King", id + live waiver) —
 * produced two DIFFERENT keys and both survived. `prefillPartyMembers` then
 * resolved the collision by array position, kept the id-less row, and dropped
 * the real person. A racer registered in BMI with a signed waiver rendered as
 * "Account + waiver needed". Replaying W57387 reproduced it exactly: 7 cards,
 * 4 real BMI people shadowed.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * BMI `projectPersons` is the system of record for WHO IS ON THE RESERVATION;
 * Pandora is the system of record for WAIVERS. Neon/Redis are the capture
 * buffer — they fill gaps, they never outrank the record. So:
 *   1. a row WITH a person id always beats an id-less row for the same name;
 *   2. ties break by SOURCE priority, not by arrival order.
 * Precedent: `unionValidWithJoins` (waiver/valid-count.ts) dedupes personId then
 * display name for the same reason — but it only works because it happens to
 * seed from the id-bearing side first. It has no explicit id preference, so it
 * is NOT reusable here; this module makes the preference explicit.
 */

/** Where a roster row came from. Lower `SOURCE_RANK` wins a tie. */
export type RosterSource = "bmi-project" | "waiver-join" | "booking-label" | "contact";

/** BMI first (system of record), the capture buffer last. */
const SOURCE_RANK: Record<RosterSource, number> = {
  "bmi-project": 0,
  "waiver-join": 1,
  "booking-label": 2,
  contact: 3,
};

export interface RosterRow {
  /** Display name as the source spelled it (BMI casing wins, so it survives). */
  full: string;
  personId: string | null;
  source: RosterSource;
}

/**
 * Category placeholder labels minted by count-based booking ("Adult 1",
 * "Junior 3"). Slot labels, not people — the "Who's racing?" step assigns real
 * people to those seats. Dropped even WITH a person id: the 2026-07-31 whitley
 * incident put literal "Adult 1" rows onto BMI's people list, so an id proves
 * nothing about whether a row is a human.
 */
export function isPlaceholderName(name: string): boolean {
  return /^(adult|junior)\s*\d*$/i.test(name.trim());
}

/**
 * Match key for a human. Case-folded, whitespace-collapsed, punctuation
 * stripped — so "ROBERT  HENDRICKS" (double space, as typed at booking) and
 * BMI's "Robert Hendricks" are one person.
 */
export function normalizeName(full: string): string {
  return full
    .toLowerCase()
    .replace(/[.,'’-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Was this waiver-join person REMOVED from the reservation in BMI?
 *
 * Staff delete people from a booking in BMI, but our Neon join row survives and
 * the roster unions it straight back in — so a racer taken off the reservation
 * reappears at the kiosk and can be checked in again (owner 2026-08-07: "I
 * removed some people from the group in BMI, went to check in and it loaded the
 * deleted one as well").
 *
 * The judgement rests on a POSITIVE fact, never on absence alone: we recorded
 * `attached`, meaning BMI accepted this person onto the project, and a
 * SUCCESSFUL read of the project now does not list them. Something removed them
 * in between. That is the two-call diff the Pandora removal rule demands.
 *
 * Fails CLOSED in every uncertain case — an unanswered/failed BMI read, or a row
 * that never attached, keeps the person. A guard over a party must never return
 * a permissive empty, and wrongly hiding a racer strands a paying guest.
 */
export function joinWasRemovedFromBmi(args: {
  /** True only when a project read actually SUCCEEDED (not a timeout/404). */
  bmiAnswered: boolean;
  /** personIds BMI currently lists on the project. */
  bmiPersonIds: Set<string>;
  /** The Neon row's recorded attach outcome. */
  attachStatus: string;
  personId: string | null;
}): boolean {
  const { bmiAnswered, bmiPersonIds, attachStatus, personId } = args;
  if (!bmiAnswered) return false; // BMI never spoke — assume nothing.
  if (!personId) return false;
  // Only a row we KNOW reached BMI can be judged missing from it. `pending`,
  // `failed` and `skipped` were never there, so absence proves nothing.
  if (attachStatus !== "attached") return false;
  return !bmiPersonIds.has(personId);
}

/** Forename / surname split of a normalized name. */
export function namePartsOf(full: string): { first: string; last: string } {
  const p = normalizeName(full).split(" ").filter(Boolean);
  return { first: p[0] ?? "", last: p.slice(1).join(" ") };
}

/**
 * True when two full names are plausibly the same human under a nickname —
 * "Tim Higgins" / "TIMOTHY HIGGINS", "Sam Cole" / "Samantha Cole".
 *
 * Deliberately narrow, because a wrong match silently deletes a guest from the
 * roster: the surname must match exactly and be non-empty, and one forename
 * must PREFIX the other with at least 3 characters in common — so Jo/John
 * never collapses. Exact-equal names return false (pass 2 already handled them).
 */
export function isNicknameVariant(aFull: string, bFull: string): boolean {
  const a = namePartsOf(aFull);
  const b = namePartsOf(bFull);
  if (!a.last || !b.last || a.last !== b.last) return false;
  if (a.first === b.first) return false;
  if (Math.min(a.first.length, b.first.length) < 3) return false;
  return a.first.startsWith(b.first) || b.first.startsWith(a.first);
}

/**
 * Collapse roster rows to one per human.
 *
 * Pass 1 — by person id: the best-ranked row per id.
 * Pass 2 — by normalized name: if ANY row for that name carries an id, the
 *          id-less rows for that name are dropped; then best rank wins.
 *
 * Merging two rows that share a name but carry DIFFERENT ids is deliberate and
 * matches the `unionValidWithJoins` precedent — one human legitimately has a
 * short Pandora id in one source and a 17-digit Office id in another. A rare
 * genuine "John S." + "John S." collapse is the accepted cost of never
 * double-listing one guest.
 */
export function mergeRosterRows(rows: RosterRow[]): RosterRow[] {
  const better = (a: RosterRow, b: RosterRow): RosterRow => {
    // An identified row always beats an id-less one, whatever the source.
    if (!!a.personId !== !!b.personId) return a.personId ? a : b;
    return SOURCE_RANK[a.source] <= SOURCE_RANK[b.source] ? a : b;
  };

  const usable = rows.filter((r) => {
    const full = r.full.trim();
    if (!full && !r.personId) return false;
    // Slot labels are never people — see isPlaceholderName.
    if (full && isPlaceholderName(full)) return false;
    return true;
  });

  // Pass 1 — one row per person id.
  const byId = new Map<string, RosterRow>();
  const idless: RosterRow[] = [];
  for (const r of usable) {
    if (!r.personId) {
      idless.push(r);
      continue;
    }
    const prev = byId.get(r.personId);
    byId.set(r.personId, prev ? better(prev, r) : r);
  }

  // Pass 2 — one row per normalized name, identified rows winning outright.
  const byName = new Map<string, RosterRow>();
  const order: string[] = [];
  const consider = (r: RosterRow) => {
    const key = normalizeName(r.full) || `id:${r.personId ?? ""}`;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, r);
      order.push(key);
      return;
    }
    byName.set(key, better(prev, r));
  };
  for (const r of byId.values()) consider(r);
  for (const r of idless) consider(r);

  const merged = order.map((k) => byName.get(k)!).filter(Boolean);

  // Pass 3 — nickname variants. "Tim Higgins" (BMI, id) and "TIMOTHY HIGGINS"
  // (booking label, no id) are one man, and exact-name matching can't see it:
  // that pair rendered as two cards on W57387. Deliberately narrow, because a
  // wrong merge silently deletes a real guest from the roster:
  //   - the surname must match exactly (normalized), and be non-empty;
  //   - exactly ONE side may carry an id — two identified rows are treated as
  //     two people (a genuine father/son, not an id-flavour split, which shows
  //     up as an exact name match and is already handled in pass 2);
  //   - one forename must PREFIX the other, minimum 3 characters, so Jo/John
  //     never collapses but Tim/Timothy and Sam/Samantha do.
  // Only the id-less row is ever dropped; the identified row always survives.
  const dropped = new Set<RosterRow>();
  for (const row of merged) {
    if (row.personId || dropped.has(row)) continue;
    const candidates = merged.filter(
      (o) => o !== row && !!o.personId && isNicknameVariant(o.full, row.full),
    );
    // Ambiguous (two identified people could both claim it) → keep both rather
    // than guess which human the booking label meant.
    if (candidates.length === 1) dropped.add(row);
  }

  return merged.filter((r) => !dropped.has(r));
}
