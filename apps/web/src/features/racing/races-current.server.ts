import "server-only";

/**
 * The called-heat ("session status") pipeline, extracted from
 * /api/pandora/races-current so TWO callers can run the identical live
 * fetch + merge:
 *
 *   - the route's live-first mode (default and the old every-minute warmer),
 *   - the races-current-warm LOOP cron, which is what makes session status
 *     ~realtime (owner 2026-08-14: "Remove caching … we need as close to
 *     realtime for session status as possible. 1 second is the minimums"):
 *     it calls refreshRacesCurrent about once a second for its whole minute,
 *     so the Redis carry every board reads is ~1-2s behind Pandora instead
 *     of the old cron-minute.
 *
 * Pandora itself has been fixed per the owner (2026-08-14) — the historical
 * 5-40s responses that built the old caching ladder are believed gone — but
 * the shape stays defensive: browsers read Redis only, and a Pandora
 * regression costs freshness, never a frozen board.
 *
 * EVERYTHING BEHAVIORAL IS UNCHANGED from the route it came out of:
 * preserveFirstCall pins re-called heats to their first calledAt, the desk's
 * "Clear" tombstones are honoured and retired here, Pandora-null tracks fall
 * back to the age-gated Redis carry, and the carry TTL survives to end of
 * day (+ display cushion).
 */
import redis from "@/lib/redis";
import {
  readClearedCall,
  forgetClearedCall,
} from "~/features/signage/briefing/called-override.server";
import { callIsSuppressed, type ClearedCall } from "~/features/signage/briefing/called-clear";
import {
  MAX_DISPLAY_AGE_MS,
  callIsStalerThanStored,
  preserveFirstCall,
  raceStillDisplayable,
} from "~/features/racing/current-race-freshness";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

export type TrackKey = "blue" | "red" | "mega";

export type CurrentRace = {
  trackName: string;
  raceType: string;
  heatNumber: number;
  scheduledStart?: string;
  calledAt: string;
  sessionId: number;
};

export type CurrentRaces = Record<TrackKey, CurrentRace | null>;

const TRACKS: TrackKey[] = ["blue", "red", "mega"];

/** Seconds until midnight ET — used as Redis TTL for last-race storage. */
function secondsUntilEndOfDayET(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  const s = parseInt(parts.find((p) => p.type === "second")?.value || "0", 10);
  const secRemaining = 86400 - (h * 3600 + m * 60 + s);
  // Cushion past midnight so a night's last heat is still readable into the
  // small hours — derived from MAX_DISPLAY_AGE_MS so the two cannot drift.
  const cushionSec = MAX_DISPLAY_AGE_MS / 1000 + 3600;
  return Math.max(60, secRemaining + cushionSec);
}

const REDIS_KEY = (t: TrackKey) => `pandora:last-race:fasttrax:${t}`;

async function saveRace(track: TrackKey, race: CurrentRace): Promise<void> {
  try {
    await redis.set(REDIS_KEY(track), JSON.stringify(race), "EX", secondsUntilEndOfDayET());
  } catch (err) {
    console.error(`[races-current] Redis save ${track}:`, err);
  }
}

/** Drop the carried copy, so a cleared heat cannot come back through it. */
async function forgetStored(track: TrackKey): Promise<void> {
  try {
    await redis.del(REDIS_KEY(track));
  } catch (err) {
    console.error(`[races-current] Redis clear ${track}:`, err);
  }
}

/**
 * The stored last-known heat for a track, or null. THE FRESHNESS RULE LIVES
 * HERE, in the one function every caller already goes through.
 */
async function loadRace(track: TrackKey): Promise<CurrentRace | null> {
  try {
    const raw = await redis.get(REDIS_KEY(track));
    if (!raw) return null;
    const race = JSON.parse(raw) as CurrentRace;
    if (!raceStillDisplayable(race, Date.now())) return null;
    return race;
  } catch (err) {
    console.error(`[races-current] Redis load ${track}:`, err);
    return null;
  }
}

/** All three carry keys in parallel — the ONLY read browsers pay for.
 *  Cheap (3 GETs, ~5-20ms) against a live Pandora call. */
export async function loadAllFromRedis(): Promise<CurrentRaces> {
  const [blue, red, mega] = await Promise.all([
    loadRace("blue"),
    loadRace("red"),
    loadRace("mega"),
  ]);
  return { blue, red, mega };
}

/**
 * One live Pandora read, merged and saved: the moved body of the route's
 * live path. Throws on an upstream failure (timeout included) — the route
 * turns that into its Redis fallback, the warm loop counts it and goes
 * around again.
 */
export async function refreshRacesCurrent(timeoutMs: number): Promise<CurrentRaces> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${PANDORA_URL}/bmi/races/current/${FASTTRAX_LOCATION_ID}`, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const pandora: CurrentRaces = res.ok
      ? ((await res.json()).data ?? { blue: null, red: null, mega: null })
      : { blue: null, red: null, mega: null };

    // RE-CALLS DO NOT RESET CLOCKS: preserveFirstCall pins a re-called heat
    // to its earliest calledAt before it is served OR saved. The desk's
    // "Clear" tombstones are honoured (and retired on a genuine re-call)
    // here, the one seam every consumer reads through.
    const stored = await loadAllFromRedis();
    const clearedByTrack = await Promise.all(
      TRACKS.map((t) => readClearedCall(t).catch(() => null)),
    );
    const cleared: Record<TrackKey, ClearedCall | null> = {
      blue: clearedByTrack[0],
      red: clearedByTrack[1],
      mega: clearedByTrack[2],
    };

    const merged: CurrentRaces = { blue: null, red: null, mega: null };
    for (const t of TRACKS) {
      if (pandora[t]) {
        // OUT-OF-ORDER ANSWERS MUST NOT MOVE THE BOARD BACKWARDS. The warm loop
        // now keeps several reads in flight so a hung one cannot own the minute,
        // which means a slow answer can land after a faster, newer one.
        if (callIsStalerThanStored(pandora[t] as CurrentRace, stored[t])) {
          merged[t] = stored[t];
          continue;
        }
        const race = preserveFirstCall(pandora[t] as CurrentRace, stored[t]);
        if (callIsSuppressed(cleared[t], race)) {
          // Swallowed, and the stored copy goes with it — otherwise the
          // carry would serve the same heat back when Pandora ages out.
          merged[t] = null;
          void forgetStored(t);
          continue;
        }
        merged[t] = race;
        // An unsuppressed sighting spends the tombstone, so a stale
        // suppression cannot swallow a later re-call.
        if (cleared[t]) void forgetClearedCall(t);
        // Fire and forget — don't block the caller on the Redis write.
        saveRace(t, race);
      } else if (stored[t] && callIsSuppressed(cleared[t], stored[t] as CurrentRace)) {
        // Pandora has gone quiet but our carry still holds the cleared heat.
        merged[t] = null;
        void forgetStored(t);
      } else {
        // Pandora expires its own entry ~20 min after the call — the stored
        // copy carries the session between heats, age-gated.
        merged[t] = stored[t];
      }
    }
    return merged;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
