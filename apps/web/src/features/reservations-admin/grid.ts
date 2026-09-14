/**
 * The reservations board's GRID view — pure model. No vendor, no Neon, no
 * Redis, no clock, and nothing imported from the CRM feature, so this file is
 * safe in the client bundle.
 *
 * WHY A GRID AT ALL (owner 2026-09-14): "build a board view of this like we did
 * in CRM for availability but without the number of people, etc. If the
 * reservation is one of ours, should be able to click it as well."
 *
 * WHERE THE TRUTH COMES FROM. The rows are lanes and track resources read from
 * QAMF and BMI Office — NOT from `bowling_reservations`. Our table only learns
 * about a Conqueror front-desk booking when its lane OPENS, so leagues,
 * maintenance blocks and walk-ins that never opened are invisible to it (56 of
 * 130 rows on FM 2026-08-22 — see `crm/availability/service/qamf-grid.ts`). A
 * grid drawn from our own rows would show a half-empty Saturday night.
 *
 * Every time here is MINUTES FROM MIDNIGHT in the centre's own day, the same
 * frame the availability engine speaks. No instant crosses this boundary, so an
 * evening cannot be re-read in UTC and land on the next day (memory
 * `project_bookedat_utc_wallclock_sweep`).
 */
import type { Reservation } from "./types";
import { etWallMs } from "./format";

/** Which view the board is showing. Lives in the URL as `?layout=`. */
export type BoardLayout = "list" | "grid";

/** `?layout=grid` → "grid"; anything else, including absent, → "list". */
export function layoutFromParam(value: string | null | undefined): BoardLayout {
  return value === "grid" ? "grid" : "list";
}

/**
 * What a bar is. The first four mirror the availability engine's
 * `OccupancyKind`; `heat` is a racing block, which has no lane equivalent.
 *
 * Declared here rather than imported from `~/features/crm/availability` on
 * purpose: that barrel reaches redis and BMI Office, and this module renders in
 * the browser. A four-word union is a cheaper price than a server import in the
 * client bundle.
 */
export type GridBarKind = "league" | "party" | "walkin" | "maint" | "heat";

/** One drawn stretch on one row, half-open, minutes from centre-local midnight. */
export interface GridBar {
  /** Stable React key — row-scoped, so it survives a poll that reorders bars. */
  key: string;
  start: number;
  end: number;
  kind: GridBarKind;
  /** What the VENDOR calls it. The board prefers our own guest name when the
   *  bar matches one of our rows; this is the fallback for everyone else's. */
  label: string;
  /** QAMF's reservation id — the join key to `Reservation.qamfReservationId`.
   *  Absent for maintenance, and for a lane opened straight in Conqueror. */
  reservationId?: string;
  /** Racing only: which track resource, as a track key ("blue"/"red"/"mega"). */
  trackKey?: string;
}

export interface GridRow {
  /** Lane number as a string, or the Office resource id. */
  id: string;
  /** "12", or "Blue Track". */
  label: string;
  bars: GridBar[];
}

export interface GridSection {
  /** "Regular", "VIP", "Old Time Lanes" — or the resource name for racing. */
  name: string;
  rows: GridRow[];
}

export interface GridBounds {
  openMin: number;
  closeMin: number;
  /** Hourly tick marks, inclusive of both ends. */
  ticks: number[];
}

/**
 * `lanes`       — a QAMF lane grid was read; rows are lanes
 * `heats`       — FastTrax; rows are track resources and bars are heat blocks
 * `unavailable` — the vendor could not be reached. The screen says so rather
 *                 than drawing an empty grid, which would read as "quiet night"
 */
export type GridSource = "lanes" | "heats" | "unavailable";

export interface ReservationGridData {
  source: GridSource;
  /** One sentence for the banner when `source` is "unavailable". */
  error?: string;
  centre: string;
  centreShort: string;
  date: string;
  bounds: GridBounds;
  sections: GridSection[];
  /** ISO instant the vendor was read, and whether it came off the 60 s cache. */
  readAt: string;
  cached: boolean;
}

/** The day the grid falls back to when a centre has nothing booked at all. */
export const DEFAULT_OPEN_MIN = 10 * 60;
export const DEFAULT_CLOSE_MIN = 24 * 60;

/** Never draw an axis narrower than this, or one bar fills the whole width. */
export const MIN_SPAN_MINUTES = 120;

/** Hourly ticks across a span, inclusive of both ends. */
export function ticksBetween(bounds: { openMin: number; closeMin: number }): number[] {
  const out: number[] = [];
  const first = Math.ceil(bounds.openMin / 60) * 60;
  for (let t = first; t <= bounds.closeMin; t += 60) out.push(t);
  return out;
}

