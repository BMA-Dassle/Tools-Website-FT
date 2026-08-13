/**
 * Heat-conflict rules for a single racer's heat picks.
 *
 * Direct port of v1 `apps/web/lib/heat-conflict.ts` — pure logic, no
 * dependencies, easy to keep in lockstep with v1. When v1's gap rules
 * change (operator-tuned thresholds), update both files in parallel.
 *
 * Same track (Red ↔ Red, Blue ↔ Blue): block exactly the immediately-
 * adjacent heat on each side via a per-track time threshold. Each track
 * runs on a different cadence:
 *
 *   Red   every 12 min  →  threshold 13 min blocks only the adjacent
 *                          heat. E.g. pick 3:24 → blocks 3:12 + 3:36;
 *                          next pickable is 3:48 (+24 min away).
 *   Blue  every 12 min  →  threshold 13 min, same as Red. (Blue ran a
 *                          15-min cadence / 16-min threshold until
 *                          2026-07-02; owner: 12 min from now on.)
 *   Mega  every 12 min  →  same cadence as Red (threshold 13 min). On
 *                          Mega Tuesdays both tracks combine into a
 *                          single long configuration but the heat clock
 *                          still ticks every 12 min.
 *
 * Cross-track (Red ↔ Blue): 30 min buffer — finish heat, walk between
 * tracks, check in on the other side. Independent of cadence (the
 * bottleneck is the physical walk).
 *
 * v2 application: each `RaceItem.heats[]` entry carries `assignedTo`
 * (PartyMember.id). When validating, group by `assignedTo` and run
 * `heatsConflict` pairwise within each group. Different racers never
 * conflict — A and B can race the same heat block simultaneously.
 */

/** Per-track adjacent-heat threshold, in minutes. */
export const TRACK_ADJACENT_GAP_MIN: Record<string, number> = {
  red: 13,
  blue: 13, // 12-min cadence since 2026-07-02 (was 15-min / 16)
  mega: 13, // Mega runs the same 12-min cadence as Red
};

/** Fallback for unknown track names — matches v1's old Red/Blue rule. */
const FALLBACK_SAME_TRACK_MIN = 20;

/** Cross-track buffer — finish heat, walk across, check in. */
export const CROSS_TRACK_MIN_GAP_MIN = 30;

/**
 * Canonical track identity for comparison. Different rails label the SAME
 * physical track differently: the picker stores "Red"/"Blue"/"Mega"
 * (race-products.ts) while BMI-derived rows carry the dayplanner resource
 * name "Red Track"/"Blue Track"/"Mega Track". An exact string compare read
 * those as DIFFERENT tracks and applied the 30-min cross-track walk buffer —
 * wrongly blocking the every-other-heat (24-min) same-track pattern the
 * rules exist to allow (kiosk live find 2026-07-19). Lowercases and strips a
 * trailing "track" word so both formats compare equal; empty/unknown stays
 * "" (still treated as cross-track — unchanged).
 */
function normalizeTrack(track: string | null | undefined): string {
  return (track ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]*track$/, "");
}

/**
 * True if a candidate heat conflicts with a picked heat for the same
 * racer. Tracks are compared case-insensitively with a trailing "Track"
 * word stripped ("Red Track" ≡ "Red" — see normalizeTrack).
 *
 * @param pickedStart  epoch ms or Date of the already-picked heat
 * @param pickedTrack  "Red" | "Blue" | "Mega" | null
 * @param candStart    epoch ms or Date of the candidate heat
 * @param candTrack    track of the candidate heat
 */
export function heatsConflict(
  pickedStart: number | Date,
  pickedTrack: string | null | undefined,
  candStart: number | Date,
  candTrack: string | null | undefined,
): boolean {
  const pickedMs = pickedStart instanceof Date ? pickedStart.getTime() : pickedStart;
  const candMs = candStart instanceof Date ? candStart.getTime() : candStart;
  const diffMin = Math.abs(candMs - pickedMs) / 60_000;

  const p = normalizeTrack(pickedTrack);
  const c = normalizeTrack(candTrack);
  const sameTrack = p !== "" && p === c;

  if (sameTrack) {
    const gap = TRACK_ADJACENT_GAP_MIN[p] ?? FALLBACK_SAME_TRACK_MIN;
    return diffMin < gap;
  }
  return diffMin < CROSS_TRACK_MIN_GAP_MIN;
}

/** Short human-readable explainer for a conflict's source, for tooltips. */
export const HEAT_CONFLICT_TOOLTIP =
  "Pick a different heat — this one's too close. Same-track heats need to skip at least one slot between them, and jumping between tracks needs 30 minutes to walk across and check in.";

/** Tooltip variant when the blocking heat lives in a PRIOR reservation (the
 *  cross-reservation spacing signal), not the current cart. */
