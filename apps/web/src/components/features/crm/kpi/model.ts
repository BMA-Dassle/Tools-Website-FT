/**
 * Pure geometry and labels for the three measure screens. NO React, no fetch,
 * no `~/features/crm/kpi` barrel — only the sub's `contracts` (types and the
 * basis sentences) and `core/format`, both of which are client-safe (§5.7b).
 *
 * Everything a chart needs to decide lives here so it can be TESTED: an SVG
 * that computes its own scale inside JSX is a chart nobody can assert on, and
 * the one thing that actually goes wrong with a chart is the arithmetic —
 * an axis that clips the tallest bar, a "today" marker on the wrong day, a
 * percentage that divides by zero.
 */

import { money, moneyK } from "~/features/crm/core/format";
import type {
  MonthlyGoalRow,
  PacingSeries,
  RepKpi,
  RevenueBasis,
} from "~/features/crm/kpi/contracts";
import { REVENUE_BASIS } from "~/features/crm/kpi/contracts";

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export type DeltaDirection = "up" | "down" | "flat";

export interface Delta {
  /** Whole percent, already absolute — `dir` carries the sign. */
  pct: number;
  dir: DeltaDirection;
  /** False when last year was zero: there is no percentage to show. */
  comparable: boolean;
}

/**
 * A change against last year. A ZERO denominator is not an infinite rise — it
 * is "nothing to compare with", and the tile says that instead of printing a
 * confident ▲ 100%.
 */
export function deltaOf(now: number, lastYear: number): Delta {
  if (!lastYear) return { pct: 0, dir: "flat", comparable: false };
  const raw = Math.round(((now - lastYear) / lastYear) * 100);
  return { pct: Math.abs(raw), dir: raw > 0 ? "up" : raw < 0 ? "down" : "flat", comparable: true };
}

/** "▲" / "▼" / "•" — the prototype's marks (crm-shared.js:375). */
export function deltaMark(dir: DeltaDirection): string {
  return dir === "up" ? "▲" : dir === "down" ? "▼" : "•";
}

/** `round(a / b × 100)`, 0 when there is no denominator. */
export function pctOf(a: number, b: number): number {
  if (!b) return 0;
  return Math.round((a / b) * 100);
}

// ---------------------------------------------------------------------------
// Tooltip sentences — every figure says WHICH money it is
// ---------------------------------------------------------------------------

/**
 * The `title` a tile carries. `what` names the figure, `REVENUE_BASIS[basis]`
 * names the money — the brief's "revenue has three different definitions here…
 * DOCUMENT which, on the page, where the owner can read it".
 */
export function basisTitle(what: string, basis: RevenueBasis): string {
  return `${what}\n\n${REVENUE_BASIS[basis]}`;
}

// ---------------------------------------------------------------------------
// Axis scales
// ---------------------------------------------------------------------------

/**
 * An axis maximum that is a round number and never clips the data. The
 * prototype hard-coded 125k and 180k because its data was fixed; real months
 * range from a quiet January to a December three times its size, so the axis
 * is derived — and derived UPWARD, because an axis that cuts off the tallest
 * bar is the fastest way to make a dashboard lie.
 */
export function niceMax(max: number, ticks = 5): number {
  if (!Number.isFinite(max) || max <= 0) return ticks;
  const rough = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  return step * ticks;
}

/** `ticks + 1` evenly spaced values from 0 to `max` inclusive. */
export function axisTicks(max: number, ticks = 5): number[] {
  return Array.from({ length: ticks + 1 }, (_, i) => Math.round((max * i) / ticks));
}

// ---------------------------------------------------------------------------
// Pacing chart
// ---------------------------------------------------------------------------