/**
 * The drawn day: the hour before the first bar to the hour after the last.
 *
 * Fitted to the data rather than fixed to an "evening", because this board is
 * read at 9 AM for a school group as often as at 9 PM for a league. An empty
 * day still gets a real axis so the grid does not collapse to a sliver.
 */
export function boundsForSections(sections: readonly GridSection[]): GridBounds {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const section of sections) {
    for (const row of section.rows) {
      for (const bar of row.bars) {
        if (bar.start < min) min = bar.start;
        if (bar.end > max) max = bar.end;
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const fallback = { openMin: DEFAULT_OPEN_MIN, closeMin: DEFAULT_CLOSE_MIN };
    return { ...fallback, ticks: ticksBetween(fallback) };
  }
  let openMin = Math.max(0, Math.floor(min / 60) * 60);
  let closeMin = Math.min(24 * 60, Math.ceil(max / 60) * 60);
  if (closeMin - openMin < MIN_SPAN_MINUTES) {
    // Widen around the middle, then push back inside the day if that overflowed.
    const pad = Math.ceil((MIN_SPAN_MINUTES - (closeMin - openMin)) / 2 / 60) * 60;
    openMin = Math.max(0, openMin - pad);
    closeMin = Math.min(24 * 60, closeMin + pad);
    if (closeMin - openMin < MIN_SPAN_MINUTES) {
      if (openMin === 0) closeMin = Math.min(24 * 60, MIN_SPAN_MINUTES);
      else openMin = Math.max(0, closeMin - MIN_SPAN_MINUTES);
    }
  }
  return { openMin, closeMin, ticks: ticksBetween({ openMin, closeMin }) };
}

/** Where a minute falls across the drawn day, 0-100. */
export function pctOf(minute: number, bounds: { openMin: number; closeMin: number }): number {
  const span = bounds.closeMin - bounds.openMin;
  if (span <= 0) return 0;
  const clamped = Math.min(Math.max(minute, bounds.openMin), bounds.closeMin);
  return ((clamped - bounds.openMin) / span) * 100;
}

/** A bar's left/width as percentages of the drawn day. */
export function barGeometry(
  bar: { start: number; end: number },
  bounds: { openMin: number; closeMin: number },
): { left: number; width: number } {
  const left = pctOf(bar.start, bounds);
  const right = pctOf(bar.end, bounds);
  return { left, width: Math.max(0, right - left) };
}

/** `990` → `"4:30 PM"`. */
export function fmtMinuteOfDay(minutes: number): string {
  const hh = Math.floor(minutes / 60) % 24;
  const mm = Math.round(minutes) % 60;
  const ap = hh >= 12 ? "PM" : "AM";
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ap}`;
}

/**
 * Minutes from centre-local midnight for a naive-or-zoned ISO.
 *
 * `etWallMs` already normalises both shapes (race heat ids are naive ET;
 * bowling `booked_at` carries an offset) into one ET-wall-clock frame, so the
 * subtraction below is doing arithmetic on two values from the SAME frame —
 * which is the whole reason a browser in another timezone gets this right.
 */
export function minutesFromEtMidnight(iso: string, dateYmd: string): number | null {
  const ms = etWallMs(iso);
  const dayMs = Date.parse(`${dateYmd}T00:00:00Z`);
  if (!Number.isFinite(ms) || !Number.isFinite(dayMs)) return null;
  return Math.round((ms - dayMs) / 60_000);
}

/** `"Starter Race Blue"` / `"Blue Track"` → `"blue"`. Mirrors `trackKeyFromName`. */
export function trackKeyOf(name: string | null | undefined): string | null {
  const m = (name ?? "").match(/\b(red|blue|mega)\b/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Our reservations indexed by QAMF reservation id — how a lane bar learns it is
 * ours.
 *
 * Case-folded because QAMF ids are echoed back in mixed case by different reads
 * (the webhook stores what it was sent; `reservations/search` answers with its
 * own casing), and a bar that fails to match is silently un-clickable — the
 * exact failure this board exists to prevent.
 */
export function laneMatchIndex(reservations: readonly Reservation[]): Map<string, Reservation> {
  const out = new Map<string, Reservation>();
  for (const r of reservations) {
    if (r.qamfReservationId) out.set(r.qamfReservationId.toLowerCase(), r);
  }
  return out;
}

/**
 * Every `<trackKey>@<startMinute>` a race leg occupies.
 *
 * `liveHeats` wins when present: it is re-read from the BMI bill overview, so
 * an office reschedule that moved a heat after booking is reflected, while
 * `booking_metadata` still holds the time stamped at checkout. Trusting the
 * stale one would draw the party on a heat they are no longer in.
 */
export function heatMatchKeys(r: Reservation, dateYmd: string): string[] {
  const out: string[] = [];
  const push = (name: string | null | undefined, iso: string | null | undefined) => {
    if (!iso) return;
    const track = trackKeyOf(name);
    const minute = minutesFromEtMidnight(iso, dateYmd);
    if (track == null || minute == null) return;
    out.push(`${track}@${minute}`);
  };
  if (r.liveHeats?.length) {
    for (const h of r.liveHeats) push(h.name, h.start);
    if (out.length) return out;
  }
  for (const h of r.bookingMetadata?.heats ?? []) push(h.track, h.heatId);
  return out;
}

/** Race legs indexed by `<trackKey>@<startMinute>` — how a heat bar learns it is ours. */
export function heatMatchIndex(
  reservations: readonly Reservation[],
  dateYmd: string,
): Map<string, Reservation> {
  const out = new Map<string, Reservation>();
  for (const r of reservations) {
    for (const key of heatMatchKeys(r, dateYmd)) {
      // First writer wins: two legs of one combo can share a heat, and the
      // earlier row in the board's own order is the one its list shows.
      if (!out.has(key)) out.set(key, r);
    }
  }
  return out;
}

/** The reservation a bar belongs to, or null when it is somebody else's. */
export function ownerOf(
  bar: GridBar,
  byQamfId: ReadonlyMap<string, Reservation>,
  byHeat: ReadonlyMap<string, Reservation>,
): Reservation | null {
  if (bar.reservationId) {
    const hit = byQamfId.get(bar.reservationId.toLowerCase());
    if (hit) return hit;
  }
  if (bar.trackKey) {
    const hit = byHeat.get(`${bar.trackKey}@${bar.start}`);
    if (hit) return hit;
  }
  return null;
}

/** A drawn row, or a collapsed run of rows that have nothing on them all day. */
export type GridDisplayRow =
  | { type: "row"; row: GridRow }
  | { type: "empty"; rows: GridRow[]; label: string };

/**
 * Collapse runs of completely empty rows into one band.
 *
 * Twenty identical empty lanes tell a manager nothing and push the six that are
 * busy off the screen — the same reason `EveningTimeline` collapses free lanes
 * on the availability board, and the same escape hatch ("Show every lane")
 * when somebody needs the full grid.
 *
 * A run is only collapsed when it is worth collapsing: a single empty lane
 * between two busy ones stays a lane, because turning lane 14 into a band
 * labelled "14" is strictly worse than leaving it alone.
 */
export const MIN_COLLAPSE_RUN = 2;

export function collapseEmptyRows(rows: readonly GridRow[], expanded = false): GridDisplayRow[] {
  if (expanded) return rows.map((row) => ({ type: "row" as const, row }));
  const out: GridDisplayRow[] = [];
  let run: GridRow[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length < MIN_COLLAPSE_RUN) {
      for (const row of run) out.push({ type: "row", row });
    } else {
      out.push({
        type: "empty",
        rows: [...run],
        label: `${run[0].label}–${run[run.length - 1].label}`,
      });
    }
    run = [];
  };
  for (const row of rows) {
    if (row.bars.length === 0) {
      run.push(row);
      continue;
    }
    flush();
    out.push({ type: "row", row });
  }
  flush();
  return out;
}

/**
 * Union the stretches of ONE booking on ONE row into a single bar.
 *
 * A running session appears twice in the vendor read by design: the schedule
 * knows its booked window, and the live floor read holds the lane from `now` to
 * that window's end plus turnaround (`lane-plan/grid.server.ts`). Both carry the
 * same reservation id and different labels, so `mergeAdjacent` — which keys on
 * the label — correctly leaves them apart for the availability screen, where two
 * overlapping busy stretches are still just "busy". Here they would draw as two
 * bars for one guest, so they are coalesced into the span they jointly cover.
 *
 * Bars with no reservation id are left exactly as they are: two unidentified
 * walk-ins on one lane are two different parties, and fusing them would invent
 * a booking that does not exist.
 */
export function coalesceByReservation(bars: readonly GridBar[]): GridBar[] {
  const firstFor = new Map<string, GridBar>();
  const out: GridBar[] = [];
  for (const bar of bars) {
    if (!bar.reservationId) {
      out.push({ ...bar });
      continue;
    }
    const seen = firstFor.get(bar.reservationId);
    if (seen) {
      seen.start = Math.min(seen.start, bar.start);
      seen.end = Math.max(seen.end, bar.end);
      // The schedule's label is the guest's; the floor's is "running <id>".
      // Prefer whichever does not look like the synthetic one.
      if (/^running /.test(seen.label) && !/^running /.test(bar.label)) seen.label = bar.label;
      continue;
    }
    const copy = { ...bar };
    firstFor.set(bar.reservationId, copy);
    out.push(copy);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