export const EXISTING_RESERVATION_CONFLICT_TOOLTIP =
  "A racer in your group already has a race reserved too close to this time. Same-track heats need to skip at least one slot between them, and jumping between tracks needs 30 minutes to walk across and check in.";

/**
 * Package heat-gap rule: candidate must start at least `minutes` after
 * a previously-picked component finished. Used by v1's Ultimate Qualifier
 * package to enforce "Intermediate must start ≥ 60 min after Starter ends"
 * (qualifying race + buffer for video review).
 *
 * v2 ports this as-is because the multi-heat 3-pack day-of products use
 * the same primitive at confirmation time.
 *
 * @param prevStop  ISO string or epoch ms of the previous heat's STOP time
 * @param candStart ISO string or epoch ms of the candidate heat's START
 * @param minutes   minimum gap in minutes
 * @returns true when the candidate violates the gap (i.e. is too soon)
 */
export function violatesMinGapAfter(
  prevStop: string | number | Date,
  candStart: string | number | Date,
  minutes: number,
): boolean {
  const prevMs =
    typeof prevStop === "string"
      ? Date.parse(prevStop)
      : prevStop instanceof Date
        ? prevStop.getTime()
        : prevStop;
  const candMs =
    typeof candStart === "string"
      ? Date.parse(candStart)
      : candStart instanceof Date
        ? candStart.getTime()
        : candStart;
  if (!Number.isFinite(prevMs) || !Number.isFinite(candMs)) return false;
  return candMs < prevMs + minutes * 60_000;
}

/**
 * Effective package gap for ONE candidate heat: `sameTrackMinutes` when the
 * candidate runs on the SAME track as the referenced pick, otherwise the base
 * `minutes`. Tracks are compared with the same normalizer `heatsConflict` uses
 * ("Blue Track" ≡ "Blue"); an empty/unknown track on either side counts as a
 * track CHANGE and keeps the stricter number.
 *
 * Owner rule 2026-08-04: the Ultimate Qualifier's 60-min Starter→Intermediate
 * buffer covers qualifying, the POV review AND the walk to the
 * other track. Staying on one track drops the walk, so same-track pairs only
 * need 30. Rules without `sameTrackMinutes` stay track-agnostic.
 */
export function packageGapMinutesFor(
  rule: { minutes: number; sameTrackMinutes?: number },
  refTrack: string | null | undefined,
  candidateTrack: string | null | undefined,
): number {
  if (rule.sameTrackMinutes === undefined) return rule.minutes;
  const a = normalizeTrack(refTrack);
  const b = normalizeTrack(candidateTrack);
  return a !== "" && a === b ? rule.sameTrackMinutes : rule.minutes;
}

/** Short tooltip explainer for the package gap rule. The component fills
 *  in the actual minutes / qualifier label at render time. */
export function packageGapTooltip(minutes: number, refLabel: string): string {
  return `Available ${minutes} min after your ${refLabel} ends — gives you time to qualify and review your POV video.`;
}

// ── Cross-reservation spacing ────────────────────────────────────────────
//
// The rules above only see the CURRENT cart, so a racer could dodge them by
// booking each heat in a separate reservation. Every booked heat is persisted
// to Neon with its racer's bmiPersonId (booking_metadata.heats), and the
// reserve guard + heat picker run the SAME spacing rules against the union of
// cart heats and the party's already-booked same-day heats. Matching is by
// bmiPersonId, so this covers identified racers (returning racers, and a new
// racer's later bookings once they come back through the returning lookup) —
// a person who re-registers as new with fresh details gets a duplicate BMI
// person and is not matched (accepted limitation, owner 2026-07-02).

/** One heat tied to a specific racer, cart-side or already booked. */
export interface BookedPersonHeat {
  /** Naive center-local start string, e.g. "2026-07-02T15:36:00". */
  heatId: string;
  track: string | null;
  /** BMI personId as a STRING (never Number() a BMI id). Null = unidentified. */
  bmiPersonId: string | null;
  /** Racer first name when known — used in the rejection message. */
  racer?: string | null;
}

/**
 * First cart heat that violates the spacing rules against a heat the SAME
 * person already holds in another reservation, or null. Heats without a
 * bmiPersonId are skipped (no identity to match). An identical start on the
 * same track still conflicts (diff 0 < gap) — the same person double-booking
 * one heat through two reservations is also a dodge. Callers must exclude the
 * current bill's own reservation from `existingHeats` (retries would otherwise
 * self-conflict).
 */
