/**
 * Eastern-time date helpers for the CRM — thin wrappers over the web-sales
 * helpers (brief R10: ET calendar days from `~/features/web-sales`; store UTC
 * `timestamptz`, render ET; never local-`Date` arithmetic on event dates).
 *
 * Everything that formats takes an explicit instant or YYYY-MM-DD and formats
 * it IN America/New_York, so a Vercel function (UTC) and a rep's laptop agree.
 */

import {
  daysBetweenYmd,
  easternRangeToUtc,
  shiftYmd,
  todayEasternYmd,
} from "~/features/web-sales/service/dates";

export { daysBetweenYmd, easternRangeToUtc, shiftYmd, todayEasternYmd };

export const ET = "America/New_York";

function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, ...opts });
}

const F_DATE = fmt({ weekday: "short", month: "short", day: "numeric" });
const F_DATE_Y = fmt({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
const F_MONTH = fmt({ month: "long", year: "numeric" });
const F_TIME = fmt({ hour: "numeric", minute: "2-digit" });
const F_STAMP = fmt({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A YYYY-MM-DD as an instant at ET midday — safe to format in any zone. */
export function ymdToInstant(ymd: string): Date {
  return new Date(`${ymd}T12:00:00${etOffsetFor(ymd)}`);
}

/** The real ET offset on a given calendar day (same technique as web-sales). */
export function etOffsetFor(ymd: string): "-04:00" | "-05:00" {
  const midday = new Date(`${ymd}T17:00:00Z`);
  const short = new Intl.DateTimeFormat("en-US", { timeZone: ET, timeZoneName: "short" }).format(
    midday,
  );
  return short.includes("EDT") ? "-04:00" : "-05:00";
}

function toDate(value: string | Date): Date {
  if (value instanceof Date) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? ymdToInstant(value) : new Date(value);
}

/** `Sat, Oct 17` */
export function fDate(value: string | Date): string {
  return F_DATE.format(toDate(value));
}

/** `Sat, Oct 17, 2026` */
export function fDateY(value: string | Date): string {
  return F_DATE_Y.format(toDate(value));
}

/** `October 2026` */
export function fMonth(value: string | Date): string {
  return F_MONTH.format(toDate(value));
}

/** `7:30 PM` in ET. */
export function fTime(value: string | Date): string {
  return F_TIME.format(toDate(value));
}

/** `Sep 12, 7:30 PM` in ET — timeline stamps. */
export function fStamp(value: string | Date): string {
  return F_STAMP.format(toDate(value));
}

/** `2026-10-17` → `2026-10` (the party month the standard rule balances on). */
export function monthKey(ymd: string): string {
  return ymd.slice(0, 7);
}

/** Calendar days from ET-today to an event date; negative when it is past. */
export function daysOut(eventYmd: string, now: Date = new Date()): number {
  return daysBetweenYmd(todayEasternYmd(now), eventYmd) - 1;
}

/** Whole minutes since an instant. */
export function ageMinutes(iso: string | Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - toDate(iso).getTime()) / 60_000));
}

/** ET hour-of-day as a decimal (19.5 = 7:30 PM) — what the shift rules compare. */
export function etHourOfDay(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}
