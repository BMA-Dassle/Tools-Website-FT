/**
 * Race clock state, kept in Redis so every TV sees the same countdown.
 *
 * The clock cannot live in memory: the webhook runs on Vercel lambdas that do
 * not share state, and the pause total is accrued across MESSAGES (a RaceStop
 * now, a RaceStart nine minutes later). So each race gets a small JSON blob and
 * an index sorted by last-update, which is also how stale races age off.
 *
 * Read path is deliberately cheap — a ZRANGEBYSCORE plus one MGET — because
 * every screen in the building polls it.
 */
import redis from "@/lib/redis";
import {
  foldMessageIntoClocks,
  remainingMs,
  CLOCK_STALE_MS,
  type RaceClockState,
} from "./race-clock";

const KEY = (raceId: string) => `kart:raceclock:${raceId}`;
const INDEX_KEY = "kart:raceclock:index";
/** Comfortably past CLOCK_STALE_MS so the index prune, not the TTL, is what
 *  retires a race — the TTL is only a backstop against orphaned keys. */
const STATE_TTL_SECONDS = 4 * 60 * 60;

function parseState(raw: string | null): RaceClockState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as RaceClockState;
    return typeof v?.raceId === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Fold one broadcast message into the clocks it touches.
 *
 * Applied per race in a fixed order — duration change, stop, green, start,
 * finish —
 * so a snapshot carrying more than one record for the same race lands
 * deterministically, with the terminal state winning.
 *
 * NOTE read-modify-write without a lock. Two webhook invocations mutating the
 * SAME race within a few milliseconds could drop one update. Accepted: the
 * bridge now forwards only records that CHANGED (~5 POSTs/minute rather than
 * one a second), so same-race collisions are rare, and the worst case is a
 * pause boundary off by one message which the measured pause at RaceFinish
 * corrects anyway.
 */
export async function updateRaceClocks(message: unknown, receivedAtMs: number): Promise<void> {
  // Cheap pre-pass on an empty map tells us which races this message touches,
  // so we only round-trip Redis for those. Discarded — the real fold happens
  // below against the states we load.
  const probe = foldMessageIntoClocks(new Map(), message, receivedAtMs);
  if (probe.size === 0) return;

  const raceIds = [...probe];
  const clocks = new Map<string, RaceClockState>();
  try {
    const raws = await redis.mget(raceIds.map(KEY));
    raws.forEach((raw, i) => {
      const existing = parseState(raw);
      if (existing) clocks.set(raceIds[i], existing);
    });
  } catch (err) {
    console.error("[race-clock] load failed, folding from empty:", err);
  }

  foldMessageIntoClocks(clocks, message, receivedAtMs);

  for (const raceId of raceIds) {
    const clock = clocks.get(raceId);
    if (!clock) continue;
    try {
      await redis.set(KEY(raceId), JSON.stringify(clock), "EX", STATE_TTL_SECONDS);
      await redis.zadd(INDEX_KEY, clock.updatedAtMs, raceId);
    } catch (err) {
      // Never throw on the webhook's hot path — a clock is a nice-to-have, the
      // race lifecycle actions running alongside it are not.
      console.error(`[race-clock] write failed for race ${raceId}:`, err);
    }
  }

  // Prune anything that has not moved in CLOCK_STALE_MS. Cheap, and keeps the
  // read path from having to filter the whole day's races.
  try {
    await redis.zremrangebyscore(INDEX_KEY, "-inf", `(${receivedAtMs - CLOCK_STALE_MS}`);
    await redis.expire(INDEX_KEY, STATE_TTL_SECONDS);
  } catch {
    /* pruning is best-effort */
  }
}

export interface RaceClockView {
  raceId: string;
  heatName: string;
  heatNumber: number | null;
  track: string | null;
  phase: RaceClockState["phase"];
  /** Server's own computation at serverNowMs — the value to show if a client
   *  cannot be trusted to tick (or has a wrong clock). */
  remainingMs: number | null;
  /** The terms, so a screen can tick locally instead of polling at 1 Hz.
   *  clockStartMs is the GREEN-FLAG anchor (phase two), not actualStartMs —
   *  see race-clock.ts. actualStartMs is carried for reference only. */
  clockStartMs: number | null;
  anchorEstimated: boolean;
  actualStartMs: number | null;
  /** Stamped only when the session CLOSES, ~2min after the chequered flag. A
   *  finished race with this still null is inside the pending-finish window —
   *  the two-phase finish, and the only moment karts are actually rolling in. */
  actualEndMs: number | null;
  durationMs: number | null;
  pausedTotalMs: number;
  pausedSinceMs: number | null;
}

export interface RaceClockSnapshot {
  /** Authoritative clock. Screens correct their own drift against this rather
   *  than trusting a shop TV's system time. */
  serverNowMs: number;
  clocks: RaceClockView[];
}

/** Every race still worth showing, newest activity first. */
export async function readRaceClocks(nowMs = Date.now()): Promise<RaceClockSnapshot> {
  let ids: string[] = [];
  try {
    ids = await redis.zrangebyscore(INDEX_KEY, nowMs - CLOCK_STALE_MS, "+inf");
  } catch (err) {
    console.error("[race-clock] index read failed:", err);
    return { serverNowMs: nowMs, clocks: [] };
  }
  if (!ids.length) return { serverNowMs: nowMs, clocks: [] };

  let raws: (string | null)[] = [];
  try {
    raws = await redis.mget(ids.map(KEY));
  } catch (err) {
    console.error("[race-clock] state read failed:", err);
    return { serverNowMs: nowMs, clocks: [] };
  }

  const clocks: RaceClockView[] = [];
  for (const raw of raws) {
    const c = parseState(raw);
    if (!c) continue;
    clocks.push({
      raceId: c.raceId,
      heatName: c.heatName,
      heatNumber: c.heatNumber,
      track: c.track,
      phase: c.phase,
      remainingMs: remainingMs(c, nowMs),
      clockStartMs: c.clockStartMs,
      anchorEstimated: c.anchorEstimated,
      actualStartMs: c.actualStartMs,
      actualEndMs: c.actualEndMs,
      durationMs: c.durationMs,
      pausedTotalMs: c.pausedTotalMs,
      pausedSinceMs: c.pausedSinceMs,
    });
  }
  clocks.sort((a, b) => (b.actualStartMs ?? 0) - (a.actualStartMs ?? 0));
  return { serverNowMs: nowMs, clocks };
}
