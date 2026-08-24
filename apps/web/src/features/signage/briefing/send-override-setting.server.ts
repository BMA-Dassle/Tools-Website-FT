import "server-only";

/**
 * MAY THE DESK SEND A GROUP INTO A ROOM WITH NO TIME FOR THE FILM?
 *
 * The send window (pull-to-room.ts) knows when a briefing film can no longer
 * finish before the race in front takes the chequered flag. What to DO about
 * that has moved twice in two days, so it is a setting now rather than a
 * constant:
 *
 *   2026-08-23  "stop them from pushing a group to briefing if they don't have
 *               time" — a hard lock, the button died.
 *   2026-08-24  "instead of complete lock… allow it but prompt a big warning
 *               message", then "actually make this a toggle in settings (gear).
 *               Default to allow the override."
 *
 * DEFAULT ALLOW, and the default is what an absent key means — so a fresh
 * deployment, an unreachable Redis and a never-touched venue all behave the way
 * the owner asked for last. Only the explicit string "0" turns the override off
 * and restores the hard lock.
 *
 * NOT A FEATURE FLAG. The house rule is that flags are kill switches that
 * default ON; this is a staff PREFERENCE about how strict one control is, it
 * lives in the same gear sheet as the check-in window and the greeting mode,
 * and both surfaces read it on their normal poll.
 *
 * SERVER-SIDE, NOT PER-STATION, for the same reason the check-in window is: the
 * room tablets run the identical rule, and a desk that allows the override
 * while the tablet in the room refuses it would be two answers to one question.
 */
import redis from "@/lib/redis";

const KEY = "briefing:send-override:allowed";

/** May staff override a send with no time left? Default TRUE. */
export async function sendOverrideAllowed(): Promise<boolean> {
  try {
    return (await redis.get(KEY)) !== "0";
  } catch {
    // A Redis blip must not silently tighten a control staff are relying on.
    return true;
  }
}

export async function setSendOverrideAllowed(allowed: boolean): Promise<void> {
  await redis.set(KEY, allowed ? "1" : "0");
}
