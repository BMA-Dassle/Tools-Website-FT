/**
 * Who is on shift — the PURE half of the roster (brief B2 "onShiftNow /
 * nextStart computed in ET"). Ported from `crm-shared.js:170-173`:
 *
 *   HOUR_NOW    = ET hour-of-day as a decimal (19.5 = 7:30 PM)
 *   onShiftNow  = has a shift today, not marked off, start ≤ HOUR_NOW < end
 *   nextStart   = today's start if it is still ahead (and not off), else
 *                 tomorrow's start, else null
 *   fmtHour     = 9 → "9 AM", 12.5 → "12:30 PM", 18 → "6 PM"
 *
 * Nothing here reads a clock or Neon: `ctx.now` is an explicit instant and the
 * roster is two `RosterByRep` maps the caller built (`rosterFromShiftRows`
 * below turns `crm_shifts` rows into them). The runner is UTC in CI; every
 * hour here is ET via `etHourOfDay`.
 */

import { etHourOfDay } from "~/features/crm/core/dates";
import type { CrmRep } from "~/features/crm/core/types";

/** One shift as ET decimal hours; `endHour` > 24 when it crosses midnight. */
export interface ShiftWindow {
  startHour: number;
  endHour: number;
}

/**
 * One rep's day: the shift windows (empty = not scheduled) and the off-today
 * override.
 *
 * `window` is the HULL (earliest start → latest end) and is what the roster
 * table prints. `windows` is every distinct window, and it is what decides
 * whether someone is on shift RIGHT NOW — the two differ for the Guest
 * Services bucket, whose day is the union of a whole call-centre department's
 * shifts: 9–13 and 17–21 must not read as "on shift" at 3 PM. Older callers
 * that build a `RosterDay` by hand may omit `windows`; `dayWindows()` then
 * falls back to the hull.
 */
export interface RosterDay {
  window: ShiftWindow | null;
  windows?: ShiftWindow[];
  off: boolean;
  offReason: string | null;
}

/** Every window of a day — the hull alone when a caller supplied only that. */
export function dayWindows(day: RosterDay | undefined): ShiftWindow[] {
  if (!day) return [];
  if (day.windows && day.windows.length > 0) return day.windows;
  return day.window ? [day.window] : [];
}

/** Keyed by `crm_reps.id` (string). A missing key = nothing on file. */
export type RosterByRep = Record<string, RosterDay | undefined>;

export interface RosterClock {
  shiftsToday: RosterByRep;
  shiftsTomorrow: RosterByRep;
  now: Date;
}

export interface NextStart {
  when: "today" | "tomorrow";
  hour: number;
}

/** `crm-shared.js:171` — 9 → "9 AM", 12.5 → "12:30 PM", 0 → "12 AM", 25 → "1 AM". */
export function fmtHour(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  const whole = Math.floor(hh);
  const minutes = Math.round((hh - whole) * 60);
  const twelve = ((whole + 11) % 12) + 1;
  const mm = minutes ? `:${String(minutes).padStart(2, "0")}` : "";
  return `${twelve}${mm} ${hh >= 12 ? "PM" : "AM"}`;
}

/** `10 AM – 6 PM` for a window, or null when there is none. */
export function fmtWindow(w: ShiftWindow | null): string | null {
  return w ? `${fmtHour(w.startHour)} – ${fmtHour(w.endHour)}` : null;
}

export function isOffToday(repId: string, clock: Pick<RosterClock, "shiftsToday">): boolean {
  return clock.shiftsToday[repId]?.off === true;
}

export function onShiftNow(repId: string, clock: RosterClock): boolean {
  const day = clock.shiftsToday[repId];
  if (!day || day.off) return false;
  const h = etHourOfDay(clock.now);
  return dayWindows(day).some((w) => h >= w.startHour && h < w.endHour);
}

export function nextStart(repId: string, clock: RosterClock): NextStart | null {
  const today = clock.shiftsToday[repId];
  const h = etHourOfDay(clock.now);
  if (today && !today.off) {
    const ahead = dayWindows(today)
      .map((w) => w.startHour)
      .filter((start) => h < start)
      .sort((a, b) => a - b)[0];
    if (ahead !== undefined) return { when: "today", hour: ahead };
  }
  const tomorrow = clock.shiftsTomorrow[repId];
  const first = dayWindows(tomorrow)
    .map((w) => w.startHour)
    .sort((a, b) => a - b)[0];
  if (first !== undefined) return { when: "tomorrow", hour: first };
  return null;
}

