/**
 * VIDEO-WALL geometry — where a panel stands, and what slice of the wall it owns.
 *
 * PURE. Same posture as pairing.ts and track.ts: no I/O, no React, no clock, so
 * every rule here is testable by passing numbers in.
 *
 * ── Why this module exists at all ──────────────────────────────────────────
 * `ScreenPairing` was carrying two jobs. `resolvePair()` needs a group of
 * EXACTLY two to build the dual-monitor launcher, while `SceneBirthdayTakeover`
 * and `track.ts` read `position`/`count` off the same field as choreography.
 * The front-desk wall is five panels on three player PCs, so a 5-wide
 * choreography group in `pairing` would have deleted two launchers.
 *
 * `wall` carries the wall; `pairing` keeps its exact current meaning; `choreo()`
 * is the single question a scene asks. Every karting board carries only
 * `pairing` and comes out of `choreo()` with the identical answer it had before
 * this file existed — that equivalence is asserted in wall.test.ts, because it is
 * the whole reason this is additive rather than a migration.
 *
 * ── The gap is not decoration ──────────────────────────────────────────────
 * The karting boards sit ~4 FEET apart and carry "nothing readable may cross the
 * gap". The front-desk panels sit ~6 INCHES apart, where the gap reads as
 * word-spacing, and the law inverts: A WORD NEVER CROSSES A GAP, A SENTENCE MAY.
 * `wallSpan`/`wallCentre` exist to serve the second half of that — a light pass
 * or a gradient that travels the length of the wall has to know that the gaps
 * are part of the picture, or it moves at one speed on glass and teleports
 * across the joins.
 */

/** What every scene actually wants: where am I, and how many of us are there? */
export interface Choreo {
  /**
   * 0 = leftmost panel OF THIS SCENE. For a scene spanning the middle three of five,
   * the panel physically third from the left reports position 1 — a scene never has to
   * know it is sitting on a wider wall than it uses.
   */
  position: number;
  /** How many screens perform THIS SCENE together. 1 = this screen is on its own. */
  count: number;
  /** Gap between panels as a percent of ONE panel's picture width. */
  gapPct: number;
  /**
   * Is this panel part of the scene at all? False only for a panel outside a narrower
   * span — the director substitutes that panel's own `outsideScene`, so a scene should
   * never actually be rendered with `inSpan: false`. Exposed so the substitution can
   * be asserted rather than assumed.
   */
  inSpan: boolean;
}

/**
 * The panels a span covers, as an inclusive `[first, last]` of PHYSICAL positions.
 *
 * `middle` drops one panel from each end, so five becomes 1..3. A wall too narrow to
 * have a middle — one or two panels — keeps every panel, because dropping the ends of
 * a two-panel wall would leave nothing to render.
 */
export function spanRange(span: "wall" | "middle", count: number): { first: number; last: number } {
  const n = Math.max(1, Math.floor(safe(count, 1)));
  if (span === "middle" && n >= 3) return { first: 1, last: n - 2 };
  return { first: 0, last: n - 1 };
}

/** The shape `choreo` reads — a structural subset of ResolvedScreenConfig, so
 *  this module does not import from defaults.ts (which imports from here). */
export interface ChoreographedConfig {
  wall: { wallId: string; position: number; count: number; gapPct: number } | null;
  pairing: { groupId: string; position: number; count: number } | null;
}

/** A lone screen. `count: 1` is what makes every position-aware scene degrade
 *  to "render the whole composition myself" without a special case. */
export const SOLO: Choreo = { position: 0, count: 1, gapPct: 0, inSpan: true };

/**
 * Where this screen stands in whatever group it performs with.
 *
 * `wall ?? pairing ?? solo`, in that order. A screen carrying BOTH — every panel
 * of the front-desk wall does, because two of them also share a player PC — is
 * choreographed by its WALL: the wall is what the audience sees as one object,
 * while the pairing is a fact about cabling. Getting that precedence backwards
 * would split the five-panel show into two independent two-panel shows.
 *
 * A pairing contributes no gap, deliberately. `gapPct` describes panels close
 * enough for a gradient to cross; the boards that carry only `pairing` are four
 * feet apart, and telling a scene they were 0% apart would invite exactly the
 * spanning layout the 4-foot rule forbids. Nothing reads `gapPct` unless it is
 * painting across a wall, and only a wall has one.
 */
