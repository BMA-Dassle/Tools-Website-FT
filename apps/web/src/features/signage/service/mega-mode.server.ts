import "server-only";

/**
 * SERVER-SIDE mega mode — the feed builders' answer to "is the venue racing
 * the combined circuit right now?".
 *
 * The signage feed never used to know about Mega at all: each builder carried
 * its own `?? currentSession("mega")` null-fallback, which a STALE blue/red
 * carry defeats (the keys live to end of ET day, so on the first off-calendar
 * Mega night the afternoon's last split-track heats poisoned every board all
 * evening). This module gives the server the same two signals the client hook
 * composes:
 *
 *   - the external flag, read from the /api/track-status route's OWN Redis
 *     cache (`track-status:cache:v1`) — never fetched upstream from here. The
 *     client fleet polls that route all day, so the cache is warm whenever
 *     anyone is watching; a genuinely cold cache means we lean on the data
 *     signal, which is exactly the fallback it exists to be.
 *   - the data signal (mega carry strictly newest) via dataSaysMega.
 */
import redis from "@/lib/redis";
import { loadAllFromRedis } from "~/features/racing/races-current.server";
import { dataSaysMega, pickCurrentSession } from "~/features/racing/mega-mode";
import type { TrackKey } from "../track";
import type { CachedRace } from "./race-checkin";

const TRACK_STATUS_CACHE_KEY = "track-status:cache:v1";

/** Mirrors the route's MAX_SERVE_AGE_MS: past this the reading is a fossil,
 *  and a fossil flag is a wrong answer stated confidently. */
const FLAG_MAX_AGE_MS = 3 * 60 * 60_000;

/** The external megaTrackEnabled flag, from the track-status route's cache.
 *  Cold, stale, unparseable or Redis-down all read as false. */
export async function readMegaFlag(): Promise<boolean> {
  try {
    const raw = await redis.get(TRACK_STATUS_CACHE_KEY);
    if (!raw) return false;
    const entry = JSON.parse(raw) as { fetchedAt?: number; data?: unknown };
    if (typeof entry.fetchedAt !== "number") return false;
    if (Date.now() - entry.fetchedAt > FLAG_MAX_AGE_MS) return false;
    const data = entry.data as { megaTrackEnabled?: unknown } | null | undefined;
    return Boolean(data?.megaTrackEnabled);
  } catch {
    return false;
  }
}

/** Effective mega mode: the flag OR the data signal. Every error path folds
 *  to false — fail-open to normal-day behavior. */
export async function megaModeActive(): Promise<boolean> {
  const [flag, races] = await Promise.all([
    readMegaFlag(),
    loadAllFromRedis().catch(() => ({ blue: null, red: null, mega: null })),
  ]);
  return flag || dataSaysMega(races);
}

const CARRY_KEY = (t: TrackKey) => `pandora:last-race:fasttrax:${t}`;

/**
 * The session a TRACK BOARD should describe: newest-wins between the track's
 * own carry and the mega carry.
 *
 * DATA-ONLY on purpose — the flag is not consulted. In the flag-on/no-mega-
 * call-yet window the track's own (briefed, hours-old) carry is already
 * treated as expired by the scene, so the board idles exactly as it does
 * between heats; forcing mega there would buy nothing. A data-only rule is
 * also trivially provable inert on normal days: the mega key does not exist.
 *
 * Deliberately the same un-age-gated raw read race-checkin has always used
 * (the carry OUTLIVES Pandora's ~20-min expiry so "now checking in" stays up
 * between heats) — this changes SELECTION only, never gating.
 */
export async function bestCurrentSession(track: TrackKey): Promise<CachedRace | null> {
  try {
    if (track === "mega") {
      const raw = await redis.get(CARRY_KEY("mega"));
      return raw ? (JSON.parse(raw) as CachedRace) : null;
    }
    const [exactRaw, megaRaw] = await redis.mget(CARRY_KEY(track), CARRY_KEY("mega"));
    const exact = exactRaw ? (JSON.parse(exactRaw) as CachedRace) : null;
    const mega = megaRaw ? (JSON.parse(megaRaw) as CachedRace) : null;
    return pickCurrentSession(exact, mega);
  } catch {
    return null;
  }
}
