/**
 * Which takeover, if any, is on the screen right now.
 *
 * PURE, and the only place that decides when a flag stops being true. The feed
 * is an append-only list of things that happened; a screen needs to know what is
 * happening, and those are not the same question.
 *
 * EVERY FLAG CLEARS DIFFERENTLY, and getting this wrong is the difference
 * between a useful screen and a dangerous one:
 *
 *   blue        a courtesy, seconds long. Auto-clears — the faster kart is past.
 *   green       an announcement, not a state. Shows briefly, then the pit board.
 *   caution     lasts as long as the incident. The venue tells us: CrashNotification
 *               carries its own ExpireTime, ~20s out.
 *   crash       same expiry, but ALSO cleared early by UnCrash — the kart is moving.
 *   red         NEVER auto-clears. It ends when race control says so
 *               (EmergencyOff, which arrives as `recovered`) and not a second
 *               sooner. A red flag that times out on its own would put a driver
 *               back on track while the marshal is still walking.
 *   paused      until the session resumes.
 *   chequered   until the next heat is announced.
 *   blackwhite  a warning to read, then get on with it.
 *   disqualified terminal for the heat — it stands.
 *
 * A NEWER TAKEOVER ALWAYS WINS. If a red flag lands during a caution, the red is
 * what shows: the feed is newest-first and the first still-standing entry is the
 * answer. The one exception is that a clearing event beats the thing it clears
 * even when older entries are still nominally alive — handled by scanning for
 * clears before deciding.
 */
import type { AlertKind, DriverAlert } from "./types";

/** Auto-clearing takeovers, and how long they stand. */
const SELF_CLEARING_MS: Partial<Record<AlertKind, number>> = {
  blue: 6_000,
  green: 5_000,
  blackwhite: 10_000,
  aboutToStart: 8_000,
};

/** Takeovers that end only when a specific later alert arrives. */
const CLEARED_BY: Partial<Record<AlertKind, ReadonlySet<AlertKind>>> = {
  red: new Set<AlertKind>(["recovered", "green", "chequered"]),
  crash: new Set<AlertKind>(["recovered", "chequered"]),
  paused: new Set<AlertKind>(["green", "chequered"]),
  chequered: new Set<AlertKind>(["green", "aboutToStart"]),
  caution: new Set<AlertKind>(["recovered", "green", "chequered"]),
  // `disqualified` is deliberately absent: nothing clears it but a new heat,
  // which arrives as a different session and rebuilds the feed anyway.
};

/**
 * The takeover to render, or null for the pit board.
 *
 * @param alerts Newest first — the order the Redis feed returns.
 */
export function currentTakeover(alerts: readonly DriverAlert[], nowMs: number): DriverAlert | null {
  for (let i = 0; i < alerts.length; i++) {
    const a = alerts[i];
    if (a.level !== "takeover") continue;

    // The venue's own expiry always wins when it gave us one.
    if (a.expiresAtMs !== null && nowMs >= a.expiresAtMs) continue;

    const window = SELF_CLEARING_MS[a.kind];
    if (window !== undefined && nowMs - a.atMs >= window) continue;

    // Anything NEWER that clears this one ends it, whatever its own timing says
    // — but only once it has actually HAPPENED. The asymmetry is deliberate and
    // is the safe direction: a candidate stamped slightly in the future still
    // shows (a flag arriving early beats one arriving late), while a clear
    // stamped in the future does not (keeping a red flag up too long is safe;
    // taking it down early puts a driver back on track). Venue and device clocks
    // do drift — the race-clock module exists because of it.
    const clears = CLEARED_BY[a.kind];
    if (clears) {
      let cleared = false;
      for (let j = 0; j < i; j++) {
        const c = alerts[j];
        if (c.atMs >= a.atMs && c.atMs <= nowMs && clears.has(c.kind)) {
          cleared = true;
          break;
        }
      }
      if (cleared) continue;
    }

    // A takeover with no window and nothing to clear it stands until replaced —
    // which is exactly what `disqualified` needs.
    return a;
  }
  return null;
}

/**
 * The inline alerts worth showing, newest first.
 *
 * Takeovers are excluded (they have the screen), anything older than the window
 * is dropped, and only the newest of each kind survives — a kart re-triggering
 * crash detect every second must not stack ten identical toasts.
 */
export function visibleInline(
  alerts: readonly DriverAlert[],
  nowMs: number,
  windowMs = 45_000,
  limit = 3,
): DriverAlert[] {
  const seen = new Set<AlertKind>();
  const out: DriverAlert[] = [];
  for (const a of alerts) {
    if (a.level !== "inline") continue;
    if (nowMs - a.atMs > windowMs) continue;
    if (seen.has(a.kind)) continue;
    seen.add(a.kind);
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}
