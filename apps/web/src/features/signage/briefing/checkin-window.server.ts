import "server-only";

/**
 * HOW LONG A CALLED RACER HAS TO REACH THE DESK — the desk's own override.
 *
 * The window used to live only in the signage screen configs: whichever screens
 * show the check-in countdown carried a `checkinWindowMins`, and the board took
 * the shortest. That is the right home for a per-screen display choice and the
 * wrong one for a number ops wants to change on a busy Saturday — it meant
 * opening the signage admin, finding the right screens, and editing each.
 *
 * So the check-in board's gear writes ONE value here and it wins over every
 * screen (owner 2026-08-23: "make this a setting in the gear of the check in
 * board"). Unset — the normal state — changes nothing: the screen configs and
 * their 7-minute default still decide.
 *
 * WHY SERVER-SIDE AND NOT PER-STATION. The track TVs count a guest down against
 * this same number. A station-local override would put a desk on 7 while the
 * wall in front of the guest ran 8, and the guest's clock is the one that
 * matters. One value, every surface, within one 5s poll.
 */
import redis from "@/lib/redis";

const KEY = "briefing:checkin-window-mins";

/** The floor and ceiling the gear offers. A window under a minute cannot be
 *  met by anybody walking; over twenty it stops being a window at all. */
export const CHECKIN_WINDOW_MIN_MINS = 1;
export const CHECKIN_WINDOW_MAX_MINS = 20;

/** The desk's override, or null when the screen configs still decide. */
export async function checkinWindowOverride(): Promise<number | null> {
  try {
    const raw = await redis.get(KEY);
    if (raw == null) return null;
    const mins = Number(raw);
    // A junk value is NOT an override. Falling back to the screens is always
    // safe; guessing at a corrupted number is not.
    if (!Number.isFinite(mins)) return null;
    if (mins < CHECKIN_WINDOW_MIN_MINS || mins > CHECKIN_WINDOW_MAX_MINS) return null;
    return Math.round(mins);
  } catch {
    // A Redis blip must not shorten anybody's window — the screens stand.
    return null;
  }
}

/** Sets the override, or clears it with null so the screens decide again. */
export async function setCheckinWindowOverride(mins: number | null): Promise<void> {
  if (mins == null) {
    await redis.del(KEY);
    return;
  }
  const clamped = Math.min(
    CHECKIN_WINDOW_MAX_MINS,
    Math.max(CHECKIN_WINDOW_MIN_MINS, Math.round(mins)),
  );
  // NO TTL. A window ops set at 6pm must still be the window at midnight; this
  // is a configuration change, not a claim.
  await redis.set(KEY, String(clamped));
}
