import "server-only";

/**
 * MARK THE WHOLE TRACK when a session starts, pauses, resumes or ends.
 *
 * WHY EVERY CAMERA (owner 2026-08-14: "I'd like you to write this to all the
 * cameras for that track"). The briefing bookmarks in bookmarks.server.ts go to
 * one camera because a briefing happens in one room. A race happens across
 * fifteen to eighteen of them, and the whole point of the marker is that you do
 * not know in advance which camera caught the thing you will later be asked
 * about. Marking only the finish line would mean an incident at turn 7 is found
 * by scrubbing, which is the problem bookmarks exist to remove.
 *
 * ─── THE REPLAY TRAP, WHICH IS THE WHOLE RISK HERE ───────────────────────
 *
 * The venue broadcast re-sends THE WHOLE DAY'S RACE LIST on every state change,
 * and replays it again in reconnect catch-up dumps. Unclaimed, one evening's
 * pushes would write the same "session 43 started" bookmark to eighteen cameras
 * several hundred times over. Every event therefore takes an NX claim keyed to
 * (race, phase) BEFORE any camera is touched — the same discipline
 * race-finish.server.ts already applies to its Neon writes, for the same reason.
 * A claim that cannot be taken (Redis down) means NO write: duplicated markers
 * across eighteen ribbons is a far worse outcome than a missing one.
 *
 * VOLUME IS REAL AND DELIBERATE. Blue has ~15 cameras, red ~18, and a Mega heat
 * runs the joined circuit so it marks ~33. Four events across a sixty-heat
 * Saturday is on the order of two to three thousand bookmarks a night. That is
 * what was asked for and Nx stores it happily, but it is also why the kill
 * switch exists and why `briefing`-vs-`race` is a tag: an evening's ribbon is
 * only readable if you can filter it.
 *
 * BEST EFFORT, LIKE EVERY OTHER MARKER. This rides an ingest webhook that also
 * fires the return radio and captures standings. Nothing here may throw into
 * that path, delay it meaningfully, or fail it.
 */
import redis from "@/lib/redis";
import { listCameras, nxConfigured, nxRelayPost } from "../nx/camera.server";
import { camerasForTrack, type CameraTrack, type NamedCamera } from "../nx/track-cameras";

/* ── which cameras, cached ────────────────────────────────────────────── */

/**
 * The device list changes when somebody adds a camera, which is a once-a-year
 * event, but it is a 162-device payload and a race night asks for it every few
 * minutes. Ten minutes of cache keeps a rename visible within one heat while
 * costing one call an hour.
 */
const DEVICE_CACHE_MS = 10 * 60_000;
let deviceCache: { at: number; cameras: NamedCamera[] } | null = null;

async function trackCameras(track: CameraTrack): Promise<NamedCamera[]> {
  const now = Date.now();
  if (!deviceCache || now - deviceCache.at > DEVICE_CACHE_MS) {
    const cameras = await listCameras();
    deviceCache = { at: now, cameras };
  }
  return camerasForTrack(deviceCache.cameras, track);
}

/* ── the four events ──────────────────────────────────────────────────── */

export type RacePhase = "start" | "paused" | "resumed" | "end" | "emergency-on" | "emergency-off";

/** How much footage each marker spans, per phase.
 *
 *  A START and an END are instants worth a minute either side. A PAUSE is not:
 *  it is the visible symptom of something that happened just BEFORE it — a
 *  spin, a stall, a marshal walking out — so its range leads in far enough to
 *  contain the cause rather than only the consequence. The resume marker is the
 *  other end of that same interruption and needs no lead-in.
 *
 *  AN EMERGENCY STOP IS THE WIDEST OF ALL, and it stands in for the pause it
 *  causes. Measured on the wire 2026-08-16: the E-stop lands 0.56s BEFORE the
 *  session pauses, so the two are one incident and only this one is marked
 *  (owner: "we pause after estop so don't need both logged"). Its span
 *  therefore has to cover what the pause marker would have covered — the same
 *  two-minute lead-in to catch the cause, and longer after, because whatever
 *  made somebody hit the button is still being dealt with.
 */
