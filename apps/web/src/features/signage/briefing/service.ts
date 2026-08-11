import "server-only";

/**
 * The briefing-room service — everything the control board asks for.
 *
 * The API route above this is a thin shell (parse → delegate), following the
 * house convention; all of the ordering rules that matter live here:
 *
 *   1. NEON BEFORE REDIS. The assignment row is the record — it is what the
 *      qualification board reads tomorrow-morning-in-the-logs and, more
 *      importantly, what tells the next group's board which session to report on.
 *      A Redis blip may cost a wall animation, never the history (house rule:
 *      persist guest/operational data at capture, independent of downstream).
 *   2. THE VIDEO URL IS RESOLVED AT SEND TIME and frozen into the room state, so
 *      somebody uploading a replacement film mid-briefing cannot swap it out from
 *      under a room that is watching it.
 *   3. ONE SEND, WHOLE SEQUENCE. There is no "now show helmets" or "now show
 *      quals" call — the TV derives all of that from the send's timestamp. The
 *      control board therefore cannot get out of step with the room.
 */
import { businessDayYmdET } from "@/lib/race-business-day";
import { loadSignageAssetsSafe } from "../data/signage-assets-db";
import {
  listBriefingAssignments,
  previousTimelineAssignment,
  recordBriefingAssignment,
  type BriefingAssignment,
} from "./assignments-db";
import { briefingTimelineAt } from "./phase";
import { resolveRoomQuals } from "./quals.server";
import {
  clearBriefingRoom,
  clearSessionBriefed,
  markSessionBriefed,
  readBriefingRoom,
  readBriefingRooms,
  setBriefingRoom,
} from "./state.server";
import {
  assetKeyForTier,
  BRIEFING_ROOMS,
  tierForRaceType,
  type BriefingPhase,
  type BriefingQualsBoard,
  type BriefingRoom,
  type BriefingRoomState,
  type BriefingTier,
} from "./types";

/** Briefing rooms are a FastTrax thing. Hard-coded rather than parameterised
 *  because there is exactly one venue with briefing rooms and inventing a
 *  configuration point for it would be pure ceremony. */
const VENUE = "FT";

export interface SendBriefingArgs {
  room: BriefingRoom;
  track: "blue" | "red" | "mega";
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  /** Staff override. Absent ⇒ derived from the session's own type. */
  tier?: BriefingTier | null;
}

export interface SendBriefingResult {
  ok: true;
  tier: BriefingTier;
  /** False when no film is uploaded for this tier — the room will open on the
   *  helmet board instead. The caller surfaces this so staff are not left
   *  wondering why a video did not play. */
  hasVideo: boolean;
}

/**
 * Send a called session to a briefing room.
 *
 * The tier decides which film plays and defaults from the session type, with PRO
 * SESSIONS TAKING THE STARTER FILM (owner 2026-08-11) — there is no Pro briefing,
 * and a Pro grid still contains people who have not raced this season.
 */
export async function sendBriefing(args: SendBriefingArgs): Promise<SendBriefingResult> {
  const tier = args.tier ?? tierForRaceType(args.raceType);
  const businessDay = businessDayYmdET();

  // Durable first — see the header.
  await recordBriefingAssignment({
    venue: VENUE,
    businessDay,
    room: args.room,
    track: args.track,
    sessionId: args.sessionId,
    heatNumber: args.heatNumber,
    raceType: args.raceType,
    tier,
    mode: "timeline",
  });

  const assets = await loadSignageAssetsSafe();
  const video = assets[assetKeyForTier(tier)] ?? null;

  const state: BriefingRoomState = {
    // ASSIGNED, not started. The group has to walk to the room and sit down;
    // rolling a safety film at send time meant they missed its opening (owner
    // 2026-08-11). Staff press Start when the room is actually ready.
    //
    // The video URL is resolved NOW even though nothing plays yet, so the room's
    // player can pre-download the film into its cache during the walk over.
    kind: "assigned",
    tier,
    track: args.track,
    raceType: args.raceType,
    sessionId: args.sessionId,
    heatNumber: args.heatNumber,
    triggeredAtMs: Date.now(),
    videoUrl: video?.url ?? null,
    videoDurationMs: video?.durationMs ?? null,
  };
  await setBriefingRoom(VENUE, args.room, state);

  // The track check-in board clears off THIS, not off a timer: once a group is
  // sent to a room they have finished checking in.
  await markSessionBriefed(args.sessionId);

  return { ok: true, tier, hasVideo: !!video?.url };
}

/**
 * Roll the film — phase two of a send.
 *
 * Re-resolves the video from the manifest rather than trusting what the send
 * froze in: staff sometimes upload the film between sending a group and starting
 * it, and the useful behaviour there is obviously to play the new one.
 *
 * `restart` is the same operation, and deliberately so. Latecomers walk in, a
 * projector drops HDMI, a group asks to see it again — all of them mean "play it
 * from the top now", which is exactly a fresh `triggeredAtMs`. One code path
 * means the two can never behave differently.
 */
