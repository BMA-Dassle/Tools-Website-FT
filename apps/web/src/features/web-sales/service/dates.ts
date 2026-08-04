/**
 * Eastern calendar-day helpers.
 *
 * The board's date range is a pair of ET CALENDAR DAYS, not instants. Every
 * center is in America/New_York, ops think in "yesterday", and a UTC-derived
 * "today" is wrong for the four hours after 8pm ET — which is peak sale time for
 * a family-entertainment business. Deriving the day from `Intl` with an explicit
 * timeZone is the only way to get this right across DST without a date library.
 */

/** Today as YYYY-MM-DD in Eastern. */
export function todayEasternYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Shift a YYYY-MM-DD by whole days.
 *
 * Anchored at 12:00 UTC deliberately: midday is never within a DST transition, so
 * adding N days can never land on the same or a skipped calendar date the way a
 * midnight anchor can.
 */
export function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const anchor = Date.UTC(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
  const moved = new Date(anchor + days * 86_400_000);
  const mm = String(moved.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(moved.getUTCDate()).padStart(2, "0");
  return `${moved.getUTCFullYear()}-${mm}-${dd}`;
}

/** Inclusive day count between two YYYY-MM-DD values. */
export function daysBetweenYmd(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy, (fm ?? 1) - 1, fd ?? 1);
  const b = Date.UTC(ty, (tm ?? 1) - 1, td ?? 1);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** The board's default window: the last 30 ET days, inclusive of today. */
export function defaultRange(now: Date = new Date()): { from: string; to: string } {
  const to = todayEasternYmd(now);
  return { from: shiftYmd(to, -29), to };
}

/**
 * The half-open UTC instants covering an inclusive ET day range, for SQL.
 *
 * `[startUtc, endUtc)` — the end is the START of the day AFTER `to`, so a sale at
 * 23:59:59.500 on the last day is included. A `<=` against end-of-day
 * `23:59:59` silently drops the final second, which is exactly the kind of
 * off-by-one nobody notices until a sale goes missing from a report.
 */
export function easternRangeToUtc(from: string, to: string): { startUtc: string; endUtc: string } {
  return {
    startUtc: new Date(`${from}T00:00:00${etOffsetFor(from)}`).toISOString(),
    endUtc: new Date(`${shiftYmd(to, 1)}T00:00:00${etOffsetFor(shiftYmd(to, 1))}`).toISOString(),
  };
}

/**
 * The real ET offset on a given calendar day, from the tz database.
 *
 * A hardcoded offset puts a boundary on the wrong day for half the year. Same
 * technique (and the same reasoning) as `dealExpiryFrom` in the deals catalog.
 */
function etOffsetFor(ymd: string): "-04:00" | "-05:00" {
  // 17:00Z is ~midday ET on either offset, so it can never land on the wrong day.
  const midday = new Date(`${ymd}T17:00:00Z`);
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(midday);
  return short.includes("EDT") ? "-04:00" : "-05:00";
}
