import "server-only";

/**
 * KILL SWITCH for race-event camera bookmarks, thrown from the check-in board's
 * settings sheet — same place, and for the same reason, as the auto-holding one
 * (auto-holding.server.ts).
 *
 * SEPARATE FROM AUTO-HOLDING ON PURPOSE. They share a settings sheet and a
 * camera system and nothing else. Auto-holding CHANGES OPERATIONAL STATE: it
 * moves a group to holding and advances the pit lane, so switching it off is a
 * decision about how the night runs. This only writes markers onto footage —
 * switching it off changes nothing a guest or a staff member experiences, it
 * just stops annotating. One switch for both would mean somebody wanting the
 * ribbons quieter had to also give up the automatic holding move, or the other
 * way round, and neither trade makes sense.
 *
 * The far more likely reason to reach for THIS one is volume: a Mega Saturday
 * marks four events across ~33 cameras a heat, and if that turns out to bury
 * the Nx timeline, staff need to stop it from the board rather than wait for a
 * deploy.
 *
 * House rule as ever: default ON, only the explicit string "0" disables, an
 * unreachable Redis reads as ON, and no TTL — a kill switch that expires back
 * to ON by itself is worse than none.
 */
import redis from "@/lib/redis";

const SWITCH_KEY = `race:bookmarks:enabled`;

export async function raceBookmarksEnabled(): Promise<boolean> {
  try {
    return (await redis.get(SWITCH_KEY)) !== "0";
  } catch {
    return true;
  }
}

export async function setRaceBookmarksEnabled(enabled: boolean): Promise<void> {
  await redis.set(SWITCH_KEY, enabled ? "1" : "0");
}
