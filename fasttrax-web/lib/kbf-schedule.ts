/**
 * Kids Bowl Free schedule gate.
 *
 * KBF web offers are only bookable when ALL of these hold:
 *   - Day of week is Mon–Thu (open-to-close) or Fri (until 5pm)
 *   - Date is on or after the program start (`KBF_PROGRAM_START_YMD`)
 *   - Date is within the rolling booking window — today through
 *     today + `KBF_MAX_DAYS_AHEAD` days (inclusive). Booking any
 *     further out is blocked so families don't snipe slots weeks
 *     in advance.
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

/** Max number of days ahead a parent can book. 2 means today, +1, +2
 *  are all bookable. Centralized here so we can tune it without
 *  hunting through routes. */
export const KBF_MAX_DAYS_AHEAD = 2;

/** 0 = Sunday, 1 = Monday, ..., 6 = Saturday — the JS getDay()
 *  numbering used everywhere in the app. */
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Resolve the day-of-week (in ET) for a YYYY-MM-DD date string.
 * Anchor at noon UTC so DST rollovers can't bump the date by a day.
 */
function dayOfWeekET(ymd: string): DayOfWeek {
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
 * Pre-launch carve-out — while we're still before opening day, parents
 * can book the **opening week** (the first two bookable program days)
 * even though those dates are outside the normal 2-day rolling window.
 * One-time accommodation so the program isn't starved of reservations
 * during week one. The UI surfaces a banner that makes it clear this
 * is special and the regular rule is "48 hours in advance."
 *
 * Returns the list of YMD strings inside the opening-week window —
 * the program start day plus the next bookable (Mon–Fri) day. Sat/Sun
 * are skipped automatically so the second day is always actually
 * bookable.
 */
export function kbfOpeningWeekDates(): string[] {
  const days: string[] = [KBF_PROGRAM_START_YMD];
  // Walk forward until we find the next Mon–Fri day, max 4 hops to
  // guard against an infinite loop if the program-start date were
  // ever set to a weekend.
  let cursor = KBF_PROGRAM_START_YMD;
  for (let i = 0; i < 4 && days.length < 2; i++) {
    cursor = addDaysYmd(cursor, 1);
    const dow = dayOfWeekET(cursor);
    if (dow >= 1 && dow <= 5) days.push(cursor);
  }
  return days;
}

export function isKbfOpeningDayPreview(ymd: string, now: Date = new Date()): boolean {
  if (todayKbfYmd(now) >= KBF_PROGRAM_START_YMD) return false;
  return kbfOpeningWeekDates().includes(ymd);
}

/**
 * Is the parent currently in the pre-launch preview period (so the
 * UI should show "book opening day now" banner)?
 */
export function isKbfPreLaunchPeriod(now: Date = new Date()): boolean {
  return todayKbfYmd(now) < KBF_PROGRAM_START_YMD;
}

/**
 * Is this date eligible for any KBF booking at all?
 *
 * Combines the day-of-week filter, the program-start floor, the
 * rolling 2-day-ahead cap, and the pre-launch opening-day carve-out
 * into one check.
 */
export function isKbfBookableDate(ymd: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;

  // Day-of-week (Mon–Fri only)
  const dow = dayOfWeekET(ymd);
  if (dow < 1 || dow > 5) return false;

  // On or after program start
  if (ymd < KBF_PROGRAM_START_YMD) return false;

  // Inside the rolling window [today, today + MAX_DAYS_AHEAD]
  const today = todayKbfYmd(now);
  if (ymd < today) return false;

  // Pre-launch carve-out — opening day is bookable even if it's
  // further out than MAX_DAYS_AHEAD. Bypasses the upper cap.
  if (isKbfOpeningDayPreview(ymd, now)) return true;

  const lastBookable = addDaysYmd(today, KBF_MAX_DAYS_AHEAD);
  if (ymd > lastBookable) return false;

  return true;
}

/**
 * The list of YMD strings a parent can pick today, in display
 * order. Filters out program-pre-start days, weekends, and
 * anything outside the rolling window — but always includes the
 * opening-week preview days if we're still before launch.
 */
export function bookableDateRange(now: Date = new Date()): string[] {
  const today = todayKbfYmd(now);
  const result: string[] = [];
  for (let i = 0; i <= KBF_MAX_DAYS_AHEAD; i++) {
    const ymd = addDaysYmd(today, i);
    if (isKbfBookableDate(ymd, now)) result.push(ymd);
  }
  // Pre-launch: surface the entire opening-week window so parents can
  // pick day 1 or day 2. Dedupe against the rolling-window output.
  if (isKbfPreLaunchPeriod(now)) {
    for (const ymd of kbfOpeningWeekDates()) {
      if (!result.includes(ymd)) result.push(ymd);
    }
  }
  return result;
}

/**
 * Is this exact slot start time (ISO `YYYY-MM-DDTHH:mm`, ET local)
 * within the KBF window for that day?
 *
 *   Mon–Thu — any slot allowed (center hours enforced by QAMF).
 *   Fri     — slot must start strictly before 17:00 ET.
 *   Sat/Sun — blocked.
 */
export function isKbfBookableTime(isoLocal: string): boolean {
  const ymdMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(isoLocal);
  if (!ymdMatch) return false;
  const ymd = ymdMatch[1];
  const hour = parseInt(ymdMatch[2], 10);
  const dow = dayOfWeekET(ymd);
  if (dow === 0 || dow === 6) return false; // Sat/Sun
  if (dow === 5) return hour < 17;            // Friday — last bookable hour is 16:xx
  return true;                                // Mon–Thu
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
  const today = todayKbfYmd(now);
  if (ymd < today) return "That date has already passed";
  // Opening-day preview never fails the rolling-window check.
  if (isKbfOpeningDayPreview(ymd, now)) return null;
  const lastBookable = addDaysYmd(today, KBF_MAX_DAYS_AHEAD);
  if (ymd > lastBookable) {
    return `You can only book up to ${KBF_MAX_DAYS_AHEAD} days ahead`;
  }
  return null;
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