export async function startBriefing(
  room: BriefingRoom,
): Promise<{ ok: boolean; error?: string; hasVideo?: boolean }> {
  const current = await readBriefingRoom(VENUE, room);
  if (!current || current.kind === "quals-only") {
    return { ok: false, error: "nothing is assigned to that room — send a session first" };
  }

  const tier = current.tier ?? "starter";
  const assets = await loadSignageAssetsSafe();
  const video = assets[assetKeyForTier(tier)] ?? null;

  await setBriefingRoom(VENUE, room, {
    ...current,
    kind: "timeline",
    // The ONLY thing that actually starts (or restarts) the sequence.
    triggeredAtMs: Date.now(),
    videoUrl: video?.url ?? null,
    videoDurationMs: video?.durationMs ?? null,
  });

  return { ok: true, hasVideo: !!video?.url };
}

/**
 * Jump a room straight to the qualification board.
 *
 * The manual override for the case the timeline does not cover: a group comes
 * back and there is no next briefing queued behind them, so no send is going to
 * carry their results onto the wall. Recorded as `mode: 'quals-only'` so it can
 * never be mistaken for a group having been briefed — that distinction is what
 * keeps the next real send reporting on the right session.
 */
export async function showQualsNow(room: BriefingRoom): Promise<{ ok: true }> {
  const businessDay = businessDayYmdET();
  const previous = await previousTimelineAssignment(VENUE, businessDay, room, null).catch(
    () => null,
  );

  await recordBriefingAssignment({
    venue: VENUE,
    businessDay,
    room,
    track: previous?.track ?? "mega",
    sessionId: previous?.sessionId ?? "",
    heatNumber: previous?.heatNumber ?? null,
    raceType: previous?.raceType ?? null,
    tier: null,
    mode: "quals-only",
  });

  await setBriefingRoom(VENUE, room, {
    kind: "quals-only",
    tier: null,
    track: (previous?.track as "blue" | "red" | "mega") ?? "mega",
    raceType: previous?.raceType ?? null,
    sessionId: previous?.sessionId ?? "",
    heatNumber: previous?.heatNumber ?? null,
    triggeredAtMs: Date.now(),
    videoUrl: null,
    videoDurationMs: null,
  });

  return { ok: true };
}

/**
 * Clear a room back to its idle helmet board — "room done", and also Undo.
 *
 * Undoing a send has to put the heat BACK on the track check-in board, otherwise
 * a mis-send would quietly strand a group: cleared from check-in, and not in a
 * room either.
 */
export async function clearRoom(room: BriefingRoom): Promise<{ ok: true }> {
  const current = await readBriefingRoom(VENUE, room);
  await clearBriefingRoom(VENUE, room);
  if (current?.sessionId) await clearSessionBriefed(current.sessionId);
  return { ok: true };
}

/* ── the control board's view ─────────────────────────────────────────── */

export interface BriefingRoomStatus {
  room: BriefingRoom;
  state: BriefingRoomState | null;
  phase: BriefingPhase;
  /** ms until the next phase, for the board's progress readout. */
  nextInMs: number | null;
  /** What the room's quals board will show when it gets there. */
  quals: BriefingQualsBoard | null;
}

export interface BriefingBoardStatus {
  now: number;
  businessDay: string;
  rooms: BriefingRoomStatus[];
  /** Today's sends, newest first. */
  assignments: BriefingAssignment[];
  /** Which films are uploaded — the board disables a tier with no film rather
   *  than sending a session to a room that will show a poster. */
  videos: Record<BriefingTier, { url: string; durationMs: number | null } | null>;
  helmetPosterUrl: string | null;
}

/** Everything the control board polls, in one call. */
export async function briefingBoardStatus(): Promise<BriefingBoardStatus> {
  const now = Date.now();
  const businessDay = businessDayYmdET();

  const [rooms, assignments, assets] = await Promise.all([
    readBriefingRooms(VENUE).catch(() => ({ red: null, blue: null })),
    listBriefingAssignments(VENUE, businessDay).catch(() => []),
    loadSignageAssetsSafe(),
  ]);

  const roomStatuses = await Promise.all(
    BRIEFING_ROOMS.map(async (room): Promise<BriefingRoomStatus> => {
      const state = rooms[room];
      const timeline = briefingTimelineAt(state, now);
      const quals = await resolveRoomQuals({
        venue: VENUE,
        businessDay,
        room,
        currentSessionId: state?.kind === "timeline" ? state.sessionId || null : null,
      }).catch(() => null);
      return { room, state, phase: timeline.phase, nextInMs: timeline.nextInMs, quals };
    }),
  );

  const starter = assets["briefing-video:starter"] ?? null;
  const intermediate = assets["briefing-video:intermediate"] ?? null;

  return {
    now,
    businessDay,
    rooms: roomStatuses,
    assignments,
    videos: {
      starter: starter ? { url: starter.url, durationMs: starter.durationMs } : null,
      intermediate: intermediate
        ? { url: intermediate.url, durationMs: intermediate.durationMs }
        : null,
    },
    helmetPosterUrl: assets["briefing-helmet-poster"]?.url ?? null,
  };
}
