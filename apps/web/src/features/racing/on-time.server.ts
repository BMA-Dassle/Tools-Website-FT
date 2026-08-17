import "server-only";

/**
 * ARE WE ON TIME — read from our own two archives, folded by on-time.ts.
 *
 * The slots and green flags live in `race_timings` (the venue broadcast writes
 * them as the night runs). The call times live on the briefing log's `sent` rows,
 * because that is the only place they are ever durably written — the call itself
 * is a Redis record that ages out ~20 minutes later.
 *
 * ONE ROW PER SESSION on each side, joined on the session id, which is the same
 * id space in both (verified against live assignments — race-finish.server.ts).
 *
 * A MEGA GROUP IS BRIEFED IN BOTH ROOMS, so its session appears on two `sent`
 * rows. The EARLIEST call wins: the desk called the heat once, and the second
 * room's row is the same call written down twice.
 *
 * CACHED IN REDIS for a few seconds. Every board on the property polls this, some
 * at 1s, and the underlying pair of Neon reads is the same answer for all of
 * them. The cache is the fan-in — the same posture races-current uses.
 */
import redis from "@/lib/redis";
import { businessDayYmdET } from "@/lib/race-business-day";
import { listRaceTimings, listRaceTimingsSince } from "./data/race-timings-db";
import {
  MAX_PLAUSIBLE_SPAN_MS,
  RECENT_WINDOW_MS,
  raceByAllowance,
  type RaceByAllowance,
  type WaitStat,
} from "./wait-times";
import { listBriefingEvents } from "~/features/signage/briefing/events-db";
import { onTimeByTrack, type OnTimeHeat, type OnTimeSnapshot } from "./on-time";

export type { OnTimeSnapshot };

const CACHE_KEY = "on-time:v1";

/**
 * Short enough that a board at 1s is never more than a few heats-worth of
 * seconds stale, long enough that a fleet of signage screens costs two Neon
 * reads every few seconds rather than two per screen per second.
 */
const CACHE_TTL_SEC = 8;

/** Join the two archives into the shape the fold wants. */
export async function readOnTimeHeats(
  venue: string,
  businessDay: string,
): Promise<{ heats: OnTimeHeat[]; withSlot: number }> {
  const [timings, events] = await Promise.all([
    listRaceTimings(venue, businessDay),
    listBriefingEvents(venue, businessDay),
  ]);

  // Earliest call per session — see the Mega note in the header.
  const calledBySession = new Map<string, number>();
  for (const e of events) {
    if (e.action !== "sent" || e.calledAtMs == null) continue;
    const prev = calledBySession.get(e.sessionId);
    if (prev == null || e.calledAtMs < prev) calledBySession.set(e.sessionId, e.calledAtMs);
  }

  let withSlot = 0;
  const heats: OnTimeHeat[] = timings.map((t) => {
    if (t.scheduledStartMs != null) withSlot += 1;
    return {
      sessionId: t.sessionId,
      track: t.track,
      heatNumber: t.heatNumber,
      scheduledStartMs: t.scheduledStartMs,
      actualStartMs: t.startedAtMs,
      calledAtMs: calledBySession.get(t.sessionId) ?? null,
    };
  });
  return { heats, withSlot };
}

/**
 * The slot → green flag spans behind "Est. racing by", per track and per window.
 *
 * Owner 2026-08-17: "shouldn't the heats coming up take account of what has
 * happened last hour?" So this reads seven days of race rows and hands
 * `raceByAllowance` three windows to cascade over. Race rows ALONE are enough —
 * both ends of the span are venue stamps on the same row, so no briefing join is
 * needed and a heat with no briefing record still counts.
 */
async function readRaceByByTrack(
  venue: string,
  businessDay: string,
  nowMs: number,
): Promise<Record<string, RaceByAllowance>> {
  const from = businessDayYmdET(new Date(nowMs - 7 * 86_400_000));
  const rows = await listRaceTimingsSince(venue, from, businessDay);

  const spans = new Map<string, { hour: number[]; today: number[]; week: number[] }>();
  for (const r of rows) {
    if (!r.track || r.scheduledStartMs == null || r.startedAtMs == null) continue;
    const ms = r.startedAtMs - r.scheduledStartMs;
    // Same plausibility guard the rest of the module uses: a negative span or a
    // multi-hour one is a pairing problem, not a wait.
    if (ms < 0 || ms > MAX_PLAUSIBLE_SPAN_MS) continue;
    const b = spans.get(r.track) ?? { hour: [], today: [], week: [] };
    b.week.push(ms);
    if (r.businessDay === businessDay) b.today.push(ms);
    if (nowMs - r.startedAtMs <= RECENT_WINDOW_MS) b.hour.push(ms);
    spans.set(r.track, b);
  }

  const out: Record<string, RaceByAllowance> = {};
  for (const [track, b] of spans) {
    out[track] = raceByAllowance({
      lastHour: statOf(b.hour),
      today: statOf(b.today),
      last7Days: statOf(b.week),
    });
  }
  return out;
}

/** The subset of WaitStat the cascade reads, over a raw span list. */
function statOf(values: number[]): WaitStat | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    avgMs: Math.round(s.reduce((t, v) => t + v, 0) / s.length),
    medianMs: at(50),
    p90Ms: at(90),
    minMs: s[0],
    maxMs: s[s.length - 1],
    discarded: 0,
  };
}

/** Compute today's snapshot, no cache. */
export async function computeOnTime(nowMs = Date.now(), venue = "FT"): Promise<OnTimeSnapshot> {
  const businessDay = businessDayYmdET(new Date(nowMs));
  const [{ heats, withSlot }, raceByByTrack] = await Promise.all([
    readOnTimeHeats(venue, businessDay),
    readRaceByByTrack(venue, businessDay, nowMs).catch(() => ({})),
  ]);
  return {
    businessDay,
    tracks: onTimeByTrack(heats, nowMs, raceByByTrack),
    atMs: nowMs,
    slotCoverage: { withSlot, total: heats.length },
  };
}

/**
 * Today's snapshot, Redis-cached.
 *
 * A cache miss computes; a Redis failure computes. This must never be the reason
 * a board goes blank, so every failure path falls through to the live read rather
 * than throwing.
 */
export async function getOnTime(nowMs = Date.now(), venue = "FT"): Promise<OnTimeSnapshot> {
  try {
    const raw = await redis.get(CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as OnTimeSnapshot;
      // A cached snapshot from a PREVIOUS night must not be served as today's.
      if (cached.businessDay === businessDayYmdET(new Date(nowMs))) return cached;
    }
  } catch {
    /* fall through to a live read */
  }

  const snap = await computeOnTime(nowMs, venue);
  try {
    await redis.set(CACHE_KEY, JSON.stringify(snap), "EX", CACHE_TTL_SEC);
  } catch {
    /* best-effort */
  }
  return snap;
}
