import "server-only";

/**
 * Reads the three facts the camera return strip needs and hands them to the
 * pure decider (camera-return.ts). All Redis, no Pandora, no vendor call.
 *
 * THREE ROUND TRIPS, whatever the night looks like: one ZRANGE for the day's
 * scans, one MGET for the distinct sessions' finish markers, one MGET for the
 * distinct cameras' sightings. A busy Saturday is ~40 heats × ~10 cameras = 400
 * scans, and it still costs three calls rather than 400.
 *
 * ONE BUILD SERVES EVERY SCREEN. Both briefing TVs poll the feed independently
 * and a laptop preview makes a third, so the result is cached in Redis for
 * `CACHE_TTL_SECONDS` — the same posture as the sessions proxy's shared key.
 * Without it, three screens would each pay the read every 15 seconds to compute
 * a byte-identical answer.
 *
 * NEVER RETURNS NULL, and that is load-bearing rather than defensive style.
 * The scene reserves the strip's 104 px whenever this section is present, so if a
 * failed Redis read collapsed it to `null` the boards would spring back to full
 * height and then shrink again on the next good poll — a visible jolt on the wall,
 * mid-briefing, which is exactly the motion the whole design removes. A failed
 * read is therefore reported as `stale`, keeping the strip's shape while refusing
 * to claim "all in" when we do not know. `null` on the rail means one thing only:
 * the kill switch is off.
 */
import redis from "@/lib/redis";
import { businessDayYmdET, calendarYmdET } from "@/lib/race-business-day";
import { scanLogKey, cameraSeenKey } from "@/lib/camera-assign";
import { fetchTrackSessions } from "~/features/reservations-admin/race-live-state.server";
import type { TrackKey } from "~/features/reservations-admin/race-live-state";
import { raceFinishedKey, type RaceFinishedMarker } from "./race-finish.server";
import {
  cameraReturnStripAt,
  type CameraReturnStrip,
  type CameraScan,
  type SessionFinish,
} from "./camera-return";

/**
 * Shorter than the 15s feed cadence it serves, so a screen never paints a strip
 * a whole poll out of date, but long enough that the second and third screen of
 * the same tick are free.
 */
const CACHE_TTL_SECONDS = 10;

/** The strip is a whole-venue fact — both rooms show the same one — so the
 *  cache key is per venue and not per screen or per room. */
function cacheKey(venue: string): string {
  return `camera-return:strip:${venue}`;
}

/** One entry of `camera-scan-log:{day}`. Field names are fixed by 02528335. */
interface ScanLogEntry {
  sys?: string;
  sid?: string;
  at?: string;
}

export interface CameraReturnFeed extends CameraReturnStrip {
  /** We could not read the facts, so the strip holds its space but says so
   *  rather than showing an all-clear it cannot stand behind. */
  stale?: boolean;
}

/** Shape returned when the read fails — keeps the strip's 104 px, claims nothing. */
const STALE: CameraReturnFeed = { boxes: [], outCount: 0, stale: true };

const TRACKS: TrackKey[] = ["blue", "red", "mega"];

/**
 * PANDORA IS THE BACKSTOP FOR THE FLAG, and it is not optional.
 *
 * Measured on 2026-08-12: only 5 of 17 scanned sessions that had already run
 * carried a `briefing:race-finished` marker, because the kart-timing bridge drops
 * pushes (a 2.5h hole on 8/11, heartbeat 23 minutes stale while this was being
 * built). A camera whose race we never learned had finished never becomes due, so
 * bridge-only the strip would silently miss most of the night — and a board that
 * misses two thirds of the heats teaches staff to ignore it.
 *
 * So any session with no marker is looked up in Pandora's own `actualEnd`, exactly
 * the fallback `resolveWelcomeBack` already keeps for the same reason. Read
 * WITHOUT `fresh`, unlike that path: the marker is the fast lane and this is only
 * catching what it dropped, so the shared 15s cache (already warmed by the admin
 * board, the day-of pay sweep and the 2-minute cron) is enough and adds no live
 * Pandora load. A camera going red 15 seconds later than it might have is not
 * worth a fourth reader hitting the vendor.
 *
 * Keyed by CALENDAR day, not business day — that is how Pandora's session lists
 * are keyed. Between midnight and 2 AM the two differ, so both are fetched or a
 * post-midnight heat's cameras would never come due.
 */
