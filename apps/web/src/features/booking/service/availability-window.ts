/**
 * Pure helpers for computing the earliest allowed availability-probe time.
 *
 * Owner bug (2026-07-19): past times showed as available — e.g. the 12:00 PM
 * slot offered at 12:17 PM. Root cause: the availability route's FULL-DAY mode
 * (`buildFullDayProbeTimes`) had no "now" floor — only targeted mode clamped to
 * `now + leadMinutes` — so tier badges, the offer step's widen scan, combos and
 * the KBF admin all probed from opening time on today. Both modes now share
 * `earliestProbeMin`.
 *
 * Hour notation is the project's 0–26 ET convention: post-midnight hours
 * (12 AM–2 AM) are 24–26 so Fri/Sat late-night slots sort after 11 PM. An
 * operating day D with closeHour > 24 spans [D open, D+1 02:00] — so during
 * that post-midnight tail, "now" belongs to YESTERDAY's operating day, not
 * today's calendar date.
 */

/** Snap minutes-from-midnight UP to the next quarter hour (QAMF rejects
 *  minutes not divisible by 5; probes run on a 15-min grid). */
export function snapUp15(min: number): number {
  return Math.ceil(min / 15) * 15;
}

/** Add n days to a YYYY-MM-DD string (calendar arithmetic, TZ-free). */
export function addDaysYmd(ymd: string, n: number): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(y, mo - 1, d + n, 12);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** Current ET calendar date + minutes since midnight, for feeding
 *  `earliestProbeMin`. Impure only in reading the clock. */
export function etNowDateAndMinutes(now: Date = new Date()): {
  nowDateEt: string;
  nowMinutesEt: number;
} {
  const nowDateEt = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone: "America/New_York",
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { nowDateEt, nowMinutesEt: h * 60 + m };
}

export interface EarliestProbeMinInput {
  /** The operating date being probed (YYYY-MM-DD). */
  startDate: string;
  /** Current ET calendar date (YYYY-MM-DD). */
  nowDateEt: string;
  /** Current ET minutes since midnight (0–1439). */
  nowMinutesEt: number;
  /** Center opening hour for startDate, 0–26 notation. */
  openHour: number;
  /** Center closing hour for startDate, 0–26 notation (26 = 2 AM next day). */
  closeHour: number;
  /** How close to "now" a today-probe may start (0 = ASAP walk-up kiosks). */
  leadMinutes: number;
}

/**
 * Earliest allowed probe time for `startDate`, as minutes-from-midnight in
 * 0–26h notation, snapped up to the 15-min grid. Returns `closeHour*60 + 1`
 * when the whole operating day is already past (callers generate no probes).
 *
 * Cases:
 * - future date → opening time
 * - today, during/after opening → now + lead
 * - today, before 6 AM → startDate's day-part hasn't begun (a pre-6AM "now"
 *   is the PREVIOUS operating day's tail) → opening time
 * - yesterday's date, now in its post-midnight tail (now < 6 AM and the day
 *   closes past midnight) → now+24h + lead, so only 24–26h slots survive
 * - otherwise-past date → sentinel past-close value
 */
export function earliestProbeMin({
  startDate,
  nowDateEt,
  nowMinutesEt,
  openHour,
  closeHour,
  leadMinutes,
}: EarliestProbeMinInput): number {
  const base = openHour * 60;
  const dayIsOver = closeHour * 60 + 1;

  if (nowDateEt < startDate) return base; // future date

  if (nowDateEt === startDate) {
    // Pre-6AM on the same calendar date = the previous operating day's tail;
    // startDate's own day-part hasn't opened yet. (The old inline logic
    // shifted +24h here whenever closeHour > 24, wrongly flooring most of
    // the NEXT day's slots when browsing at 00:30 on a weekend.)
    if (nowMinutesEt < 360) return base;
    const floored = snapUp15(nowMinutesEt + leadMinutes);
    return Math.max(base, floored);
  }

  if (nowDateEt === addDaysYmd(startDate, 1) && nowMinutesEt < 360) {
    // We're inside startDate's post-midnight tail (if it has one).
    if (closeHour <= 24) return dayIsOver;
    const floored = snapUp15(nowMinutesEt + 24 * 60 + leadMinutes);
    return Math.max(base, floored);
  }

  return dayIsOver; // startDate's operating day is fully past
}