export interface ChartBox {
  w: number;
  h: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const PACING_BOX: ChartBox = { w: 640, h: 230, left: 52, right: 14, top: 16, bottom: 28 };

export interface PacingGeometry {
  box: ChartBox;
  max: number;
  ticks: number[];
  /** Day (1-based) → x. */
  xOf: (day: number) => number;
  /** Cents → y. */
  yOf: (cents: number) => number;
  tyPath: string;
  lyPath: string;
  areaPath: string;
  goalY: number | null;
  /** x of the "today" divider; null when the window has not started. */
  todayX: number | null;
  todayDay: number;
  tyNow: number;
  lyNow: number;
  lyFinished: number;
  /** Day numbers to print under the axis — never more than 7. */
  dayTicks: number[];
  labels: { day: string; short: string }[];
}

/** At most 7 evenly-spread day labels, always including the first and last. */
export function dayTicksFor(days: number, want = 7): number[] {
  if (days <= want) return Array.from({ length: days }, (_, i) => i + 1);
  const step = (days - 1) / (want - 1);
  const out = new Set<number>();
  for (let i = 0; i < want; i++) out.add(Math.round(1 + i * step));
  return [...out].sort((a, b) => a - b);
}

/** "Sep 3" from a YYYY-MM-DD, for an axis label. */
export function shortDay(ymd: string): string {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [, m, d] = ymd.split("-").map(Number);
  return `${MON[(m ?? 1) - 1]} ${d ?? 1}`;
}

/** A path over possibly-null values: a gap breaks the line rather than faking it. */
export function linePath(
  values: readonly (number | null)[],
  xOf: (i: number) => number,
  yOf: (v: number) => number,
): string {
  let out = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) {
      pen = false;
      return;
    }
    out += `${pen ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)} `;
    pen = true;
  });
  return out.trim();
}

export function pacingGeometry(series: PacingSeries, box: ChartBox = PACING_BOX): PacingGeometry {
  const days = Math.max(1, series.points.length);
  const peak = Math.max(
    series.goalCents,
    ...series.points.map((p) => Math.max(p.tyCents ?? 0, p.lyCents)),
    1,
  );
  const max = niceMax(peak);
  const span = Math.max(1, days - 1);
  const xOf = (day: number) => box.left + ((day - 1) / span) * (box.w - box.left - box.right);
  const yOf = (v: number) => box.top + (1 - v / max) * (box.h - box.top - box.bottom);

  const tyPath = linePath(
    series.points.map((p) => p.tyCents),
    (i) => xOf(i + 1),
    yOf,
  );
  const lyPath = linePath(
    series.points.map((p) => p.lyCents),
    (i) => xOf(i + 1),
    yOf,
  );

  const todayDay = series.todayDay;
  const todayX = todayDay > 0 ? xOf(todayDay) : null;
  const areaPath =
    tyPath && todayX !== null
      ? `${tyPath} L${todayX.toFixed(1)},${yOf(0).toFixed(1)} L${xOf(1).toFixed(1)},${yOf(0).toFixed(1)} Z`
      : "";

  const tyNow = todayDay > 0 ? (series.points[todayDay - 1]?.tyCents ?? 0) : 0;
  const lyNow = todayDay > 0 ? (series.points[todayDay - 1]?.lyCents ?? 0) : 0;
  const lyFinished = series.points[series.points.length - 1]?.lyCents ?? 0;

  return {
    box,
    max,
    ticks: axisTicks(max),
    xOf,
    yOf,
    tyPath,
    lyPath,
    areaPath,
    goalY: series.goalCents > 0 ? yOf(series.goalCents) : null,
    todayX,
    todayDay,
    tyNow,
    lyNow,
    lyFinished,
    dayTicks: dayTicksFor(days),
    labels: series.points.map((p) => ({ day: p.date, short: shortDay(p.date) })),
  };
}

/** Which day of the window an x within the plot area falls on (1-based). */
export function dayAtX(geo: PacingGeometry, x: number, days: number): number {
  const { box } = geo;
  const span = Math.max(1, days - 1);
  const raw = ((x - box.left) / (box.w - box.left - box.right)) * span + 1;
  return Math.max(1, Math.min(days, Math.round(raw)));
}

// ---------------------------------------------------------------------------
// Monthly goal chart
// ---------------------------------------------------------------------------

export const MONTHLY_BOX: ChartBox = { w: 640, h: 200, left: 46, right: 10, top: 10, bottom: 26 };

export interface MonthlyBar {
  month: number;
  label: string;
  /** x, y, width, height for each of the three marks. */
  ly: { x: number; y: number; w: number; h: number };
  goal: { x: number; y: number; w: number; h: number };
  actual: { x: number; y: number; w: number; h: number } | null;
  /** Centre of the group, for the month label. */
  cx: number;
  row: MonthlyGoalRow;
}

export interface MonthlyGeometry {
  box: ChartBox;
  max: number;
  ticks: number[];
  yOf: (v: number) => number;
  bars: MonthlyBar[];
}

