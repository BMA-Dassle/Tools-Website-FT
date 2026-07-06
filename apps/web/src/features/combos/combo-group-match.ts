/**
 * VIP combo group matching — CLIENT-SAFE (types + pure matchers only; the
 * Neon query lives in combo-existing.server.ts so client bundles never pull
 * the DB lib).
 *
 * When a VIP combo is already booked on a date, later bookings should land on
 * the SAME schedule so staff can walk both groups from FastTrax to HeadPinz
 * together (owner 2026-07-06: default + highlight — the matching start tile
 * is flagged and emphasized, everything else stays bookable). Matching
 * prefers the EXACT anchor heat (same Starter session → same race-1 end →
 * same lane start); a same-clock-hour cell is only a "near" match — a
 * different heat within the hour drifts the bowling start by up to ~48 min.
 */

/** One existing VIP combo group on a date — no PII (public endpoint). */
export interface ComboExistingGroup {
  /** Earliest Starter heat of the group — naive ET wall-clock ISO (heatId form). */
  anchorHeatIso: string;
  /** ET hour of the anchor in 0–26 chip notation, matching combo startHours. */
  startHour: number;
  /** Anchor heat's track ("Red" | "Blue" | "Mega"), when recorded. */
  track: string | null;
  /** Bowling leg start (naive ET wall-clock ISO), when present. */
  bowlingStartIso: string | null;
  partySize: number | null;
}

export interface ComboExistingResponse {
  groups: ComboExistingGroup[];
}

export type ComboGroupMatch = { kind: "exact" | "same-hour"; group: ComboExistingGroup };

/** A start-grid cell reduced to what matching needs. */
export interface MatchableCell {
  /** Stable key the caller uses to look the verdict back up. */
  key: string;
  /** The cell's anchor heat start — either vendor's ISO form. */
  anchorStartIso: string;
  track: string | null;
  /** ET hour (0–26 chip notation) of the cell, null for un-gridded combos. */
  hour: number | null;
  anchorStartMs: number;
  /** Only feasible cells can be recommended. */
  feasible: boolean;
}

/** ET hour of a naive wall-clock ISO in the combo grid's 0–26 chip notation. */
export function chipHourOfIso(iso: string): number {
  const h = Number(iso.slice(11, 13));
  return h < 6 ? h + 24 : h;
}

/** Wall-clock identity to the minute, ignoring vendor TZ suffix differences. */
function wallClockKey(iso: string): string {
  return iso
    .replace(/Z$/, "")
    .replace(/[+-]\d{2}:\d{2}$/, "")
    .slice(0, 16);
}

function isExact(
  cell: { anchorStartIso: string; track: string | null },
  group: ComboExistingGroup,
): boolean {
  return (
    wallClockKey(cell.anchorStartIso) === wallClockKey(group.anchorHeatIso) &&
    (group.track == null || (cell.track ?? "").toLowerCase() === group.track.toLowerCase())
  );
}

/**
 * Classify one booking/cell against the day's existing groups — used by the
 * staff email (and as the per-cell primitive). "exact" = same anchor heat
 * (+track when known); "same-hour" = same start hour, different heat; null =
 * no group shares the hour.
 */
export function classifyGroupMatch(
  cell: { anchorStartIso: string; track: string | null; hour: number | null },
  groups: ComboExistingGroup[],
): ComboGroupMatch | null {
  for (const group of groups) if (isExact(cell, group)) return { kind: "exact", group };
  for (const group of groups)
    if (cell.hour != null && cell.hour === group.startHour) return { kind: "same-hour", group };
  return null;
}

/**
 * Match a whole start grid against the day's existing groups. Per group:
 * every feasible EXACT cell is badged; only when no exact cell exists does
 * ONE same-hour cell get the softer "near" badge (prefer the group's track,
 * then the heat nearest the group's anchor) — steering everyone onto a single
 * tile is the point. Exact badges always win over same-hour ones.
 */
export function matchGridToGroups(
  cells: MatchableCell[],
  groups: ComboExistingGroup[],
): Map<string, ComboGroupMatch> {
  const out = new Map<string, ComboGroupMatch>();
  const needSameHour: ComboExistingGroup[] = [];
  for (const group of groups) {
    const exact = cells.filter((c) => c.feasible && isExact(c, group));
    if (exact.length) {
      for (const c of exact) out.set(c.key, { kind: "exact", group });
    } else {
      needSameHour.push(group);
    }
  }
  for (const group of needSameHour) {
    const groupAnchorMs = new Date(wallClockKey(group.anchorHeatIso)).getTime();
    const candidates = cells
      .filter((c) => c.feasible && c.hour != null && c.hour === group.startHour && !out.has(c.key))
      .sort((a, b) => {
        const aTrack = (a.track ?? "").toLowerCase() === (group.track ?? "").toLowerCase() ? 0 : 1;
        const bTrack = (b.track ?? "").toLowerCase() === (group.track ?? "").toLowerCase() ? 0 : 1;
        return (
          aTrack - bTrack ||
          Math.abs(a.anchorStartMs - groupAnchorMs) - Math.abs(b.anchorStartMs - groupAnchorMs)
        );
      });
    if (candidates[0]) out.set(candidates[0].key, { kind: "same-hour", group });
  }
  return out;
}
