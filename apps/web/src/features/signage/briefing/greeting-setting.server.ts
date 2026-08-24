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
import {
  GREETING_TIMING_DEFAULTS,
  normaliseGreetingTiming,
  type GreetingTiming,
} from "./return-greeting";

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

/* ── the three timing numbers ─────────────────────────────────────────── */

/**
 * How long to wait, how many times to say it, and how long a room may keep
 * moving before the reminder (owner 2026-08-23: "add these settings to the
 * check in board gear settings").
 *
 * ONE JSON VALUE, not three keys: they are read together on every board poll
 * and every TV poll, and three GETs to answer one question is three chances
 * for a partial read to hand the wall a half-changed setting.
 *
 * NO TTL, same as the switch above. Every read goes through
 * `normaliseGreetingTiming`, so a corrupt or hand-edited value degrades to
 * house behaviour rather than to nonsense — an unreachable Redis included.
 */
const TIMING_KEY = `briefing:greeting-timing`;

export async function greetingTiming(): Promise<GreetingTiming> {
  try {
    const raw = await redis.get(TIMING_KEY);
    if (!raw) return GREETING_TIMING_DEFAULTS;
    return normaliseGreetingTiming(JSON.parse(raw));
  } catch {
    // Unreachable Redis, or a value that is not JSON at all.
    return GREETING_TIMING_DEFAULTS;
  }
}

/**
 * Save a partial change and return what now stands.
 *
 * MERGES over what is stored, so the sheet can send one field without the
 * other two collapsing to defaults — and normalises the merged result, so a
 * value the sheet should never have sent still cannot land.
 */
export async function setGreetingTiming(patch: Partial<GreetingTiming>): Promise<GreetingTiming> {
  const current = await greetingTiming();
  const next = normaliseGreetingTiming({ ...current, ...patch });
  await redis.set(TIMING_KEY, JSON.stringify(next));
  return next;
}
