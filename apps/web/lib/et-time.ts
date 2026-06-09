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
