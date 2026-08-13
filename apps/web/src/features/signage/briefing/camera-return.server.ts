import "server-only";

/**
 * Reads the three facts the camera return strip needs and hands them to the
 * pure decider (camera-return.ts). All Redis, no Pandora, no vendor call.
 *
 * FOUR ROUND TRIPS, whatever the night looks like: one ZRANGE for the day's
 * scans, one MGET for the distinct sessions' finish markers, one MGET for the
 * distinct cameras' sightings, and one MGET for the called-heat watermarks. A busy
 * Saturday is ~40 heats × ~10 cameras = 400 scans, and it still costs four calls
 * rather than 400.
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
import { listCamerasOutOfService } from "@/lib/camera-maintenance";
import {
  fetchTrackSessions,
  fetchTrackWatermarks,
} from "~/features/reservations-admin/race-live-state.server";
import type { TrackKey } from "~/features/reservations-admin/race-live-state";
import { raceFinishedKey, type RaceFinishedMarker } from "./race-finish.server";
import {
  cameraReturnStripAt,
  type CameraReturnStrip,
  type CameraScan,
  type CameraTrack,
  type SessionFinish,
  type TrackCall,
} from "./camera-return";

/**
 * THE CACHE IS WHAT MAKES THE 2s PULSE AFFORDABLE.
 *
 * The strip rides the fast lane so a registration clears within seconds rather
 * than up to fifteen (owner 2026-08-12: "when we see a register can we clear it
 * pretty fast on the screen?"). A pulse is then one GET of this key; the three
 * round trips behind it happen at most once every three seconds for the whole
 * venue, however many screens are polling.
 *
 * Three seconds rather than one: a camera going green a couple of seconds later
 * than it could is invisible to anyone in the room, and it holds the rebuild rate
 * to a fifth of the pulse rate.
 */
const CACHE_TTL_SECONDS = 3;

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
const STALE: CameraReturnFeed = { stillOut: [], incoming: [], outCount: 0, stale: true };

const TRACKS: TrackKey[] = ["blue", "red", "mega"];

/** The marker's `track` is a loose string off the venue wire. Anything we do not
 *  recognise becomes null so a box falls back to a neutral outline instead of
 *  being painted the wrong circuit's colour. */
function narrowTrack(t: string | null | undefined): "blue" | "red" | "mega" | null {
  return t === "blue" || t === "red" || t === "mega" ? t : null;
}

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
): Promise<Map<string, SessionFinish>> {
  const out = new Map<string, SessionFinish>();
  const now = new Date(nowMs);
  const ymds = [...new Set([calendarYmdET(now), businessDayYmdET(now)])];
  // The track comes free here: each list was fetched FOR a track, so we know which
  // circuit every session in it ran on without parsing a heat name.
  const lists = await Promise.all(
    ymds.flatMap((ymd) =>
      TRACKS.map(async (t) => ({
        track: t,
        list: await fetchTrackSessions(t, ymd).catch(() => null),
      })),
    ),
  );
  for (const { track, list } of lists) {
    if (!list) continue;
    for (const s of list) {
      const sid = String(s.sessionId);
      if (!sessionIds.has(sid) || out.has(sid)) continue;
      const endedAtMs = s.actualEnd ? Date.parse(s.actualEnd) : Number.NaN;
      if (!Number.isFinite(endedAtMs) || endedAtMs > nowMs) continue;
      out.set(sid, {
        endedAtMs,
        heatNumber: Number.isFinite(s.heatNumber) ? s.heatNumber : null,
        track,
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
      const empty: CameraReturnStrip = { stillOut: [], incoming: [], outCount: 0 };
      await redis
        .set(cacheKey(venue), JSON.stringify(empty), "EX", CACHE_TTL_SECONDS)
        .catch(() => void 0);
      return empty;
    }

    /**
     * CAMERAS ON THE BENCH ARE NOT MISSING (owner 2026-08-12 — the strip found
     * six units that had filmed nothing in 8 to 89 days, so 3, 6 and 31 went on a
     * maintenance list). A known-broken camera never registers, so without this it
     * would sit red every night forever, and permanent reds are how a board
     * teaches staff to ignore it.
     *
     * Filtered at the SCAN level rather than at the end, so a benched camera
     * cannot leak into a count, an order or a section boundary. Cached 30s in
     * lib/camera-maintenance, and an empty set on failure means the wall behaves
     * exactly as it did before the list existed.
     */
    const benched = await listCamerasOutOfService().catch(() => new Set<string>());

    const scans: CameraScan[] = [];
    let skippedBenched = 0;
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
      if (benched.has(camera)) {
        skippedBenched += 1;
        continue;
      }
      scans.push({ camera, sessionId, assignedAtMs });
    }
    // Entries existed but none survived parsing — the index is corrupt, not
    // empty, so say stale rather than all-clear. Unless the only thing filtered
    // was benched cameras, which is a genuine all-clear.
    if (scans.length === 0) {
      const resolved: CameraReturnStrip = { stillOut: [], incoming: [], outCount: 0 };
      const answer: CameraReturnFeed = skippedBenched > 0 ? resolved : STALE;
      await redis
        .set(cacheKey(venue), JSON.stringify(answer), "EX", CACHE_TTL_SECONDS)
        .catch(() => void 0);
      return answer;
    }

    // ── 2. which of those races have finished ────────────────────────
    const sessionIds = [...new Set(scans.map((s) => s.sessionId))];
    const finishes = new Map<string, SessionFinish>();
    const markerRaws = await redis.mget(...sessionIds.map(raceFinishedKey));
    markerRaws.forEach((v, i) => {
      if (!v) return;
      try {
        const m = JSON.parse(v) as RaceFinishedMarker;
        if (Number.isFinite(m.endedAtMs)) {
          finishes.set(sessionIds[i], {
            endedAtMs: m.endedAtMs,
            heatNumber: m.heatNumber ?? null,
            track: narrowTrack(m.track),
          });
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

    // ── 4. what has been CALLED, which is what settles the incoming section ──
    // Reads the same `pandora:last-race:*` keys the track boards' "called" state
    // rides, so the strip and the check-in walls agree about which heat is up.
    const calledHeats = new Map<CameraTrack, TrackCall>();
    const marks = await fetchTrackWatermarks().catch(
      (): Partial<Record<TrackKey, { heatNumber: number; calledAt: string }>> => ({}),
    );
    for (const t of TRACKS) {
      const h = marks[t]?.heatNumber;
      if (typeof h !== "number" || !Number.isFinite(h)) continue;
      // `calledAt` is what makes the call usable — heat numbers run ahead of
      // finishes, so the TIME is the trigger. A watermark with no parseable
      // calledAt leaves the camera on the time bound rather than settling it.
      const calledAtMs = Date.parse(marks[t]?.calledAt ?? "");
      calledHeats.set(t, { heatNumber: h, calledAtMs });
    }

    const strip = cameraReturnStripAt({ scans, finishes, seen, calledHeats, nowMs });
    await redis
      .set(cacheKey(venue), JSON.stringify(strip), "EX", CACHE_TTL_SECONDS)
      .catch(() => void 0);
    return strip;
  } catch {
    return STALE;
  }
}
