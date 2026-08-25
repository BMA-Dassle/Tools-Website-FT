/**
 * Eastern-Time helpers for BMI dates.
 *
 * BMI Office returns event times as a timezone-less wall-clock string in
 * Eastern Time, e.g. "2026-12-19T18:00:00" means 6:00 PM ET on Dec 19. The
 * correct UTC offset depends on whether that date falls in EDT (-04:00) or
 * EST (-05:00). Historically the codebase hardcoded "-04:00" everywhere, which
 * silently shifted every winter (EST) event one hour earlier on the contract
 * page and in the stored timestamptz (see the Dec-19 6pm→5pm bug, 2026-06-09).
 *
 * Offsets are derived from the IANA tz database via Intl, so DST transition
 * dates are handled correctly — no month-based approximation.
 */

/**
 * The Eastern-Time UTC offset (e.g. "-04:00" or "-05:00") in effect on the
 * given calendar date. Probes at 16:00 UTC (~noon ET) so DST-transition days
 * resolve to the daytime offset, which is what evening events want.
 */
export function etOffsetForLocalDate(localStr: string): string {
  const m = localStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "-05:00";
  const [, y, mo, d] = m.map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d, 16, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  }).formatToParts(probe);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT-05:00";
  const mm = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!mm) return "-05:00";
  const sign = mm[1];
  const hh = mm[2].padStart(2, "0");
  const min = mm[3] || "00";
  return `${sign}${hh}:${min}`;
}

/** True if the string already carries a timezone (Z, +hh:mm, or -hh:mm). */
export function hasTimezone(dateStr: string): boolean {
  return dateStr.includes("Z") || dateStr.includes("+") || /\d-\d{2}:\d{2}$/.test(dateStr);
}

/**
 * Normalize a BMI date to a tz-bearing ISO string. If it already has an offset,
 * it is returned unchanged; otherwise the correct ET offset for that date is
 * appended (EDT vs EST). Use this anywhere a tz-less BMI wall-clock string is
 * about to be parsed by `new Date(...)` or stored as a `timestamptz`.
 */
export function normalizeEtDate(dateStr: string): string {
  if (!dateStr) return dateStr;
  return hasTimezone(dateStr) ? dateStr : `${dateStr}${etOffsetForLocalDate(dateStr)}`;
}

/**
 * A recurring day-of-week offer window, e.g. "every Wednesday from 2026-08-19"
 * (BOGO races). `days` and `from` are required together on purpose: a
 * day-of-week rule has no natural start, so without `from` it reads as active
 * for every matching day in HISTORY — which is not a hypothetical, it is what
 * once put limited-time SKUs into the catalog for a July race date.
 *
 * `until` closes the other end for a rule that runs for a SEASON rather than
 * forever (Mega Thursdays, Sep–Oct 2026). It is optional because the original
 * shape — open-ended from a start date — is still the common one; a rule type
 * that must name an end would force every permanent rule to invent a fake one.
 * Anything modelling a limited run should declare it explicitly rather than
 * lean on the default: see `MegaDayWindow`, which requires `until` so a new
 * window cannot quietly become permanent.
 */
export interface RecurringDayRule {
  /** `Date.getDay()` numbering — 0 Sun … 6 Sat. `[3]` = Wednesdays. */
  days: readonly number[];
  /** First calendar day the rule applies to, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Last calendar day the rule applies to, `YYYY-MM-DD`, inclusive.
   *  Omitted or `null` = open-ended, the original behaviour. */
  until?: string | null;
}

const ET_WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Today in Eastern Time, as `{ ymd, weekday }`. Never `getDay()` on the raw
 *  instant: Vercel runs UTC, so 9pm Wednesday ET is already Thursday there and
 *  any ET day rule would flip four hours early (the Dec-19 6pm→5pm bug's
 *  cousin). Both centers are US-Eastern. */
export function etDay(now: Date = new Date()): { ymd: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ET_WEEKDAY_INDEX[at("weekday")];
  if (weekday === undefined) {
    throw new Error(`unrecognised ET weekday from Intl: ${at("weekday")}`);
  }
  return { ymd: `${at("year")}-${at("month")}-${at("day")}`, weekday };
}

/**
 * Does `rule` admit the calendar day `dateYmd` (`YYYY-MM-DD`)? A null/undefined
 * date falls back to TODAY IN EASTERN TIME at `now` — the walk-up case, where
 * the day being asked about is simply today.
 *
 * The `from` floor is applied to WHICHEVER day the rule reads, so both branches
 * refuse a day before the offer existed. Flooring the purchase clock instead
 * would be subtly wrong in both directions: it would refuse a guest booking the
 * day before launch for a launch-day race, and it would still admit a race date
 * from before the offer began.
 *
 * `YYYY-MM-DD` is parsed as LOCAL, not UTC: `new Date("2026-08-19")` is UTC
 * midnight, which reads back as the day BEFORE in any negative-offset zone —
 * the trap documented on `scheduleForDate`, which once hid a package for a whole
 * Tuesday. `from` and `until` are compared as STRINGS, which is exactly right
 * for zero-padded `YYYY-MM-DD` and sidesteps a second timezone decision.
 *
 * `until` is INCLUSIVE — the last day named still runs. A season announced as
 * "through the end of October" is `until: "2026-10-31"`, and the last matching
 * weekday inside it is admitted.
 */
export function withinRecurringDayRule(
  rule: RecurringDayRule,
  dateYmd: string | null | undefined,
  now: Date = new Date(),
): boolean {
  let ymd: string;
  let weekday: number;
  if (dateYmd) {
    const datePart = dateYmd.split("T")[0];
    const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    ymd = datePart;
    weekday = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
  } else {
    ({ ymd, weekday } = etDay(now));
  }
  if (ymd < rule.from) return false;
  if (rule.until != null && ymd > rule.until) return false;
  return rule.days.includes(weekday);
}

/**
 * Format a BMI date for display, e.g. "Dec 19 6:00 PM", in Eastern Time.
 * Accepts both tz-bearing and tz-less BMI strings.
 */
export function formatEtDateTime(dateStr: string): string {
  const d = new Date(normalizeEtDate(dateStr));
  return (
    d.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
    }) +
    " " +
    d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
  );
}
