/**
 * Pure logic for the kiosk check-in BOWLER DETAILS screen — the kiosk mirror of
 * the web self check-in form (components/bowling/BowlingCheckin.tsx). Kept
 * presentation-free and I/O-free so the semantics that must match the web are
 * unit-tested here, not re-derived in JSX:
 *
 *  - "Bowler N" placeholder names display as EMPTY and save as null
 *  - a bowler holding a rental size MUST have a real name (the shoe goes to a
 *    person, and the KDS ticket prints that name)
 *  - rental sizes never exceed shoePairsAllowed (server enforces 422; the UI
 *    must catch it first)
 *  - shoeSize null = no rental ("own shoes" at check-in time — unlike the
 *    booking wizard there is no unanswered/"" distinction to preserve, because
 *    the PATCH is partial and null IS the web check-in's "No Shoes" value)
 *  - bumpers stay tri-state (null = not chosen yet) — a preference, never a gate
 */

/** One editable bowler row, as the screen holds it. */
export interface CheckinBowlerRow {
  slot: number;
  name: string;
  /** "Male 9" rental label, or null = no rental. */
  shoeSize: string | null;
  bumpers: boolean | null;
}

/** The players-API row subset this screen reads (GET .../players). */
export interface ApiPlayerRow {
  slot: number;
  name?: string | null;
  shoeSize?: string | null;
  bumpers?: boolean | null;
}

/** Is this a real guest-entered name (not the "Bowler N" bootstrap label)? */
export function isRealBowlerName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return n.length > 0 && !n.startsWith("Bowler ");
}

/** GET rows → editable rows. Placeholder "Bowler N" names show as empty —
 *  byte-for-byte the web check-in's behavior (BowlingCheckin.tsx). */
export function prefillBowlers(players: ApiPlayerRow[]): CheckinBowlerRow[] {
  return players.map((p) => ({
    slot: p.slot,
    name: isRealBowlerName(p.name) ? (p.name as string) : "",
    shoeSize: p.shoeSize || null,
    bumpers: p.bumpers ?? null,
  }));
}

/** Rows holding a rental size (empty-string and null both mean "no rental"). */
export function rentalCount(rows: CheckinBowlerRow[]): number {
  return rows.filter((r) => !!r.shoeSize).length;
}

export type BowlerIssue =
  | { kind: "name-needed"; slot: number }
  | { kind: "over-allowance"; allowed: number };

/** The web check-in's two hard rules, first violation wins. Null = saveable. */
export function firstBowlerIssue(
  rows: CheckinBowlerRow[],
  shoePairsAllowed: number,
): BowlerIssue | null {
  const missing = rows.find((r) => r.shoeSize && !r.name.trim());
  if (missing) return { kind: "name-needed", slot: missing.slot };
  if (rentalCount(rows) > shoePairsAllowed) {
    return { kind: "over-allowance", allowed: shoePairsAllowed };
  }
  return null;
}

/** At least one real name across the roster — the web rule that arms the
 *  finish button on a bowling-only check-in. */
export function hasAnyBowlerName(rows: CheckinBowlerRow[]): boolean {
  return rows.some((r) => isRealBowlerName(r.name));
}

/** Editable rows → the players PATCH body (same shape the web form sends). */
export function bowlerPatchBody(rows: CheckinBowlerRow[]): {
  players: Array<{ slot: number; name: string | null; shoeSize: string | null; bumpers: boolean | null }>;
} {
  return {
    players: rows.map((r) => ({
      slot: r.slot,
      name: r.name.trim() || null,
      shoeSize: r.shoeSize || null,
      bumpers: r.bumpers,
    })),
  };
}