const SPAN_MS: Record<RacePhase, { leadInMs: number; durationMs: number }> = {
  start: { leadInMs: 15_000, durationMs: 60_000 },
  paused: { leadInMs: 120_000, durationMs: 150_000 },
  resumed: { leadInMs: 10_000, durationMs: 45_000 },
  end: { leadInMs: 15_000, durationMs: 90_000 },
  "emergency-on": { leadInMs: 120_000, durationMs: 180_000 },
  "emergency-off": { leadInMs: 15_000, durationMs: 60_000 },
};

const PHASE_WORDS: Record<RacePhase, string> = {
  start: "started",
  paused: "paused",
  resumed: "resumed",
  end: "finished",
  "emergency-on": "STOPPED — emergency",
  "emergency-off": "emergency cleared",
};

/** Claims outlive a race night and expire before the next one. */
const CLAIM_TTL_SECONDS = 30 * 3600;

/**
 * How many cameras to write at once.
 *
 * Sequential across eighteen cameras is six or seven seconds of the webhook's
 * after() window; unbounded is eighteen simultaneous connections to the venue's
 * NVR every time a race changes state. Six is quick (about three rounds) and
 * leaves the relay room to serve the boards that guests can see.
 */
const WRITE_CONCURRENCY = 6;

export interface RaceBookmarkArgs {
  track: CameraTrack;
  /** Pandora/RaceId — the same id space as briefing_assignments.session_id. */
  sessionId: string;
  heatNumber: number | null;
  /** e.g. "43 - Blue Starter", straight off the wire when we have it. */
  heatName?: string | null;
  phase: RacePhase;
  /** Epoch ms of the moment. For start/end this is the VENUE's own stamp. */
  atMs: number;
  /**
   * True when the moment was sampled rather than reported — the pause watcher
   * polls once a minute, so its stamp can trail the real transition by up to
   * that long. Said plainly in the description, because a marker that implies
   * a precision it does not have is worse than one that admits the window.
   */
  sampled?: boolean;
}

/**
 * Write one race event to every camera on its track.
 *
 * Returns how many cameras were marked; 0 covers "already claimed", "Nx not
 * configured" and "nothing matched", all of which are ordinary.
 */
