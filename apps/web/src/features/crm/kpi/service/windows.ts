/**
 * The windows every measure screen reads over, in ET. PURE — `now` is always
 * an explicit instant, never `new Date()` inside a branch, because the runner
 * that will call these is UTC (brief §3.10: "NEVER `new Date().getHours()` on
 * the runner").
 *
 * Two shapes:
 *   KPI            a MONTH ("2026-09") or a QUARTER ("2026-Q4") of EVENT dates.
 *                  Event-date month, not booked month (brief C7 Definitions) —
 *                  a September dashboard is the September events, whenever they
 *                  were sold.
 *   Accountability an ET week, MONDAY to SUNDAY. The prototype's "Week of
 *                  Sep 7 – 13" with Saturday 2026-09-12 inside it only works on
 *                  a Monday-start week, and that is the week the floor runs on.
 *
 * "Last year" is the SAME calendar window shifted back one year and clamped to
 * a real date (29 Feb → 28 Feb), so a leap year never silently drops a day.
 */

import { daysBetweenYmd, shiftYmd, todayEasternYmd } from "~/features/crm/core/dates";
import type { AccountabilityRange, AccountabilityWindow, KpiWindow } from "../contracts";

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function monthShort(month: number): string {
  return MONTH_SHORT[Math.min(12, Math.max(1, month)) - 1];
}

export function monthLong(month: number): string {
  return MONTH_LONG[Math.min(12, Math.max(1, month)) - 1];
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "2026-09" → `{year:2026, month:9}`; null when it is not a month key. */
export function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** "2026-Q4" → `{year:2026, quarter:4}`; null when it is not a quarter key. */
export function parseQuarterKey(key: string): { year: number; quarter: number } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), quarter: Number(m[2]) };
}

