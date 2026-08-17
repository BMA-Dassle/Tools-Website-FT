import "server-only";

/**
 * THE TRACK INCIDENT HANDLER — emergency stops, session starts, finishes, and
 * the desk pauses in between.
 *
 * Rides /api/webhooks/kart-timing-event alongside handleVenueMessage (live
 * effects) and updateRaceClocks (clock bookkeeping). A third concern, kept
 * separate for the same reason those two are: this one writes an append-only
 * SAFETY RECORD, and it must not be entangled with a radio call or a countdown.
 *
 * WHY NOT A CRON, since everything else that samples the track is one. The
 * whole of heat 60's worst incident — E-stop, pause, five karts flagged, resume,
 * all-clear — took 76 seconds, and a once-a-minute sampler cannot stamp that
 * with any honesty. The events are pushed with the venue's own timestamps, the
 * webhook already receives them, and `kart:events:queue` (which a cron would
 * have to read) evicts inside ~90 minutes. There is also no second source to
 * fall back to: unlike a race finish, an emergency exists ONLY on this wire.
 *
 * ─── THE E-STOP SUPPRESSION RULE ──────────────────────────────────────────
 *
 * Pressing the button pauses the race. Measured on the wire 2026-08-16: E-stop
 * at 23:15:02.651, `SessionPausedNotification` at 23:15:03.211 — 0.56s later.
 * They are one incident, and logging both would put two rows and two bookmarks
 * on every one of the track's fifteen-to-eighteen cameras for a single event
 * (owner: "we pause after estop so don't need both logged").
 *
 * So an emergency raises a marker, and a pause or resume arriving while it is
 * raised is treated as part of that incident and neither logged nor marked.
 * The `emergency-on` bookmark's span is widened to cover what the pause marker
 * would have covered, and its description says so.
 *
 * THIS MAKES A `paused` ROW MEANINGFUL. It now means a DESK pause — staff
 * stopping the race at the console with nobody on the button. Heat 60 had one
 * of those too, at 23:13:36, ninety seconds before the first E-stop, and the
 * two being distinguishable is the useful part.
 *
 * FAILURE DIRECTION IS DELIBERATE. If the ordering ever inverts, or the marker
 * is lost to a Redis blip, the pause logs on its own — redundant, never
 * missing. A safety log may repeat itself; it may not go quiet.
 *
 * Never throws. The webhook's 200 does not depend on this module.
 */
import redis from "@/lib/redis";
import {
  extractEmergencies,
  extractSessionLifecycle,
  type SessionLifecycleKind,
  type VenueSessionLifecycle,
} from "./venue-broadcast";
import { recordTrackEvent, type TrackEventAction } from "./data/track-events-db";
import {
  bookmarkRaceEvent,
  type RacePhase,
} from "~/features/signage/briefing/race-bookmarks.server";
import { raceBookmarksEnabled } from "~/features/signage/briefing/race-bookmarks-setting.server";
import { parseCameraTrack } from "~/features/signage/nx/track-cameras";
import type { TrackKey } from "~/features/signage/track";

/**
 * WHICH SESSION IS ON A TRACK RIGHT NOW — written here, read here.
 *
 * The only reason this exists: an emergency record names a track and nothing
 * else, so the heat it happened during has to come from somewhere. Nothing
 * already stored answers it — `race:live-heat:{track}` carries a heat NUMBER
 * and no session id, and `pit:race-started:{sessionId}` is keyed the other way
 * round. Both start and finish arrive on this same wire, so the key is
 * maintained from one source and never disagrees with itself.
 *
 * Long enough to outlast any heat plus its pending-finish window; short enough
 * that a missed finish cannot mis-attribute tomorrow's E-stop.
 */
const CURRENT_SESSION_TTL_SECONDS = 2 * 3600;

function currentSessionKey(track: TrackKey): string {
  return `track:current-session:${track}`;
}

export interface CurrentSession {
  sessionId: string;
  heatNumber: number | null;
  heatName: string | null;
}