export function findCrossBookingConflict(
  cartHeats: BookedPersonHeat[],
  existingHeats: BookedPersonHeat[],
): { cart: BookedPersonHeat; existing: BookedPersonHeat } | null {
  for (const c of cartHeats) {
    if (!c.bmiPersonId || !c.heatId) continue;
    const cMs = Date.parse(c.heatId.replace(/Z$/, ""));
    if (!Number.isFinite(cMs)) continue;
    for (const e of existingHeats) {
      if (!e.bmiPersonId || e.bmiPersonId !== c.bmiPersonId || !e.heatId) continue;
      const eMs = Date.parse(e.heatId.replace(/Z$/, ""));
      if (!Number.isFinite(eMs)) continue;
      if (heatsConflict(cMs, c.track, eMs, e.track)) return { cart: c, existing: e };
    }
  }
  return null;
}

// ── Cross-category same-slot (adults vs juniors) ─────────────────────────
//
// Adult and junior races are DIFFERENT BMI products, so BMI happily sells
// both into one physical session — and nothing above catches it because every
// rule here is per-racer ("different racers never conflict"). Owner rule
// (2026-07-19): within one booking session, an adult heat and a junior heat
// may not share the SAME TRACK + SAME START (a physical double-book — "if
// adults select 3pm on Blue, obviously a junior race can't be at 3pm").
// Same wall-clock time on a DIFFERENT track is allowed. Symmetric: it fires
// whichever category picks second, and counts already-booked heats (the
// kiosk books each leg eagerly on advance).

/** One cart heat with the fields the cross-category rule needs. */
export interface CategoryTrackHeat {
  /** Naive center-local start string, e.g. "2026-07-02T15:36:00". */
  heatId: string | null;
  track: string | null;
  category?: "adult" | "junior" | null;
}

/** Canonical (track|start) key — case-insensitive track, trailing "Track"
 *  word stripped ("Blue Track" ≡ "Blue"), Z/millis stripped off the start. */
function trackStartKey(track: string | null | undefined, heatId: string): string {
  const t = (track ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]*track$/, "");
  const start = heatId.replace(/\.\d+/, "").replace(/Z$/, "");
  return `${t}|${start}`;
}

/**
 * First (track, start) slot held by BOTH an adult and a junior heat, or null.
 * Missing category defaults to "adult" (mirrors the party/heat defaults).
 */
export function findCrossCategorySameStart(
  heats: CategoryTrackHeat[],
): { start: string; track: string | null } | null {
  const byaSlot = new Map<
    string,
    { categories: Set<string>; start: string; track: string | null }
  >();
  for (const h of heats) {
    if (!h.heatId) continue;
    const key = trackStartKey(h.track, h.heatId);
    const entry = byaSlot.get(key) ?? {
      categories: new Set<string>(),
      start: h.heatId,
      track: h.track,
    };
    entry.categories.add(h.category ?? "adult");
    byaSlot.set(key, entry);
    if (entry.categories.size > 1) return { start: entry.start, track: entry.track };
  }
  return null;
}

/** True when a candidate (track, start) collides with any OTHER-category heat
 *  in `otherCategoryHeats` — the grid grey-out predicate. */
export function collidesWithOtherCategory(
  candidateTrack: string | null | undefined,
  candidateStart: string,
  otherCategoryHeats: Array<{ heatId: string | null; track: string | null }>,
): boolean {
  const key = trackStartKey(candidateTrack, candidateStart);
  return otherCategoryHeats.some((h) => h.heatId && trackStartKey(h.track, h.heatId) === key);
}

/** Guest-readable rejection for a cross-category collision — lands verbatim in
 *  the kiosk error toast / hold-error card, so keep it self-explanatory. */
export function crossCategoryCollisionMessage(start: string, track: string | null): string {
  const where = track ? ` on the ${track} Track` : "";
  return `Adults and juniors can't share the same ${heatClockLabel(start)} heat${where} — please pick a different time for one group.`;
}

/** "2026-07-02T15:36:00" → "3:36 PM" (for rejection messages). */
export function heatClockLabel(heatId: string): string {
  const m = heatId.match(/T(\d{2}):(\d{2})/);
  if (!m) return heatId;
  const h24 = Number(m[1]);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]} ${h24 < 12 ? "AM" : "PM"}`;
}

/**
 * Helper: do any two heats in a list (same racer) conflict?
 * Pairwise check; returns the first conflict pair found, or null.
 *
 * v2 step components use this to gate Next on the heat-picker step.
 */
export function findHeatConflict<T extends { start: number | Date | string; track: string | null }>(
  heats: T[],
): { a: T; b: T } | null {
  for (let i = 0; i < heats.length; i++) {
    for (let j = i + 1; j < heats.length; j++) {
      const a = heats[i];
      const b = heats[j];
      const aStart =
        typeof a.start === "string"
          ? Date.parse(a.start)
          : a.start instanceof Date
            ? a.start.getTime()
            : a.start;
      const bStart =
        typeof b.start === "string"
          ? Date.parse(b.start)
          : b.start instanceof Date
            ? b.start.getTime()
            : b.start;
      if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) continue;
      if (heatsConflict(aStart, a.track, bStart, b.track)) return { a, b };
    }
  }
  return null;
}
