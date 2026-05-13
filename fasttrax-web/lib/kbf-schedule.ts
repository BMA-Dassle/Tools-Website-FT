/**
 * Kids Bowl Free schedule gate.
 *
 * KBF web offers are only bookable when ALL of these hold:
 *   - Day of week is Mon–Thu (11 AM – close) or Fri (11 AM – 5 PM)
 *   - Date is on or after the program start (`KBF_PROGRAM_START_YMD`)
 *   - Date is Mon–Fri (no Sat/Sun)
 *
 * Both the date picker and the offers proxy import this so the gate
 * can't be bypassed by hand-crafting query params on /api/kbf/offers.
 *
 * All times are interpreted in America/New_York. The CSV / QAMF
 * backend live in ET and we never bowl outside of HeadPinz's
 * physical centers, so anchoring to ET is correct.
 */

const ET_TIMEZONE = "America/New_York";

/** First day the KBF program is bookable through this flow. */
export const KBF_PROGRAM_START_YMD = "2026-05-14";

/** Last day of the KBF program (inclusive). */
export const KBF_PROGRAM_END_YMD = "2026-08-28";

/** How many calendar days of bookable dates to generate for the date
 *  picker. 90 days gives ~65 weekdays. */
const KBF_DATE_PICKER_HORIZON = 90;

/** 0 = Sunday, 1 = Monday, ..., 6 = Saturday — the JS getDay()
 *  numbering used everywhere in the app. */
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Resolve the day-of-week (in ET) for a YYYY-MM-DD date string.
 * Anchor at noon UTC so DST rollovers can't bump the date by a day.
 */
export function dayOfWeekET(ymd: string): DayOfWeek {
  // Build a canonical ET-local timestamp for the noon-of-day, then
  // ask Intl what weekday that lands on. Using `weekday: "short"` +
  // a hand-rolled map avoids any locale weirdness from `getDay()`
  // running against a UTC instant.
  const utcNoon = new Date(`${ymd}T17:00:00Z`); // 17:00 UTC ≈ 12:00 EST / 13:00 EDT
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    weekday: "short",
  });
  const short = fmt.format(utcNoon);
  const map: Record<string, DayOfWeek> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[short] ?? 0;
}

/**
 * Today's date in YYYY-MM-DD, in America/New_York. Used to anchor
 * the rolling booking window so the cutoff matches what the parent
 * sees on the wall clock, not server UTC.
 */
export function todayKbfYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Add `days` calendar days to a YYYY-MM-DD string. DST-safe — we
 * anchor at noon UTC, which never crosses a date boundary in ET
 * regardless of DST.
 */
export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Is this date eligible for any KBF booking at all?
 *
 * Checks: valid YYYY-MM-DD, Mon–Fri, on/after program start, not
 * in the past. No upper booking window — parents can book any
 * future weekday.
 */
export function isKbfBookableDate(ymd: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;

  // Day-of-week (Mon–Fri only)
  const dow = dayOfWeekET(ymd);
  if (dow < 1 || dow > 5) return false;

  // On or after program start, on or before program end
  if (ymd < KBF_PROGRAM_START_YMD) return false;
  if (ymd > KBF_PROGRAM_END_YMD) return false;

  // Not in the past
  const today = todayKbfYmd(now);
  if (ymd < today) return false;

  return true;
}

/**
 * The list of YMD strings a parent can pick today, in display
 * order. Generates Mon–Fri dates from today through
 * `KBF_DATE_PICKER_HORIZON` days out (skips weekends and
 * pre-program dates automatically).
 */
export function bookableDateRange(now: Date = new Date()): string[] {
  const today = todayKbfYmd(now);
  const result: string[] = [];
  for (let i = 0; i <= KBF_DATE_PICKER_HORIZON; i++) {
    const ymd = addDaysYmd(today, i);
    if (isKbfBookableDate(ymd, now)) result.push(ymd);
  }
  return result;
}

/**
 * Is this exact slot start time (ISO `YYYY-MM-DDTHH:mm`, ET local)
 * within the KBF window for that day?
 *
 *   Mon–Thu — 11:00 AM to close (center close enforced by QAMF).
 *   Fri     — 11:00 AM to 5:00 PM (must start before 17:00 ET).
 *   Sat/Sun — blocked.
 */
export function isKbfBookableTime(isoLocal: string): boolean {
  const ymdMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(isoLocal);
  if (!ymdMatch) return false;
  const ymd = ymdMatch[1];
  const hour = parseInt(ymdMatch[2], 10);
  const dow = dayOfWeekET(ymd);
  if (dow === 0 || dow === 6) return false;   // Sat/Sun
  if (hour < 11) return false;                // Before 11 AM — all weekdays
  if (dow === 5) return hour < 17;            // Friday — last bookable hour is 16:xx
  return true;                                // Mon–Thu 11 AM+
}

/**
 * Friendly label for the rejected case — surfaced on the date
 * picker tooltip and on the offers-route error response. Returns
 * null if the date is bookable.
 */
export function kbfBookableReason(ymd: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "Invalid date";
  const dow = dayOfWeekET(ymd);
  if (dow === 0 || dow === 6) return "Kids Bowl Free is Mon–Fri only";
  if (ymd < KBF_PROGRAM_START_YMD) return `Kids Bowl Free starts ${KBF_PROGRAM_START_YMD}`;
  if (ymd > KBF_PROGRAM_END_YMD) return `Kids Bowl Free ended ${KBF_PROGRAM_END_YMD}`;
  const today = todayKbfYmd(now);
  if (ymd < today) return "That date has already passed";
  return null;
}

/**
 * The earliest hour-of-day a KBF reservation may start (11 AM ET).
 * Returns 11 for Mon–Fri, -1 for Sat/Sun (no slots).
 */
export function kbfEarliestStartHour(ymd: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return -1;
  const dow = dayOfWeekET(ymd);
  if (dow === 0 || dow === 6) return -1;
  return 11;
}

/**
 * The latest hour-of-day a KBF reservation may start, in 24h ET.
 * Mon–Thu = null (no per-day cap; QAMF returns center close).
 * Fri = 17 (must start before 5pm).
 * Sat/Sun = -1 (no slots).
 */
export function kbfLatestStartHour(ymd: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return -1;
  const dow = dayOfWeekET(ymd);
  if (dow === 0 || dow === 6) return -1;
  if (dow === 5) return 17;
  return null;
}