async function readCurrentSession(track: TrackKey): Promise<CurrentSession | null> {
  try {
    const raw = await redis.get(currentSessionKey(track));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CurrentSession;
    return parsed && typeof parsed.sessionId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The emergency marker. Its TTL is the safety valve: if the all-clear is never
 * delivered — a bridge blip mid-incident — a stuck marker would suppress every
 * desk pause for the rest of the night, which is the one failure mode worse
 * than a duplicate row. Ten minutes is far longer than any E-stop observed and
 * far shorter than an evening.
 */
const EMERGENCY_MARKER_TTL_SECONDS = 600;

function emergencyKey(track: TrackKey): string {
  return `race:emergency-active:${track}`;
}

async function emergencyActive(track: TrackKey): Promise<boolean> {
  try {
    return (await redis.get(emergencyKey(track))) !== null;
  } catch {
    // Unreadable Redis means we cannot prove an emergency is running, so the
    // pause logs. Redundant beats missing — see the header.
    return false;
  }
}

/** Once per (action, track, venue stamp). The venue's stamp is stable across
 *  replays, so this collapses the broadcast's re-sends exactly while leaving two
 *  genuinely distinct events twelve seconds apart as two events. */
const CLAIM_TTL_SECONDS = 30 * 3600;

async function claim(key: string): Promise<boolean> {
  try {
    return (await redis.set(key, "1", "EX", CLAIM_TTL_SECONDS, "NX")) === "OK";
  } catch {
    // No claim, no write — the same posture bookmarkRaceEvent takes. A replayed
    // broadcast writing the incident twice is worse than one lost to a blip,
    // and the blip is transient while the replay is certain.
    return false;
  }
}

const LIFECYCLE_ACTIONS: Record<SessionLifecycleKind, TrackEventAction> = {
  started: "session-start",
  finished: "session-end",
  paused: "paused",
  resumed: "resumed",
};

/** Only the interruption phases get a camera marker from this module. Start and
 *  end are ALREADY bookmarked off the race records by race-finish.server.ts,
 *  with the same venue stamps — marking them again here would double every
 *  session marker on every camera. They are still LOGGED, because the log is
 *  new and the bookmarks are not. */
const LIFECYCLE_PHASES: Partial<Record<SessionLifecycleKind, RacePhase>> = {
  paused: "paused",
  resumed: "resumed",
};

/** Mark a track's cameras, gated on the kill switch, swallowing everything.
 *  Mirrors markRaceCameras in race-finish.server.ts — a camera system having a
 *  bad night must never reach the log write, let alone the webhook. */
async function mark(args: {
  track: TrackKey;
  sessionId: string;
  heatNumber: number | null;
  heatName: string | null;
  phase: RacePhase;
  atMs: number;
}): Promise<number> {
  try {
    const cameraTrack = parseCameraTrack(args.track);
    if (!cameraTrack) return 0;
    if (!(await raceBookmarksEnabled())) return 0;
    return await bookmarkRaceEvent({ ...args, track: cameraTrack });
  } catch (err) {
    console.error(`[track-events] ${args.phase} bookmark failed`, err);
    return 0;
  }
}

async function handleLifecycle(ev: VenueSessionLifecycle): Promise<void> {
  if (ev.track === null || ev.atMs === null) return;
  const track = ev.track;

  // TRACK → SESSION, maintained before anything else so an emergency landing in
  // the same message can already resolve it.
  if (ev.kind === "started") {
    await redis
      .set(
        currentSessionKey(track),
        JSON.stringify({
          sessionId: ev.sessionId,
          heatNumber: ev.heatNumber,
          heatName: ev.sessionName || null,
        } satisfies CurrentSession),
        "EX",
        CURRENT_SESSION_TTL_SECONDS,
      )
      .catch(() => void 0);
  } else if (ev.kind === "finished") {
    // Cleared rather than left to expire: an emergency between heats belongs to
    // NO session, and inheriting the last one would be a fabricated claim.
    await redis.del(currentSessionKey(track)).catch(() => void 0);
  }

  // THE SUPPRESSION. Only the interruption pair — a start or finish during an
  // emergency is still a real, separate fact about the session.
  if (ev.kind === "paused" || ev.kind === "resumed") {
    if (await emergencyActive(track)) return;
  }

  if (!(await claim(`track-event:${track}:${ev.kind}:${ev.atMs}`))) return;

  const phase = LIFECYCLE_PHASES[ev.kind];
  const camerasMarked = phase
    ? await mark({
        track,
        sessionId: ev.sessionId,
        heatNumber: ev.heatNumber,
        heatName: ev.sessionName || null,
        phase,
        atMs: ev.atMs,
      })
    : null;

  await recordTrackEvent({
    track,
    action: LIFECYCLE_ACTIONS[ev.kind],
    atMs: ev.atMs,
    sessionId: ev.sessionId,
    heatNumber: ev.heatNumber,
    heatName: ev.sessionName || null,
    camerasMarked,
    source: "push",
  });
}

async function handleEmergency(track: TrackKey, on: boolean, atMs: number): Promise<void> {
  // MARKER FIRST, CLAIM SECOND. The marker is what suppresses the pause landing
  // half a second later, so it has to be up before anything can await on it —
  // and it must still be set even when the claim fails on a replay, or a
  // re-delivered E-stop would let its pause through as a phantom desk pause.
  if (on) {
    await redis
      .set(emergencyKey(track), String(atMs), "EX", EMERGENCY_MARKER_TTL_SECONDS)
      .catch(() => void 0);
  } else {
    await redis.del(emergencyKey(track)).catch(() => void 0);
  }

  if (!(await claim(`track-event:${track}:emergency-${on ? "on" : "off"}:${atMs}`))) return;

  // WHICH HEAT — inferred, never asserted. The wire says only which track.
  const current = await readCurrentSession(track);

  const camerasMarked = await mark({
    track,
    // The bookmark claim needs SOMETHING stable and unique. An emergency has no
    // session of its own, so it is keyed on the track and its own stamp — which
    // is exactly as unique as the event is.
    sessionId: current?.sessionId ?? `${track}-emergency`,
    heatNumber: current?.heatNumber ?? null,
    heatName: current?.heatName ?? null,
    phase: on ? "emergency-on" : "emergency-off",
    atMs,
  });

  await recordTrackEvent({
    track,
    action: on ? "emergency-on" : "emergency-off",
    atMs,
    // sessionId stays NULL — the wire never named one. See track-events-db.ts.
    sessionId: null,
    inferredSessionId: current?.sessionId ?? null,
    heatNumber: current?.heatNumber ?? null,
    heatName: current?.heatName ?? null,
    camerasMarked,
    source: "push",
  });
}

/**
 * Act on one webhook message, IN WIRE ORDER.
 *
 * The order is load-bearing in both directions, which is why the records are
 * walked one at a time rather than extracted by type:
 *
 *  - an emergency must be handled AFTER a session start in the same message,
 *    or it reads the previous heat out of `track:current-session` and files the
 *    E-stop against the wrong session;
 *  - a pause must be handled AFTER the emergency that caused it, or the marker
 *    is not up yet and the pause is logged as a phantom desk pause.
 *
 * Wire order satisfies both because it IS causal order — the venue emits the
 * E-stop 0.56s before the pause it triggers, and the bridge forwards serially.
 * Sorting by type, as this first did, satisfies only the second.
 *
 * Each record matches at most one extractor, so calling both per record costs
 * two cheap type checks and keeps the extractors pure and separately testable.
 */
export async function handleTrackEvents(message: unknown): Promise<void> {
  try {
    const records = Array.isArray(message) ? message : [message];
    for (const rec of records) {
      for (const em of extractEmergencies(rec)) {
        if (em.track === null || em.atMs === null) continue;
        await handleEmergency(em.track, em.on, em.atMs);
      }
      for (const ev of extractSessionLifecycle(rec)) {
        await handleLifecycle(ev);
      }
    }
  } catch (err) {
    console.error("[track-events] handler failed", err);
  }
}
