import "server-only";

/**
 * THE CALLED RECORD, BY HAND.
 *
 * `pandora:last-race:fasttrax:{track}` is normally written only by
 * /api/pandora/races-current, from Pandora's own answer. That is the right
 * owner right up until Pandora stops answering — and on 2026-08-13/14 it
 * returned 500 "Response Validator Error" for hours while the venue kept
 * calling heats. The carry froze on the last heat it had seen, every board in
 * the building froze with it, and the only way to move the night forward was a
 * person with a Redis client (owner 2026-08-14: "seed 64 red and 63 blue").
 *
 * So the desk can write it too. This is deliberately the SAME key and the same
 * shape the route writes, because the point is to be indistinguishable
 * downstream: the moment Pandora recovers, its next answer overwrites whatever
 * was placed here and nothing has to be undone.
 *
 * It is not a parallel source of truth. It is the same source of truth, with a
 * second way in for the nights the first one is unreachable.
 */
import redis from "@/lib/redis";
import type { TrackKey } from "../track";
import type { ClearedCall } from "./called-clear";

/** The shape /api/pandora/races-current stores, field for field. */
export interface CalledRaceRecord {
  trackName: string;
  raceType: string | null;
  heatNumber: number | null;
  scheduledStart: string | null;
  calledAt: string;
  /** Numeric in the stored record, as the route writes it. These are 8-digit
   *  Pandora session ids — comfortably inside the safe range — but they are
   *  carried as text everywhere else in this codebase, so the conversion is
   *  made once, here, where the shape is being matched on purpose. */
  sessionId: number;
}

function key(track: TrackKey): string {
  return `pandora:last-race:fasttrax:${track}`;
}

/**
 * How long a hand-written call survives.
 *
 * Long enough to outlast the vendor outage that made it necessary, and short
 * enough that it cannot greet tomorrow: a stale called heat is the exact
 * failure this whole feature exists to fix, and an override that outlived its
 * night would be that failure wearing our own handwriting.
 */
const CALLED_TTL_SECONDS = 8 * 3600;

/** Venue-local ISO with ET's offset — the format the route's own records use. */
export function etCalledAtIso(now: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  // ET is -04:00 through the racing season; the venue does not run heats in the
  // January window where this would be -05:00.
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}-04:00`;
}

export async function readCalledRace(track: TrackKey): Promise<CalledRaceRecord | null> {
  try {
    const raw = await redis.get(key(track));
    return raw ? (JSON.parse(raw) as CalledRaceRecord) : null;
  } catch {
    return null;
  }
}

function clearedKey(track: TrackKey): string {
  return `pandora:called-cleared:fasttrax:${track}`;
}

/** The call the desk cleared by hand, if one is still buried. */
export async function readClearedCall(track: TrackKey): Promise<ClearedCall | null> {
  try {
    const raw = await redis.get(clearedKey(track));
    return raw ? (JSON.parse(raw) as ClearedCall) : null;
  } catch {
    return null;
  }
}

/** Forget a clear — the heat is welcome back. */
export async function forgetClearedCall(track: TrackKey): Promise<void> {
  try {
    await redis.del(clearedKey(track));
  } catch {
    /* a blip here just means the tombstone outlives its usefulness by a beat */
  }
}

/**
 * Write the called record for a track, or clear it when `race` is null.
 *
 * CLEARING LEAVES A TOMBSTONE, and that is the whole reason Clear works at all.
 * Deleting the key is not enough: /api/pandora/races-current writes it back from
 * Pandora's answer within seconds, and Pandora keeps reporting a called heat for
 * ~20 minutes, so the press appeared to do nothing (owner 2026-08-14). The
 * poller reads this tombstone and swallows exactly the call that was buried —
 * see called-clear.ts for the rule.
 *
 * PLACING A SESSION LIFTS ANY TOMBSTONE. A deliberate placement is the most
 * recent thing the desk said, so it outranks an earlier clear on that track —
 * otherwise putting a session back on a slot you had just cleared would be
 * swallowed by your own previous press.
 */
export async function setCalledRace(
  track: TrackKey,
  race: CalledRaceRecord | null,
): Promise<{ ok: true }> {
  try {
    if (race) {
      await redis.set(key(track), JSON.stringify(race), "EX", CALLED_TTL_SECONDS);
      await forgetClearedCall(track);
    } else {
      // Read BEFORE deleting: the record on its way out is the only place the
      // session id and stamp being cleared can be learned.
      const outgoing = await readCalledRace(track);
      await redis.del(key(track));
      if (outgoing?.sessionId != null) {
        const tombstone: ClearedCall = {
          sessionId: Number(outgoing.sessionId),
          calledAt: outgoing.calledAt ?? null,
          atMs: Date.now(),
        };
        // Same TTL as a hand-written call, for the same reason: a suppression
        // that outlived its night would hide a heat someone called tomorrow.
        await redis.set(clearedKey(track), JSON.stringify(tombstone), "EX", CALLED_TTL_SECONDS);
      }
    }
  } catch {
    // Same posture as every other display write here: a Redis blip costs a
    // board a beat, never a staff action that has already been recorded.
  }
  return { ok: true };
}
