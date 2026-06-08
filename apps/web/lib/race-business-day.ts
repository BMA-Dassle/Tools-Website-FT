/**
 * Racing "business day" helpers — ET, with a 2 AM rollover.
 *
 * Why this exists: a race night runs past midnight (Fri/Sat close at 2 AM),
 * and staff keep working the SAME night's heats — assigning cameras,
 * picking heats off the schedule — well after 12:00. If "today" flips at
 * midnight, the night's heats vanish from the camera-assign page the
 * moment the clock crosses 12:00, even though the races are still on the
 * floor. (Reported 2026-06-07: couldn't scan a 6/6 race after midnight.)
 *
 * So for the camera-assign surface, the day doesn't change until 2 AM ET:
 * anything before 2 AM still belongs to the previous calendar date.
 *
 * Pure (Intl + Date only) so both server routes and client components can
 * import it. Anchors all date math at noon UTC so subtracting a day never
 * trips a DST boundary.
 *
 * NOTE: deliberately NOT used by the forward-looking crons
 * (pre-race-tickets / checkin-alerts). Those send tickets for *upcoming*
 * heats and must keep the plain midnight-keyed calendar window, otherwise
 * genuine post-midnight heats (scheduledStart 12–2 AM, which live in the
 * NEXT calendar day) would fall outside the window and miss their SMS.
 */

/** Hour (ET, 0–23) at which the racing day rolls over. */
export const RACE_DAY_ROLLOVER_HOUR = 2;

/** ET wall-clock parts (calendar date + hour) for an instant. */
function etParts(now: Date): { ymd: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour") || "0", 10),
  };
}

/**
 * The ET business-day date (YYYY-MM-DD). Before 2 AM ET it returns the
 * PREVIOUS calendar date so a post-midnight race night stays "today".
 */
export function businessDayYmdET(now: Date = new Date()): string {
  const { ymd, hour } = etParts(now);
  if (hour >= RACE_DAY_ROLLOVER_HOUR) return ymd;
  // Before 2 AM — still the prior race day. Anchor at noon UTC so
  // subtracting a day is exact regardless of DST.
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * ET-local-string range covering the business day, same shape the crons
 * and the /api/pandora/sessions cache key use (`${ymd}T00:00:00` ..
 * `${ymd}T23:59:59`). During normal hours this equals the calendar day,
 * so cache keys still line up with the cron-warmed entries.
 */
export function businessDayETRange(now: Date = new Date()): {
  startDate: string;
  endDate: string;
} {
  const ymd = businessDayYmdET(now);
  return { startDate: `${ymd}T00:00:00`, endDate: `${ymd}T23:59:59` };
}

/**
 * Short weekday ("Mon".."Sun") of the business day. Used to decide which
 * tracks are running (Tuesday = Mega only). With the 2 AM rollover, a
 * Tuesday Mega night still reads as "Tue" up to 2 AM Wednesday, so the
 * Mega track stays selectable while staff finish scanning.
 */
export function businessDayWeekdayET(now: Date = new Date()): string {
  const ymd = businessDayYmdET(now);
  // Noon UTC on the business date → weekday is unambiguous in UTC.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${ymd}T12:00:00Z`));
}