export function quarterOf(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

export function monthsOfQuarter(quarter: number): number[] {
  const first = (quarter - 1) * 3 + 1;
  return [first, first + 1, first + 2];
}

/** The ET calendar month containing `now`. */
export function currentMonthKey(now: Date = new Date()): string {
  return todayEasternYmd(now).slice(0, 7);
}

/** The month after a month key ("2026-12" → "2027-01"). */
export function nextMonthKey(key: string): string {
  const p = parseMonthKey(key) ?? { year: 1970, month: 1 };
  return p.month === 12 ? `${p.year + 1}-01` : `${p.year}-${pad(p.month + 1)}`;
}

/**
 * Elapsed ET days of an inclusive window: 0 before it starts, `days` once it is
 * over, and the day-of-window otherwise (a window whose first day is today is 1
 * day elapsed, because today's bookings count).
 */
export function elapsedDays(from: string, until: string, now: Date = new Date()): number {
  const today = todayEasternYmd(now);
  if (today < from) return 0;
  if (today > until) return daysBetweenYmd(from, until);
  return daysBetweenYmd(from, today);
}

export function monthWindow(year: number, month: number, now: Date = new Date()): KpiWindow {
  const days = daysInMonth(year, month);
  const from = ymd(year, month, 1);
  const until = ymd(year, month, days);
  return {
    key: `${year}-${pad(month)}`,
    label: `${monthLong(month)} ${year}`,
    from,
    until,
    days,
    elapsed: elapsedDays(from, until, now),
    year,
    months: [month],
  };
}

export function quarterWindow(year: number, quarter: number, now: Date = new Date()): KpiWindow {
  const months = monthsOfQuarter(quarter);
  const from = ymd(year, months[0], 1);
  const lastMonth = months[2];
  const until = ymd(year, lastMonth, daysInMonth(year, lastMonth));
  return {
    key: `${year}-Q${quarter}`,
    label: `${monthShort(months[0])} – ${monthShort(lastMonth)} ${year}`,
    from,
    until,
    days: daysBetweenYmd(from, until),
    elapsed: elapsedDays(from, until, now),
    year,
    months,
  };
}

/**
 * The window a `?month=` / `?quarter=` pair asks for; the ET current month when
 * neither parses. Never throws — a hand-typed URL falls back rather than 500s.
 */
export function resolveKpiWindow(
  input: { month?: string | null; quarter?: string | null },
  now: Date = new Date(),
): KpiWindow {
  if (input.quarter) {
    const q = parseQuarterKey(input.quarter);
    if (q) return quarterWindow(q.year, q.quarter, now);
  }
  if (input.month) {
    const m = parseMonthKey(input.month);
    if (m) return monthWindow(m.year, m.month, now);
  }
  const cur = parseMonthKey(currentMonthKey(now));
  return monthWindow(cur?.year ?? new Date(now).getUTCFullYear(), cur?.month ?? 1, now);
}

/**
 * The same calendar day one year back, clamped into the month (29 Feb → 28
 * Feb). Used for both ends of the "same time last year" window and for the
 * day-by-day pacing pairs.
 */
export function lastYearYmd(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  const year = (y ?? 1970) - 1;
  const month = m ?? 1;
  const day = Math.min(d ?? 1, daysInMonth(year, month));
  return ymd(year, month, day);
}

export interface DayPair {
  /** 1-based day of the window. */
  day: number;
  /** This year's ET calendar day. */
  date: string;
  /** The same day one year back. */
  lastYear: string;
}

/** Every ET day of a window, paired with its last-year twin. */
export function dayPairs(window: Pick<KpiWindow, "from" | "days">): DayPair[] {
  const out: DayPair[] = [];
  for (let i = 0; i < window.days; i++) {
    const date = shiftYmd(window.from, i);
    out.push({ day: i + 1, date, lastYear: lastYearYmd(date) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Accountability weeks
// ---------------------------------------------------------------------------

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD (UTC-anchored at midday). */
export function dayOfWeek(value: string): number {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)).getUTCDay();
}

/** The MONDAY of the ET week containing a day. */
export function mondayOf(value: string): string {
  const dow = dayOfWeek(value);
  // Sunday (0) belongs to the week that started six days earlier, not the next.
  return shiftYmd(value, dow === 0 ? -6 : 1 - dow);
}

/** "Sep 7 – 13" · "Sep 28 – Oct 4" — the prototype's sub-line. */
export function weekLabel(from: string, until: string): string {
  const [, fm, fd] = from.split("-").map(Number);
  const [, tm, td] = until.split("-").map(Number);
  const left = `${monthShort(fm ?? 1)} ${fd}`;
  const right = fm === tm ? String(td) : `${monthShort(tm ?? 1)} ${td}`;
  return `${left} – ${right}`;
}

export function accountabilityWindow(
  range: AccountabilityRange,
  now: Date = new Date(),
): AccountabilityWindow {
  const today = todayEasternYmd(now);
  const thisMonday = mondayOf(today);
  if (range === "last") {
    const from = shiftYmd(thisMonday, -7);
    const until = shiftYmd(from, 6);
    return {
      range,
      from,
      until,
      label: `Week of ${weekLabel(from, until)}`,
      workingDaysLeft: 0,
      weeks: 1,
    };
  }
  if (range === "4w") {
    const from = shiftYmd(thisMonday, -21);
    const until = shiftYmd(thisMonday, 6);
    return {
      range,
      from,
      until,
      label: `Four weeks to ${weekLabel(until, until)}`,
      workingDaysLeft: Math.max(0, daysBetweenYmd(today, until) - 1),
      weeks: 4,
    };
  }
  const until = shiftYmd(thisMonday, 6);
  return {
    range,
    from: thisMonday,
    until,
    label: `Week of ${weekLabel(thisMonday, until)}`,
    // Days AFTER today that are still in the week — "one working day left" on a
    // Saturday means Sunday, and the banner says so.
    workingDaysLeft: Math.max(0, daysBetweenYmd(today, until) - 1),
    weeks: 1,
  };
}

/** The four ET weeks ending with the one containing `now`, oldest first. */
export function trailingWeeks(
  now: Date = new Date(),
  count = 4,
): { from: string; until: string }[] {
  const thisMonday = mondayOf(todayEasternYmd(now));
  const out: { from: string; until: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const from = shiftYmd(thisMonday, -7 * i);
    out.push({ from, until: shiftYmd(from, 6) });
  }
  return out;
}
