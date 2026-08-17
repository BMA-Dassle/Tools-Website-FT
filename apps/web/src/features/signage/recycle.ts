/**
 * WHEN DOES A WALL TV RELOAD ITSELF JUST TO RECLAIM MEMORY?
 *
 * The self-update reload (TvShell) has always doubled as memory amnesty — the
 * one moment a page that otherwise runs for weeks gets its renderer torn down.
 * But it only ever fired when a DEPLOY shipped: a quiet week meant no reload at
 * all, and the launcher's --disable-renderer-backgrounding flags mean nothing
 * external ever reclaims the tab either. Leaks aside, a renderer with weeks of
 * uptime on a shared-graphics mini PC is how "Edge stopped responding" happens.
 *
 * So: recycle NIGHTLY, in the small hours, when every screen is idle and the
 * scene-boundary / hold rules land the reload invisibly — with a hard cap for
 * a pathological screen that is somehow never safe overnight. The decision is
 * pure so the policy is testable; TvShell does the thin wiring.
 *
 * VENUE TIME, NOT DEVICE TIME. The player PCs are documented to carry the
 * wrong local timezone (a camera board once showed 5am to a room at midnight),
 * so the hour must come from Intl with an explicit zone. All three venues are
 * Eastern.
 */

export const TV_RECYCLE_SOFT_MS = 12 * 3_600_000;
/**
 * 36h, NOT 24h — the cap must be long enough that a nightly window always
 * comes first. At 24h it locked evening-booted screens into a daily
 * trading-hours reload: a TV (re)based at 20:00 — an ordinary evening deploy
 * re-bases every screen at once — reaches 2am at 6h and 6am at 10h, never
 * crossing 12h inside the window, so the first trigger it ever met was the
 * hard cap at 24h… at 20:00 again, forever. At 36h the second overnight
 * window always wins (worst case ~32h), and the cap only acts when the venue
 * hour is unreadable — where a 36h stride at least rotates around the clock
 * instead of pinning to one hour.
 */
export const TV_RECYCLE_HARD_MS = 36 * 3_600_000;

/** The overnight window (venue-local): screens are idle, safeToReload lands
 *  within one 5-minute check, and nobody sees the blink. */
const WINDOW_START_HOUR = 2;
const WINDOW_END_HOUR = 6;

export function shouldRecycle(uptimeMs: number, etHour: number): boolean {
  if (uptimeMs > TV_RECYCLE_HARD_MS) return true;
  return uptimeMs > TV_RECYCLE_SOFT_MS && etHour >= WINDOW_START_HOUR && etHour < WINDOW_END_HOUR;
}

/** The current hour (0-23) in venue time, or -1 when the runtime cannot say —
 *  an unknown hour never matches the overnight window, and the hard cap does
 *  not need it. */
export function etHourNow(now: Date = new Date()): number {
  try {
    const text = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hourCycle: "h23",
    }).format(now);
    const hour = Number.parseInt(text, 10);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : -1;
  } catch {
    return -1;
  }
}
