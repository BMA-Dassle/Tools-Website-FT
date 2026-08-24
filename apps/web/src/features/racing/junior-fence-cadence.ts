/**
 * HOW OFTEN THE JUNIOR FENCE SWEEP NEEDS TO RUN.
 *
 * The sweep is scheduled every minute and, before 2026-08-20, actually ran every
 * minute — 1,440 times a day, three uncached Pandora calls each, ~4,320 calls a
 * day. It was the largest single thing we asked that vendor for.
 *
 * Most of those minutes cannot possibly matter. The sweep exists to fence the
 * empty heats beside a booked junior race before another channel sells one, so
 * its urgency is exactly proportional to BOOKING ACTIVITY. Measured from the
 * venue wire's `ProjectStateChangedNotification` stamps (2,664 booking events,
 * 2026-08-17→19), by venue-local hour:
 *
 *   02:00  0     09:00   99     15:00  157     19:00  503  <- peak
 *   03:00  0     10:00   65     16:00  112     20:00  256
 *   04:00  6     11:00   91     17:00  218     21:00  338
 *   05:00  2     12:00   61     18:00  386     22:00  110
 *   06:00  0     13:00   82                    23:00   38
 *   07:00  0     14:00  124                    00:00    7
 *   08:00  0                                   01:00    9
 *
 * **02:00–08:59 carried EIGHT events across two and a half days.** Nothing is
 * being sold, no heat is within the 15-minute lead the planner will fence
 * inside, and the venue is shut. Running sixty times an hour through that is
 * pure waste.
 *
 * So: full rate whenever anyone might be buying, one run every ten minutes when
 * the evidence says nobody is. The window is deliberately drawn TIGHTER than
 * "venue hours" — online sales run past midnight (00:00 and 01:00 are quiet but
 * not empty, and HPFM runs past midnight on weekends), and the sweep is
 * same-day only, so an overnight booking for a lunchtime heat still has to be
 * caught. It is caught, just within ten minutes instead of one, at an hour when
 * the adjacent slot has no one to sell it to.
 */

/** First venue-local hour of the dead window, inclusive. */
export const QUIET_START_HOUR_ET = 2;
/** Last venue-local hour of the dead window, inclusive. */
export const QUIET_END_HOUR_ET = 8;
/** In the dead window, sweep only on minutes divisible by this. */
export const QUIET_EVERY_MINUTES = 10;

export interface CadenceInput {
  /** Venue-local hour, 0-23. */
  etHour: number;
  /** Venue-local minute, 0-59. */
  etMinute: number;
}

/**
 * Should the sweep do its work on this tick?
 *
 * PURE, so the rule is testable without a clock. Deliberately stateless — it
 * derives the answer from the wall clock rather than from a "last ran" marker,
 * because a marker adds a Redis round trip and a failure mode to save nothing.
 *
 * Outside the dead window this is always true: the sweep keeps its
 * every-minute responsiveness for every hour anyone is actually booking.
 */
export function shouldSweepNow({ etHour, etMinute }: CadenceInput): boolean {
  const quiet = etHour >= QUIET_START_HOUR_ET && etHour <= QUIET_END_HOUR_ET;
  if (!quiet) return true;
  return etMinute % QUIET_EVERY_MINUTES === 0;
}

/** Venue-local hour and minute for an instant. ET is the venue's clock. */
export function etHourMinute(nowMs: number): CadenceInput {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  // `hour12: false` renders midnight as 24 in some ICU builds; normalise.
  const h = get("hour");
  return { etHour: Number.isFinite(h) ? h % 24 : 0, etMinute: get("minute") || 0 };
}
