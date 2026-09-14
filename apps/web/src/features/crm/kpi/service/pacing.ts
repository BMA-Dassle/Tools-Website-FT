/**
 * The pacing series — cumulative BOOKED value by day, this window against the
 * same days one year back (brief C7 Definitions: "pacing = cumulative
 * `total_value_cents` of CONFIRMED projects by `bmi_created_at` day vs the same
 * days LY").
 *
 * PURE. The caller hands in two day→cents maps; nothing here reads Neon.
 *
 * BASIS: `bmi` — BMI project totalValue. It is the only basis with a
 * like-for-like twin a year back, which is the whole point of the chart.
 *
 * Note the axis: a project counts on the day it was CREATED in Office
 * (`bmi_created_at`), not the day the event happens. "How fast are we selling
 * this month's events" is a booking-pace question, and `crm_bmi_projects` has
 * both dates so the two never get confused.
 *
 * `ty` is null for every day after today — a line that runs flat to the end of
 * the month reads as "we stopped selling", which is a lie about the future.
 */

import type { PacingPoint, PacingSeries } from "../contracts";
import { dayPairs, type DayPair } from "./windows";

export interface PacingInput {
  /** Window days, paired with their last-year twins (`dayPairs`). */
  pairs: DayPair[];
  /** YYYY-MM-DD → cents booked THAT day, this year. */
  byDay: ReadonlyMap<string, number>;
  /** YYYY-MM-DD → cents booked THAT day, last year. */
  lastYearByDay: ReadonlyMap<string, number>;
  /** Days of the window already elapsed in ET; beyond it `ty` is null. */
  elapsed: number;
  goalCents: number;
}

export function buildPacing(input: PacingInput): PacingSeries {
  const { pairs, byDay, lastYearByDay, elapsed, goalCents } = input;
  let ty = 0;
  let ly = 0;
  const points: PacingPoint[] = pairs.map((p) => {
    ly += lastYearByDay.get(p.lastYear) ?? 0;
    const reached = p.day <= elapsed;
    if (reached) ty += byDay.get(p.date) ?? 0;
    return { day: p.day, date: p.date, tyCents: reached ? ty : null, lyCents: ly };
  });
  return {
    points,
    todayDay: Math.max(0, Math.min(elapsed, pairs.length)),
    goalCents,
    days: pairs.length,
  };
}

export function pacingFor(
  window: { from: string; days: number; elapsed: number },
  byDay: ReadonlyMap<string, number>,
  lastYearByDay: ReadonlyMap<string, number>,
  goalCents: number,
): PacingSeries {
  return buildPacing({
    pairs: dayPairs(window),
    byDay,
    lastYearByDay,
    elapsed: window.elapsed,
    goalCents,
  });
}

/** The cumulative figure at `todayDay`, i.e. the tile's "Booked this month". */
export function bookedToDate(series: PacingSeries): number {
  for (let i = series.points.length - 1; i >= 0; i--) {
    const v = series.points[i].tyCents;
    if (v !== null) return v;
  }
  return 0;
}

/** Last year's cumulative on the SAME day of the window — the "vs LY" twin. */
export function lastYearToDate(series: PacingSeries): number {
  if (series.todayDay <= 0) return 0;
  return series.points[series.todayDay - 1]?.lyCents ?? 0;
}

/** Last year's finished total for the whole window. */
export function lastYearFinished(series: PacingSeries): number {
  return series.points[series.points.length - 1]?.lyCents ?? 0;
}

/**
 * What still has to be sold per remaining day to reach the goal — the pace
 * tile's sub-line. 0 once the goal is met or the window is over, so the tile
 * never asks for a negative day's work.
 */
export function neededPerDayCents(series: PacingSeries): { cents: number; days: number } {
  const days = Math.max(0, series.days - series.todayDay);
  if (days === 0) return { cents: 0, days: 0 };
  const short = series.goalCents - bookedToDate(series);
  return { cents: short > 0 ? Math.ceil(short / days) : 0, days };
}

/** Integer percent change against last year; null when LY was zero. */
export function deltaPct(now: number, lastYear: number): number | null {
  if (!lastYear) return null;
  return Math.round(((now - lastYear) / lastYear) * 100);
}

/** The median of a list of numbers, or null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
