import "server-only";

/**
 * GREETING BY MOTION — the welcome-back audio's mode switch, thrown from the
 * check-in board's settings sheet, right under auto-holding (owner 2026-08-23:
 * "I'd like this option in the settings of check in board where we have the
 * other motion option").
 *
 * ON (default): the room TV starts the greeting when the room's own camera
 * first sees the group walk in (return-arrival.server.ts) — measured to land
 * 15-30s after the first person enters. OFF: a plain post + 45s timer, and the
 * NVR is never consulted for it.
 *
 * SEPARATE FROM AUTO-HOLDING for the same reason race-bookmarks is: they share
 * a settings sheet and a camera system and nothing else. That one moves groups
 * through the night; this one only times a sound.
 *
 * House rule as ever: default ON, only the explicit string "0" disables, an
 * unreachable Redis reads as ON, and no TTL — a switch that expires back by
 * itself changes a night nobody decided to change.
 */
import redis from "@/lib/redis";

const SWITCH_KEY = `briefing:greeting-by-motion:enabled`;

export async function greetingByMotionEnabled(): Promise<boolean> {
  try {
    return (await redis.get(SWITCH_KEY)) !== "0";
  } catch {
    return true;
  }
}

export async function setGreetingByMotionEnabled(enabled: boolean): Promise<void> {
  await redis.set(SWITCH_KEY, enabled ? "1" : "0");
}