export function monthlyGeometry(
  rows: readonly MonthlyGoalRow[],
  box: ChartBox = MONTHLY_BOX,
): MonthlyGeometry {
  const peak = Math.max(
    1,
    ...rows.map((r) => Math.max(r.goalCents, r.lastYearCents, r.actualCents ?? 0)),
  );
  const max = niceMax(peak, 3);
  const yOf = (v: number) => box.top + (1 - v / max) * (box.h - box.top - box.bottom);
  const base = yOf(0);
  const groupW = (box.w - box.left - box.right) / Math.max(1, rows.length);
  // A 2px surface gap between adjacent fills (marks-and-anatomy): the three
  // marks in a group are 1px apart, the groups 6px.
  const barW = Math.max(3, (groupW - 8) / 3 - 1);

  const bars: MonthlyBar[] = rows.map((row, i) => {
    const x0 = box.left + i * groupW + 4;
    const rect = (v: number, slot: number) => ({
      x: x0 + slot * (barW + 1),
      y: yOf(v),
      w: barW,
      h: Math.max(0, base - yOf(v)),
    });
    return {
      month: row.month,
      label: row.label,
      ly: rect(row.lastYearCents, 0),
      goal: rect(row.goalCents, 1),
      actual: row.actualCents === null ? null : rect(row.actualCents, 2),
      cx: x0 + (barW * 3 + 2) / 2,
      row,
    };
  });

  return { box, max, ticks: axisTicks(max, 3), yOf, bars };
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export interface SparkGeometry {
  path: string;
  lastX: number;
  lastY: number;
  w: number;
  h: number;
}

export const SPARK = { w: 72, h: 22 } as const;

/** A flat series draws a flat line through the middle, not a divide-by-zero. */
export function sparkGeometry(values: readonly number[]): SparkGeometry | null {
  if (values.length < 2) return null;
  const { w, h } = SPARK;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const xOf = (i: number) => (i / (values.length - 1)) * (w - 4) + 2;
  const yOf = (v: number) => 2 + (1 - (v - min) / range) * (h - 4);
  const path = values
    .map((v, i) => `${i ? "L" : "M"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");
  return {
    path,
    lastX: xOf(values.length - 1),
    lastY: yOf(values[values.length - 1]),
    w,
    h,
  };
}

// ---------------------------------------------------------------------------
// Screen-level derivations
// ---------------------------------------------------------------------------

/** "September 2026 · All salespeople · 12 of 30 days" (the prototype's sub-line). */
export function kpiSubtitle(
  windowLabel: string,
  who: string,
  elapsed: number,
  days: number,
): string {
  return `${windowLabel} · ${who} · ${elapsed} of ${days} days`;
}

/**
 * What still has to be sold per remaining day. Mirrors the server's
 * `neededPerDayCents` so the tile and the pacing card cannot disagree; both
 * return zero days once the window is over rather than dividing by it.
 */
export function needPerDay(
  team: RepKpi,
  elapsed: number,
  days: number,
): { cents: number; days: number } {
  const left = Math.max(0, days - elapsed);
  if (left === 0) return { cents: 0, days: 0 };
  const short = team.goalCents - team.bookedCents;
  return { cents: short > 0 ? Math.ceil(short / left) : 0, days: left };
}

/** "$1,240/day for 18 days" · "Goal met" when there is nothing left to sell. */
export function needLabel(need: { cents: number; days: number }): string {
  if (need.days === 0) return "Window closed";
  if (need.cents === 0) return "Goal met — everything else is upside";
  return `Need ${money(need.cents)}/day for ${need.days} ${need.days === 1 ? "day" : "days"}`;
}

/** "46 web · 22 last-year · 34 cold" — the leads tile's sub-line. */
export function sourceSummary(rows: readonly { label: string; leads: number }[]): string {
  const shown = rows.filter((r) => r.leads > 0).slice(0, 4);
  if (shown.length === 0) return "No leads captured in this window";
  return shown.map((r) => `${r.leads} ${r.label.toLowerCase()}`).join(" · ");
}

/**
 * The attribution line under the tiles. Silence when everything matched — a
 * line that is always there is a line nobody reads — and an explicit count of
 * what could not be attributed when it could not, because those projects are
 * in the team total and in nobody's row.
 */
export function attributionNote(c: {
  projects: number;
  exact: number;
  fuzzy: number;
  none: number;
}): string | null {
  if (c.projects === 0) return null;
  const parts: string[] = [];
  if (c.none > 0) parts.push(`${c.none} in no salesperson's row`);
  if (c.fuzzy > 0) parts.push(`${c.fuzzy} matched by name, not by Office user id`);
  if (parts.length === 0) return null;
  return `Of ${c.projects} projects in this window, ${parts.join(" and ")}. They are counted in the team total.`;
}

/** A minutes figure as the prototype prints it: "38 min" · "2 h 10 m". */
export function responseLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} m` : `${h} h`;
}

export { money, moneyK };