export function choreo(config: ChoreographedConfig, span: "wall" | "middle" = "wall"): Choreo {
  const w = config.wall;
  if (w) {
    const { first, last } = spanRange(span, w.count);
    const inSpan = w.position >= first && w.position <= last;
    return {
      // SPAN-RELATIVE. A scene spanning the middle three is a three-panel scene as far
      // as it is concerned, so it composes over 0..2 and needs no idea that two more
      // panels exist either side of it.
      position: inSpan ? w.position - first : 0,
      count: last - first + 1,
      gapPct: w.gapPct,
      inSpan,
    };
  }
  const p = config.pairing;
  if (p) return { position: p.position, count: p.count, gapPct: 0, inSpan: true };
  return SOLO;
}

/**
 * This panel's slice of the VIRTUAL CANVAS — the wall including its gaps —
 * as a [0,1] fraction, `start` at the panel's left edge.
 *
 * A 5-panel wall with a 12% gap is 5 panels + 4 gaps = 5.48 panel-widths wide,
 * so panel 0 occupies [0, 0.1825] and panel 4 occupies [0.8175, 1]. Feed those
 * to a background-position and a wall-wide gradient moves at ONE speed across
 * glass and gap alike, instead of jumping at every join.
 *
 * Never throws and never returns an inverted or out-of-range span: this drives a
 * background on a wall that runs unattended for weeks, and a NaN from a config
 * typo has to degrade to "paint the whole thing", not to an unlit panel.
 */
export function wallSpan(
  position: number,
  count: number,
  gapPct: number,
): { start: number; end: number } {
  const n = Math.max(1, Math.floor(safe(count, 1)));
  const p = clamp(Math.floor(safe(position, 0)), 0, n - 1);
  const gap = clamp(safe(gapPct, 0), 0, 100) / 100;
  // n panels of width 1 with (n-1) gaps between them.
  const total = n + (n - 1) * gap;
  const start = (p * (1 + gap)) / total;
  return { start, end: start + 1 / total };
}

/** The centre of this panel on the virtual canvas, [0,1]. What a radial bloom or
 *  a "the finale lands on the middle panel" test wants. */
export function wallCentre(position: number, count: number, gapPct: number): number {
  const { start, end } = wallSpan(position, count, gapPct);
  return (start + end) / 2;
}

/**
 * Is this panel the middle of an odd-width wall?
 *
 * The one place a name may land WHOLE — a celebration prints the guest's first
 * name here and the flanking panels carry glow and supporting detail, because a
 * name split across two panels is two broken halves however small the gap
 * (that half of the 4-foot rule survives at 6 inches; see the module note).
 * False on an even wall, which has no middle, and true on a solo screen, which
 * is its own middle.
 */
export function isWallCentre(position: number, count: number): boolean {
  const n = Math.max(1, Math.floor(safe(count, 1)));
  if (n % 2 === 0) return false;
  return clamp(Math.floor(safe(position, 0)), 0, n - 1) === (n - 1) / 2;
}

/**
 * The item for THIS panel from a list authored one-per-panel, or null.
 *
 * Returns null rather than wrapping when the wall is wider than the list: a
 * panel with nothing of its own to say must render its quiet state, never
 * duplicate its neighbour. (The kiosk bank's billboard repeats its last slide
 * instead — right there, where the extra screens are "…and more"; wrong here,
 * where a repeated leg of an itinerary would claim the night has two leg threes.)
 */
export function atWallPosition<T>(items: readonly T[], position: number): T | null {
  const p = Math.floor(safe(position, 0));
  if (p < 0 || p >= items.length) return null;
  return items[p];
}

/**
 * Which brand mark this panel carries.
 *
 * Derived from the ends when config does not say — the wall's statement wants a
 * mark bookending it, and only the two outer panels are ends. An explicit
 * `brand` wins, including an explicit "none", because which way the room faces
 * is a fact about the building and staff must be able to swap the two marks
 * without a deploy (plan, open decision 1).
 */
export function wallBrand(
  position: number,
  count: number,
  configured: "fasttrax" | "headpinz" | "none" | null | undefined,
): "fasttrax" | "headpinz" | null {
  if (configured === "none") return null;
  if (configured === "fasttrax" || configured === "headpinz") return configured;
  const n = Math.max(1, Math.floor(safe(count, 1)));
  const p = clamp(Math.floor(safe(position, 0)), 0, n - 1);
  if (n === 1) return null;
  if (p === 0) return "fasttrax";
  if (p === n - 1) return "headpinz";
  return null;
}

function safe(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