export type RosterStatusKind = "off" | "on" | "next" | "none";

export interface RosterStatus {
  kind: RosterStatusKind;
  /** The prototype's chip/pill copy: "Off · PTO", "On shift", "Next 9 AM tomorrow", "Not scheduled". */
  label: string;
}

/** The "Status now" cell of the roster table (`crm-shared.js:454`). */
export function rosterStatus(repId: string, clock: RosterClock): RosterStatus {
  const today = clock.shiftsToday[repId];
  if (today?.off) return { kind: "off", label: `Off · ${today.offReason || "manual"}` };
  if (onShiftNow(repId, clock)) return { kind: "on", label: "On shift" };
  const n = nextStart(repId, clock);
  if (n) return { kind: "next", label: `Next ${fmtHour(n.hour)} ${n.when}` };
  return { kind: "none", label: "Not scheduled" };
}

// ---------------------------------------------------------------------------
// crm_shifts rows → RosterByRep
// ---------------------------------------------------------------------------

/** A `crm_shifts` row as the data layer hands it over (ids as strings, instants as ISO). */
export interface ShiftRow {
  id: string;
  repId: string;
  /** YYYY-MM-DD (ET business date) */
  shiftDate: string;
  startsAt: string | null;
  endsAt: string | null;
  source: "7shifts" | "manual";
  sevenShiftsShiftId: string | null;
  locationId: number | null;
  offToday: boolean;
  offReason: string | null;
  updatedBy: string | null;
  syncedAt: string | null;
}

/** ET decimal hour of an instant, as `etHourOfDay` gives it. */
function hourOf(iso: string): number {
  return etHourOfDay(new Date(iso));
}

/** Overlapping or touching windows collapse; the rest stay separate, earliest first. */
export function mergeWindows(windows: readonly ShiftWindow[]): ShiftWindow[] {
  const sorted = [...windows].sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
  const out: ShiftWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.startHour <= last.endHour) {
      last.endHour = Math.max(last.endHour, w.endHour);
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * Fold one day's rows for every rep: every shift row contributes a window (a
 * shift that crosses midnight ET ends at `hour + 24`), overlapping ones merge,
 * and `window` is the hull the roster table prints. Manual rows carry the
 * off-today override; a manual row with `startsAt/endsAt` (a hand-entered
 * shift) counts toward the windows too.
 *
 * The Guest Services bucket is the reason `windows` is a list: its rows are a
 * whole department's shifts, so it can be on at 10 AM, off at 3 PM and on
 * again at 6 PM. Collapsing that to one 9–21 window would tell the engine the
 * call centre is staffed when nobody is.
 */
export function rosterForDate(rows: readonly ShiftRow[], ymd: string): RosterByRep {
  const raw = new Map<string, { windows: ShiftWindow[]; off: boolean; offReason: string | null }>();
  for (const r of rows) {
    if (r.shiftDate !== ymd) continue;
    const day = raw.get(r.repId) ?? { windows: [], off: false, offReason: null };
    if (r.startsAt && r.endsAt) {
      const startHour = hourOf(r.startsAt);
      let endHour = hourOf(r.endsAt);
      if (endHour <= startHour) endHour += 24;
      day.windows.push({ startHour, endHour });
    }
    if (r.source === "manual" && r.offToday) {
      day.off = true;
      day.offReason = r.offReason ?? day.offReason;
    }
    raw.set(r.repId, day);
  }

  const out: RosterByRep = {};
  for (const [repId, day] of raw) {
    const windows = mergeWindows(day.windows);
    const first = windows[0];
    const last = windows[windows.length - 1];
    out[repId] = {
      window: first && last ? { startHour: first.startHour, endHour: last.endHour } : null,
      windows,
      off: day.off,
      offReason: day.offReason,
    };
  }
  return out;
}

export interface RosterWindow {
  todayYmd: string;
  tomorrowYmd: string;
}

/** Both maps at once — what `loadEngineContext` and the roster route call. */
export function rosterFromShiftRows(
  rows: readonly ShiftRow[],
  { todayYmd, tomorrowYmd }: RosterWindow,
): Pick<RosterClock, "shiftsToday" | "shiftsTomorrow"> {
  return {
    shiftsToday: rosterForDate(rows, todayYmd),
    shiftsTomorrow: rosterForDate(rows, tomorrowYmd),
  };
}

/** Reps the roster table lists: everyone but the directors (`crm-shared.js:454`). */
export function rosterReps(reps: readonly CrmRep[]): CrmRep[] {
  return reps.filter((r) => r.active && r.role !== "director");
}