async function pandoraFinishes(
  sessionIds: Set<string>,
  nowMs: number,
): Promise<Map<string, { endedAtMs: number; heatNumber: number | null }>> {
  const out = new Map<string, { endedAtMs: number; heatNumber: number | null }>();
  const now = new Date(nowMs);
  const ymds = [...new Set([calendarYmdET(now), businessDayYmdET(now)])];
  const lists = await Promise.all(
    ymds.flatMap((ymd) => TRACKS.map((t) => fetchTrackSessions(t, ymd).catch(() => null))),
  );
  for (const list of lists) {
    if (!list) continue;
    for (const s of list) {
      const sid = String(s.sessionId);
      if (!sessionIds.has(sid) || out.has(sid)) continue;
      const endedAtMs = s.actualEnd ? Date.parse(s.actualEnd) : Number.NaN;
      if (!Number.isFinite(endedAtMs) || endedAtMs > nowMs) continue;
      out.set(sid, {
        endedAtMs,
        heatNumber: Number.isFinite(s.heatNumber) ? s.heatNumber : null,
      });
    }
  }
  return out;
}

/**
 * Today's strip, or null when it cannot be built.
 *
 * `nowMs` is passed in rather than read here so the caller's clock is the single
 * source of time for one feed build — the same reason briefingTimelineAt takes
 * it. It also makes the whole path testable end to end.
 */
export async function resolveCameraReturn(venue: string, nowMs: number): Promise<CameraReturnFeed> {
  try {
    const cached = await redis.get(cacheKey(venue)).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as CameraReturnFeed;
      } catch {
        /* fall through and rebuild */
      }
    }

    // ── 1. who went out today ────────────────────────────────────────
    const raw = await redis.zrange(scanLogKey(businessDayYmdET(new Date(nowMs))), 0, -1);
    if (!raw || raw.length === 0) {
      const empty: CameraReturnStrip = { boxes: [], outCount: 0 };
      await redis
        .set(cacheKey(venue), JSON.stringify(empty), "EX", CACHE_TTL_SECONDS)
        .catch(() => void 0);
      return empty;
    }

    const scans: CameraScan[] = [];
    for (const r of raw) {
      let e: ScanLogEntry;
      try {
        e = JSON.parse(r) as ScanLogEntry;
      } catch {
        continue;
      }
      const camera = String(e.sys ?? "").trim();
      const sessionId = String(e.sid ?? "").trim();
      const assignedAtMs = e.at ? Date.parse(e.at) : Number.NaN;
      if (!camera || !sessionId || !Number.isFinite(assignedAtMs)) continue;
      scans.push({ camera, sessionId, assignedAtMs });
    }
    // Entries existed but none survived parsing — the index is corrupt, not
    // empty, so say stale rather than all-clear.
    if (scans.length === 0) return STALE;

    // ── 2. which of those races have finished ────────────────────────
    const sessionIds = [...new Set(scans.map((s) => s.sessionId))];
    const finishes = new Map<string, SessionFinish>();
    const markerRaws = await redis.mget(...sessionIds.map(raceFinishedKey));
    markerRaws.forEach((v, i) => {
      if (!v) return;
      try {
        const m = JSON.parse(v) as RaceFinishedMarker;
        if (Number.isFinite(m.endedAtMs)) {
          finishes.set(sessionIds[i], { endedAtMs: m.endedAtMs, heatNumber: m.heatNumber ?? null });
        }
      } catch {
        /* a marker we cannot read is a race we treat as unfinished */
      }
    });

    // Whatever the bridge dropped, Pandora still knows about — see the note on
    // pandoraFinishes. Marker wins where both exist: it is the venue's own stamp,
    // seconds after the flag rather than ~40s later.
    const missing = new Set(sessionIds.filter((s) => !finishes.has(s)));
    if (missing.size > 0) {
      for (const [sid, fin] of await pandoraFinishes(missing, nowMs)) {
        finishes.set(sid, fin);
      }
    }

    // ── 3. when each camera was last seen ────────────────────────────
    const cameras = [...new Set(scans.map((s) => s.camera))];
    const seen = new Map<string, number>();
    const seenRaws = await redis.mget(...cameras.map(cameraSeenKey));
    seenRaws.forEach((v, i) => {
      if (!v) return;
      const ms = Number(v);
      if (Number.isFinite(ms)) seen.set(cameras[i], ms);
    });

    const strip = cameraReturnStripAt({ scans, finishes, seen, nowMs });
    await redis
      .set(cacheKey(venue), JSON.stringify(strip), "EX", CACHE_TTL_SECONDS)
      .catch(() => void 0);
    return strip;
  } catch {
    return STALE;
  }
}
