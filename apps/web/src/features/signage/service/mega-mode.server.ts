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
import { businessDayWeekdayET, businessDayYmdET } from "@/lib/race-business-day";
import { loadAllFromRedis } from "~/features/racing/races-current.server";
import { dataSaysMega, megaLadder, pickCurrentSession } from "~/features/racing/mega-mode";
import type { TrackKey } from "../track";
import type { CachedRace } from "./race-checkin";

const TRACK_STATUS_CACHE_KEY = "track-status:cache:v1";

/** Mirrors the route's MAX_SERVE_AGE_MS: past this the reading is a fossil,
 *  and a fossil flag is a wrong answer stated confidently. */
const FLAG_MAX_AGE_MS = 3 * 60 * 60_000;

/**
 * The external megaTrackEnabled flag, from the track-status route's cache.
 *
 * TRI-STATE on purpose: `null` means "the status app's answer is not
 * available" (cold cache, past the serve ceiling, unparseable, Redis down) —
 * which is a different fact from a fresh `false`, and the ladder treats them
 * differently: a fresh false is authoritative, an unavailable flag falls
 * through to the dayplanner and then the calendar.
 */
export async function readMegaFlag(): Promise<boolean | null> {
  try {
    const raw = await redis.get(TRACK_STATUS_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { fetchedAt?: number; data?: unknown };
    if (typeof entry.fetchedAt !== "number") return null;
    if (Date.now() - entry.fetchedAt > FLAG_MAX_AGE_MS) return null;
    const data = entry.data as { megaTrackEnabled?: unknown } | null | undefined;
    return Boolean(data?.megaTrackEnabled);
  } catch {
    return null;
  }
}

/* ── the dayplanner tier ──────────────────────────────────────────────── */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_API_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

/** Verdicts are stable facts about a day's schedule — 15 min is generous. */
const DAYPLAN_VERDICT_TTL_SEC = 15 * 60;
/** A failed probe backs off rather than retrying on every feed build. */
const DAYPLAN_FAIL_TTL_SEC = 120;
/** One prober at a time; losers answer null and the ladder falls through. */
const DAYPLAN_CLAIM_TTL_SEC = 30;
const DAYPLAN_FETCH_TIMEOUT_MS = 4_000;

async function countSessionsToday(resourceName: string, ymd: string): Promise<number> {
  const qs = new URLSearchParams({
    startDate: `${ymd}T00:00:00`,
    endDate: `${ymd}T23:59:59`,
    resourceName,
  }).toString();
  const res = await fetch(`${PANDORA_URL}/bmi/sessions/${FASTTRAX_LOCATION_ID}?${qs}`, {
    headers: { Authorization: `Bearer ${PANDORA_API_KEY}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(DAYPLAN_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sessions ${resourceName} ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  return Array.isArray(body.data) ? body.data.length : 0;
}

/**
 * Does BMI's dayplanner say TODAY is a Mega day? Direct Pandora, the source
 * of truth — consulted only on the blind path (flag unavailable AND no mega
 * heat called yet), so the two upstream calls here are rare and one-at-a-time.
 *
 * CONSERVATIVE AND: mega sessions exist AND Blue has none. Requiring the
 * split-track side to be empty means a dayplanner that happens to carry
 * unused Mega rows on an ordinary day can never force the venue into mega
 * mode — the failure direction is "fall through to the calendar", never
 * "wrong mode stated confidently".
 *
 * `null` = could not determine (probe failed, claim lost, Redis down).
 */
export async function megaDayPlannerToday(): Promise<boolean | null> {
  const ymd = businessDayYmdET();
  const verdictKey = `mega-day:${ymd}`;
  try {
    const cached = await redis.get(verdictKey);
    if (cached === "1") return true;
    if (cached === "0") return false;
    if (await redis.get(`mega-day:fail:${ymd}`)) return null;
    const claimed = await redis.set(`mega-day:claim:${ymd}`, "1", "EX", DAYPLAN_CLAIM_TTL_SEC, "NX");
    if (claimed !== "OK") return null;
  } catch {
    return null;
  }
  try {
    const [mega, blue] = await Promise.all([
      countSessionsToday("Mega Track", ymd),
      countSessionsToday("Blue Track", ymd),
    ]);
    const verdict = mega > 0 && blue === 0;
    await redis
      .set(verdictKey, verdict ? "1" : "0", "EX", DAYPLAN_VERDICT_TTL_SEC)
      .catch(() => undefined);
    return verdict;
  } catch {
    await redis.set(`mega-day:fail:${ymd}`, "1", "EX", DAYPLAN_FAIL_TTL_SEC).catch(() => undefined);
    return null;
  }
}

/**
 * The ladder WITHOUT the flag — what the track-status route serves when its
 * upstream is dark past the serve ceiling, so the client fleet inherits the
 * same fallbacks the feed uses.
 */
export async function megaModeWithoutFlag(): Promise<boolean> {
  const races = await loadAllFromRedis().catch(() => ({ blue: null, red: null, mega: null }));
  const dataMega = dataSaysMega(races);
  if (dataMega) return true;
  const dayPlannerMega = await megaDayPlannerToday().catch(() => null);
  return megaLadder({
    flag: null,
    dataMega: false,
    dayPlannerMega,
    calendarMega: businessDayWeekdayET() === "Tue",
  });
}

/** Effective mega mode. Fast path pays 2 Redis reads; the dayplanner and
 *  calendar tiers are consulted only when both live signals are missing. */
export async function megaModeActive(): Promise<boolean> {
  const [flag, races] = await Promise.all([
    readMegaFlag(),
    loadAllFromRedis().catch(() => ({ blue: null, red: null, mega: null })),
  ]);
  const dataMega = dataSaysMega(races);
  if (flag != null || dataMega) {
    return megaLadder({ flag, dataMega, dayPlannerMega: null, calendarMega: false });
  }
  const dayPlannerMega = await megaDayPlannerToday().catch(() => null);
  return megaLadder({
    flag: null,
    dataMega: false,
    dayPlannerMega,
    calendarMega: businessDayWeekdayET() === "Tue",
  });
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
