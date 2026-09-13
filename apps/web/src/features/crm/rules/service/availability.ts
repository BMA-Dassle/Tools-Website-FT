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

/** One rep's day: the merged shift window (null = not scheduled) and the off-today override. */
export interface RosterDay {
  window: ShiftWindow | null;
  off: boolean;
  offReason: string | null;
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
  if (!day || !day.window || day.off) return false;
  const h = etHourOfDay(clock.now);
  return h >= day.window.startHour && h < day.window.endHour;
}

export function nextStart(repId: string, clock: RosterClock): NextStart | null {
  const today = clock.shiftsToday[repId];
  const h = etHourOfDay(clock.now);
  if (today?.window && !today.off && h < today.window.startHour) {
    return { when: "today", hour: today.window.startHour };
  }
  const tomorrow = clock.shiftsTomorrow[repId];
  if (tomorrow?.window) return { when: "tomorrow", hour: tomorrow.window.startHour };
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

/**
 * Fold one day's rows for every rep: 7shifts rows merge into ONE window
 * (earliest start → latest end; a shift that crosses midnight ET ends at
 * `hour + 24`), manual rows carry the off-today override. A manual row with
 * `startsAt/endsAt` (a hand-entered shift) counts toward the window too.
 */
export function rosterForDate(rows: readonly ShiftRow[], ymd: string): RosterByRep {
  const out: RosterByRep = {};
  for (const r of rows) {
    if (r.shiftDate !== ymd) continue;
    const day: RosterDay = out[r.repId] ?? { window: null, off: false, offReason: null };
    if (r.startsAt && r.endsAt) {
      const startHour = hourOf(r.startsAt);
      let endHour = hourOf(r.endsAt);
      if (endHour <= startHour) endHour += 24;
      day.window = day.window
        ? {
            startHour: Math.min(day.window.startHour, startHour),
            endHour: Math.max(day.window.endHour, endHour),
          }
        : { startHour, endHour };
    }
    if (r.source === "manual" && r.offToday) {
      day.off = true;
      day.offReason = r.offReason ?? day.offReason;
    }
    out[r.repId] = day;
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