export async function bookmarkRaceEvent(args: RaceBookmarkArgs): Promise<number> {
  if (!nxConfigured() || !args.sessionId || !Number.isFinite(args.atMs)) return 0;

  // CLAIM FIRST — see the replay trap in the header. Start and end happen once
  // per race and need no suffix. The interruption phases can each happen
  // repeatedly within one heat, so they carry an occurrence suffix — and WHICH
  // suffix depends on how good the stamp is:
  //
  //   sampled  the watcher stamps Date.now(), which differs on every run, so an
  //            exact key would never dedupe. The minute it was seen in is the
  //            finest bucket that still collapses re-observations.
  //   pushed   the venue's own stamp, identical across every replay of the same
  //            event, so the stamp IS the identity. Exact, and it has to be:
  //            heat 60 was E-stopped twice inside minute 23:18 (23:18:08.809 and
  //            23:18:20.574, twelve seconds apart) and a minute bucket would
  //            have thrown the second incident away as a duplicate.
  const repeatable =
    args.phase === "paused" ||
    args.phase === "resumed" ||
    args.phase === "emergency-on" ||
    args.phase === "emergency-off";
  const bucket = !repeatable
    ? ""
    : args.sampled
      ? `:${Math.floor(args.atMs / 60_000)}`
      : `:${args.atMs}`;
  const claimKey = `bookmark:race:${args.sessionId}:${args.phase}${bucket}`;
  try {
    const claim = await redis.set(claimKey, String(args.atMs), "EX", CLAIM_TTL_SECONDS, "NX");
    if (claim !== "OK") return 0;
  } catch {
    // No claim, no write. Duplicated markers on eighteen ribbons are worse than
    // a missing one, and the broadcast WILL re-send this event.
    return 0;
  }

  let cameras: NamedCamera[];
  try {
    cameras = await trackCameras(args.track);
  } catch (err) {
    console.error("[race-bookmark] device list failed", err);
    return 0;
  }
  if (cameras.length === 0) return 0;

  const span = SPAN_MS[args.phase];
  const startTimeMs = Math.floor(args.atMs - span.leadInMs);
  const emergency = args.phase === "emergency-on" || args.phase === "emergency-off";
  // An E-stop is the TRACK's event, not the session's — the wire does not even
  // tell us which heat it belongs to. Naming it after the incident rather than
  // the session is what makes it findable in a ribbon of session markers.
  const name = emergency
    ? "EMERGENCY STOP"
    : args.heatNumber != null
      ? `Session ${args.heatNumber}`
      : "Session";
  const heat = args.heatName ? ` (${args.heatName})` : "";
  const when = args.sampled
    ? " Detected by a once-a-minute check, so the exact moment is within the minute before this marker."
    : "";
  const trackWord =
    args.track === "mega" ? "Mega" : args.track[0].toUpperCase() + args.track.slice(1);
  // The pause an E-stop causes is not marked separately, so this marker has to
  // say that it covers it — otherwise the ribbon looks like the race carried on.
  const description = emergency
    ? `${trackWord} track ${PHASE_WORDS[args.phase]}${heat}.` +
      (args.phase === "emergency-on"
        ? " The session pause that follows is part of this incident and is not marked separately."
        : "") +
      when
    : `${trackWord} track session ${PHASE_WORDS[args.phase]}${heat}.${when}`;
  const tags = ["race", args.phase, `${args.track} track`, ...(emergency ? ["emergency"] : [])];

  const body = { name, description, startTimeMs, durationMs: span.durationMs, tags };
  const writeOne = async (cam: NamedCamera): Promise<boolean> => {
    try {
      const res = await nxRelayPost(
        `/rest/v4/devices/${encodeURIComponent(cam.id)}/bookmarks`,
        body,
      );
      return res.ok;
    } catch {
      return false;
    }
  };

  const runPass = async (targets: NamedCamera[]): Promise<NamedCamera[]> => {
    const failed: NamedCamera[] = [];
    for (let i = 0; i < targets.length; i += WRITE_CONCURRENCY) {
      const batch = targets.slice(i, i + WRITE_CONCURRENCY);
      const results = await Promise.all(batch.map(writeOne));
      results.forEach((ok, j) => {
        if (!ok) failed.push(batch[j]);
      });
    }
    return failed;
  };

  /**
   * ONE RETRY, FOR THE STRAGGLERS ONLY.
   *
   * Measured on the real fan-out (2026-08-14): a first pass across the 15 blue
   * cameras landed 14 — the relay drops roughly one write in fifteen, the same
   * flakiness that makes motion.server.ts retry its empty bodies. Left alone
   * that is ~7% of cameras missing a marker, which over a night means somebody
   * eventually opens the one camera that has no bookmark on it and concludes
   * the session was not recorded.
   *
   * A second attempt at ONLY the failures fixes that for the cost of a handful
   * of requests. It is deliberately not a loop: past two attempts the NVR is
   * having a genuine problem, and hammering it would be worse than a gap.
   */
  const stillFailing = await runPass(cameras);
  const retried = stillFailing.length > 0 ? await runPass(stillFailing) : [];
  const written = cameras.length - retried.length;

  if (retried.length > 0) {
    console.error(
      `[race-bookmark] ${args.phase} session ${args.heatNumber ?? args.sessionId}: ` +
        `${written}/${cameras.length} cameras (missed ${retried.map((c) => c.name).join(", ")})`,
    );
  }
  return written;
}
