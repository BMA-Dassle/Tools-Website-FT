/**
 * 18+ gate for phone joins — the one eligibility rule that must not be
 * client-only. Age is computed against the venue's wall clock (both centers
 * are in Florida / America/New_York), not UTC: someone on the eve of their
 * 18th birthday must not slip in during the UTC-vs-ET overlap hours.
 */

const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in ET as [year, month, day]. en-CA yields YYYY-MM-DD. */
function etToday(now: Date): [number, number, number] {
  const [y, m, d] = ET_DATE.format(now).split("-").map(Number);
  return [y, m, d];
}

/**
 * True when the person is 18 or older on the venue's calendar today.
 * `dobIso` must be "YYYY-MM-DD"; malformed or impossible dates return false
 * (fail closed — the phone form validates before submit, so a bad value here
 * is a forged payload, not a guest typo).
 */
export function isAtLeast18(dobIso: string, now: Date = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobIso);
  if (!m) return false;
  const by = Number(m[1]);
  const bm = Number(m[2]);
  const bd = Number(m[3]);
  if (bm < 1 || bm > 12 || bd < 1 || bd > 31 || by < 1000) return false;
  // Reject impossible calendar dates (Feb 30, Apr 31, non-leap Feb 29).
  const roundTrip = new Date(Date.UTC(by, bm - 1, bd));
  if (
    roundTrip.getUTCFullYear() !== by ||
    roundTrip.getUTCMonth() !== bm - 1 ||
    roundTrip.getUTCDate() !== bd
  ) {
    return false;
  }

  const [ty, tm, td] = etToday(now);
  if (by > ty) return false; // future birth year
  let age = ty - by;
  // Birthday not yet reached this year. A Feb-29 birth counts as reached on
  // Mar 1 in non-leap years (td/tm comparison handles that naturally).
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 18;
}
