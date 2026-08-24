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
 *      next race" call — the TV derives all of that from the send's timestamp. The
 *      control board therefore cannot get out of step with the room.
 */
import { businessDayYmdET } from "@/lib/race-business-day";
import { readPitLanes } from "../pit/lane.server";
import type { PitLanes } from "../pit/pit-board";
import { calledAtMsFor, sessionCheckinTimes } from "../service/checkin-progress";
import { loadSignageAssetsSafe } from "../data/signage-assets-db";
import { listSignageScreens } from "../data/signage-screens-db";
import { resolveScreenConfig } from "../defaults";
import type { SignageVenue } from "../constants";
import { trackFromResourceIds } from "../track";
import {
  listBriefingAssignments,
  recordBriefingAssignment,
  type BriefingAssignment,
} from "./assignments-db";
import { briefingTimelineAt } from "./phase";
import { listBriefingEvents, recordBriefingEvent } from "./events-db";
import { foldBriefingLog, type BriefingRecord } from "./briefing-log";
import { captureRoomPhoto } from "./room-photo.server";
import { bookmarkBriefingStartAfter } from "./bookmarks.server";
import { autoHoldingEnabled } from "./auto-holding.server";
import { checkinWindowOverride } from "./checkin-window.server";
import { greetingByMotionEnabled } from "./greeting-setting.server";
import { raceBookmarksEnabled } from "./race-bookmarks-setting.server";
import { cameraPreviewMode, type CameraPreviewMode } from "./camera-preview-setting.server";
import { readTimingFeedStatus, type TimingFeedStatus } from "~/features/racing/timing-feed.server";
import { readRaceFinishedMarker } from "./race-finish.server";
import { GROUP_OUT_WINDOW_MS, type GroupOut } from "./room-return";
import {
  clearBriefingRoom,
  clearSessionBriefed,
  markSessionBriefed,
  readBriefingRoom,
  readBriefingRooms,
  sessionBriefed,
  sessionsBriefed,
  setBriefingRoom,
} from "./state.server";
import {
  assetKeyForTier,
  BRIEFING_ROOMS,
  resolveFilmTier,
  tierForRaceType,
  type BriefingPhase,
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
  /* NO `tier` FIELD (owner 2026-08-16). It was the staff override, set by three
     buttons on the check-in board; the film is derived from `raceType` below and
     there is no longer any way to ask for a different one. */
}

export type SendBriefingResult =
  | {
      ok: true;
      tier: BriefingTier;
      /** False when no film is uploaded for this tier — the room will open on the
       *  helmet board instead. The caller surfaces this so staff are not left
       *  wondering why a video did not play. */
      hasVideo: boolean;
    }
  | { ok: false; error: string };

/**
 * Send a called session to a briefing room.
 *
 * The tier decides which film plays and defaults from the session type, with PRO
 * SESSIONS TAKING THE PRO FILM when one is uploaded, falling back to the
 * INTERMEDIATE film when it is not (owner 2026-08-11, superseding the earlier
 * Pro→Starter rule).
 *
 * NOBODY PICKS THE FILM (owner 2026-08-16). Staff used to be able to override the
 * tier per send from the check-in board; the session's own type is now the only
 * input, so the film a grid is briefed with — and the film the insurance log
 * records them as having been briefed with — cannot diverge from the race they
 * are about to run.
 */
export async function sendBriefing(args: SendBriefingArgs): Promise<SendBriefingResult> {
  const requestedTier = tierForRaceType(args.raceType);
  const businessDay = businessDayYmdET();

  // The EFFECTIVE film — a Pro request falls back to the Intermediate film when
  // no Pro film is uploaded (owner 2026-08-11). Resolved BEFORE the durable
  // record so the row stores the tier the room actually plays; the manifest read
  // is a read, so writes still go Neon-first below.
  const assets = await loadSignageAssetsSafe();
  const tier = resolveFilmTier(requestedTier, (t) => !!assets[assetKeyForTier(t)]?.url);
  const video = assets[assetKeyForTier(tier)] ?? null;

  // WHO IS BEING DISPLACED, read before anything is written. Sending into an
  // occupied room ends the previous group's occupancy, and that end is a fact the
  // insurance log has to carry — otherwise their record stays open forever and
  // reads as "never left the room". Same session ⇒ nobody is displaced (a re-send
  // of the group already in there, and a Mega group legitimately in both rooms).
  const displaced = await readBriefingRoom(VENUE, args.room).catch(() => null);

  /**
   * ONE GROUP, ONE ROOM — refused rather than displaced.
   *
   * Until now nothing stopped a heat being sent to BOTH rooms. It was never
   * reached because there was one desk and one operator; the in-room tablets
   * (owner 2026-08-16, "allow them to pull to room") make it a live race between
   * two screens, and the client-side guard on each of them reads a board poll up
   * to five seconds stale.
   *
   * What it costs is not cosmetic: both rooms play a film at the same heat, the
   * briefed marker ends up naming whichever room wrote last so Undo frees only
   * one of them, the insurance log gets two "sent" rows for one group, and the
   * room that did not win is occupied by people who are not in it — which blocks
   * the next real send.
   *
   * REFUSING IS THE HOUSE POSTURE for two claimants on one slot (see the
   * override route's note: refusing makes a human look). Both boards already
   * render a refusal — it is what the note line under the buttons is for — so
   * fixing it here covers the desk and both tablets with one guard.
   *
   * MEGA IS THE CARVE-OUT, and a real one: on a Mega night the two rooms serve
   * the single circuit and a heat is deliberately split across them, which is
   * why the displacement check below has always treated the same session in both
   * rooms as legitimate.
   */
  if (args.track !== "mega") {
    const otherRoom: BriefingRoom = args.room === "red" ? "blue" : "red";
    const other = await readBriefingRoom(VENUE, otherRoom).catch(() => null);
    if (
      other?.sessionId === args.sessionId &&
      briefingTimelineAt(other, Date.now()).phase !== "idle"
    ) {
      const who = args.heatNumber != null ? `Session ${args.heatNumber}` : "That group";
      return {
        ok: false,
        error: `${who} is already in the ${otherRoom} room. Undo it there first, or send them on to holding.`,
      };
    }
  }

  /**
   * THE TWO ANCHORS THAT ONLY EXIST RIGHT NOW (owner 2026-08-12, wait times).
   *
   * When the heat was called, and when its racers came through the desk. Both are
   * live-only: the called-at record ages out ~20 minutes after the call, and the
   * roster stops being readable once Pandora drops the session. Neither can be
   * recovered tomorrow, so the send — the one moment both are still on hand — is
   * where they get written down.
   *
   * Started HERE and awaited BELOW, so a Pandora round trip overlaps the durable
   * write instead of delaying it. Best effort in every direction: a send is a
   * staff action with a group standing in front of the desk, and it must never
   * fail, or even feel slow, because a metric could not be read.
   */
  const anchorsPromise = Promise.all([
    calledAtMsFor(args.track, args.sessionId).catch(() => null),
    sessionCheckinTimes(args.sessionId).catch(() => null),
  ]);

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

  if (displaced && displaced.sessionId && displaced.sessionId !== args.sessionId) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay,
      room: args.room,
      track: displaced.track,
      sessionId: displaced.sessionId,
      heatNumber: displaced.heatNumber,
      raceType: displaced.raceType,
      tier: displaced.tier,
      action: "ended",
      reason: "replaced",
    });
  }

  const [calledAtMs, checkin] = await anchorsPromise;
  await recordBriefingEvent({
    venue: VENUE,
    businessDay,
    room: args.room,
    track: args.track,
    sessionId: args.sessionId,
    heatNumber: args.heatNumber,
    raceType: args.raceType,
    tier,
    action: "sent",
    calledAtMs,
    checkinFirstAtMs: checkin?.firstMs ?? null,
    checkinLastAtMs: checkin?.lastMs ?? null,
    checkinIn: checkin?.checkedIn ?? null,
    checkinTotal: checkin?.total ?? null,
  });

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
  await markSessionBriefed(args.sessionId, args.room);

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
): Promise<{ ok: boolean; error?: string; hasVideo?: boolean; photoSaved?: boolean }> {
  const current = await readBriefingRoom(VENUE, room);
  if (!current) {
    return { ok: false, error: "nothing is assigned to that room — send a session first" };
  }

  const assets = await loadSignageAssetsSafe();
  // Re-resolved at Start too: the film may have been uploaded (or removed) while
  // the group walked over, and a stale answer here would start a silent room.
  const tier = resolveFilmTier(current.tier ?? "starter", (t) => !!assets[assetKeyForTier(t)]?.url);
  const video = assets[assetKeyForTier(tier)] ?? null;
  const businessDay = businessDayYmdET();
  const isRestart = current.kind === "timeline";

  /**
   * THE INSURANCE RECORD OF THE FILM ITSELF, written BEFORE the room state so a
   * film cannot roll unrecorded (persist-at-capture, CLAUDE.md).
   *
   * RESTART IS DECIDED BY THE ROOM, not by which button was pressed: a room still
   * `assigned` has never played anything, so pressing Restart on it is a first
   * start and must be logged as one. The route hands both presses to this same
   * function precisely so the two can never behave differently — that has to hold
   * for the log too.
   *
   * It carries the film's URL and LENGTH because "which safety video did they
   * watch, and did it finish" is the question, and the length is what lets
   * briefing-log.ts derive the end of an occupancy nobody explicitly closed.
   */
  await recordBriefingEvent({
    venue: VENUE,
    businessDay,
    room,
    track: current.track,
    sessionId: current.sessionId,
    heatNumber: current.heatNumber,
    raceType: current.raceType,
    tier,
    action: isRestart ? "restarted" : "started",
    videoUrl: video?.url ?? null,
    videoMs: video?.durationMs ?? null,
  });

  await setBriefingRoom(VENUE, room, {
    ...current,
    kind: "timeline",
    // The ONLY thing that actually starts (or restarts) the sequence.
    triggeredAtMs: Date.now(),
    videoUrl: video?.url ?? null,
    videoDurationMs: video?.durationMs ?? null,
  });

  /**
   * THE PICTURE OF THE ROOM, taken now that the film is actually rolling (owner
   * 2026-08-12). Deliberately AFTER the Redis write: the wall must never wait on a
   * camera, so the film starts first and the evidence follows a beat later — which
   * is also the more honest frame, because it shows the room as the video began
   * rather than as staff reached for the button.
   *
   * FIRST START ONLY. A restart is the same group in the same room, already
   * photographed; a second still would cost storage and prove nothing new.
   *
   * Awaited rather than left dangling — this runs on serverless, where work that
   * outlives the response is simply killed. See room-photo.server.ts for the
   * timeout that bounds what that costs, and why every failure here is silent.
   */
  let photoSaved = false;
  if (!isRestart) {
    const photo = await captureRoomPhoto({
      room,
      businessDay,
      sessionId: current.sessionId,
      heatNumber: current.heatNumber,
    });
    if (photo) {
      await recordBriefingEvent({
        venue: VENUE,
        businessDay,
        room,
        track: current.track,
        sessionId: current.sessionId,
        heatNumber: current.heatNumber,
        raceType: current.raceType,
        tier,
        action: "photo",
        photoUrl: photo.url,
      }).catch((err) => {
        // The blob is written; only its index row failed. Loud, but not fatal —
        // the start it belongs to already succeeded and is already recorded.
        console.error("[briefing-photo] event row failed", err);
      });
      photoSaved = true;
    }

    /**
     * AND A MARKER ON THE NVR'S TIMELINE (owner 2026-08-14). The still shows one
     * instant; this makes the whole briefing findable in the footage, and
     * exportable as a clip straight off the bookmark.
     *
     * FIRST START ONLY, for the same reason as the photo: a restart is the same
     * group in the same room, and a second marker on the ribbon would suggest a
     * second briefing took place.
     *
     * Queued for after the response rather than awaited — the Start press already
     * carries the room photo, and stacking an NVR write behind it would show up
     * on the desk as a slow button (see afterResponse in bookmarks.server.ts).
     */
    bookmarkBriefingStartAfter({
      room,
      track: current.track,
      heatNumber: current.heatNumber,
      raceType: current.raceType,
      atMs: Date.now(),
      tier,
      videoMs: video?.durationMs ?? null,
    });
  }

  return { ok: true, hasVideo: !!video?.url, photoSaved };
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

  // The one moment the room's occupancy ends on a human decision rather than on
  // the film running out — so it is stamped, and it outranks any derived end.
  if (current?.sessionId) {
    await recordBriefingEvent({
      venue: VENUE,
      businessDay: businessDayYmdET(),
      room,
      track: current.track,
      sessionId: current.sessionId,
      heatNumber: current.heatNumber,
      raceType: current.raceType,
      tier: current.tier,
      action: "ended",
      reason: "cleared",
    });
  }

  await clearBriefingRoom(VENUE, room);

  // Put the heat back on the check-in board — but ONLY if no other room is still
  // briefing it. On a Mega day a big group is legitimately split across both
  // rooms, and clearing one of them used to un-brief the session outright, so the
  // heat reappeared as "checking in" while half of it was still watching the film
  // next door.
  if (current?.sessionId) {
    const rooms = await readBriefingRooms(VENUE).catch(() => ({ red: null, blue: null }));
    const stillHeldElsewhere = BRIEFING_ROOMS.some(
      (r) => r !== room && rooms[r]?.sessionId === current.sessionId,
    );
    if (!stillHeldElsewhere) await clearSessionBriefed(current.sessionId);
  }
  return { ok: true };
}

/* ── the control board's view ─────────────────────────────────────────── */

export interface BriefingRoomStatus {
  room: BriefingRoom;
  state: BriefingRoomState | null;
  phase: BriefingPhase;
  /** ms until the next phase, for the board's progress readout. */
  nextInMs: number | null;
  /**
   * WHO THIS ROOM IS STILL WAITING ON — the last group briefed here, and whether
   * their race has finished.
   *
   * Because an idle room is NOT a free room: the timeline ends a minute after the
   * helmet board while that group is still on track, and they walk back into this
   * same room to hand kit in (owner 2026-08-12: "Free might not be right word
   * here… warn that race is returning in X"). The desk turns this plus the live
   * on-track clock into the badge — see briefing/room-return.ts, which is where
   * the rules and their bounds live.
   *
   * Null once nobody is outstanding, so the board can say FREE and mean it.
   */
  groupOut: GroupOut | null;
}

/**
 * How long a racer has to check in, per track, as configured on the TRACK BOARDS.
 *
 * READ FROM THE WALL'S OWN CONFIG, never a second copy. Each track check-in screen
 * counts a guest down from the call by its `checkinWindowMins` (8 today for both
 * tracks); the desk's Called box now escalates on the same deadline, so staff and
 * the racer standing in front of that TV are working from one number. A desk that
 * kept its own constant would drift the day somebody changed the wall.
 */
export type CheckinWindows = Record<"blue" | "red" | "mega", number>;

export interface BriefingBoardStatus {
  now: number;
  businessDay: string;
  rooms: BriefingRoomStatus[];
  /** Minutes per track — what the Called box's amber/red deadline is measured
   *  against. See CheckinWindows. */
  checkinWindowMins: CheckinWindows;
  /** Today's sends, newest first. */
  assignments: BriefingAssignment[];
  /**
   * WHICH OF TODAY'S SESSIONS ARE STILL CONSIDERED SENT, keyed by sessionId.
   *
   * The Called box hides a heat that has gone to a room, and it used to decide
   * that from `assignments` — which is an APPEND-ONLY record of what happened,
   * so Undo could never take it back and the heat stayed off the board (owner
   * 2026-08-13: "I hit undo on in the room and it didn't go back to called").
   *
   * This is the reversible fact instead: the briefed marker, set on send,
   * DELETED by Undo, and deliberately left standing by "send to holding" so a
   * briefed group does not reappear at the desk on their way to the seats. A
   * session absent here is a session waiting to be sent.
   */
  briefedSessions: Record<string, { atMs: number; room: BriefingRoom | null }>;
  /**
   * TODAY'S BRIEFING LOG, folded — one row per group with when they went in, which
   * film ran, and how long they were in the room (briefing-log.ts).
   *
   * Surfaced on the board deliberately: a record staff cannot see is a record
   * nobody notices has stopped being written. The desk's log strip is the daily
   * proof that the insurance data is landing.
   */
  briefings: BriefingRecord[];
  /** Which films are uploaded — the board disables a tier with no film rather
   *  than sending a session to a room that will show a poster. */
  videos: Record<BriefingTier, { url: string; durationMs: number | null } | null>;
  helmetPosterUrl: string | null;
  /** The welcome-back jingle the room TVs loop — null until uploaded. */
  welcomeBackAudioUrl: string | null;
  /** The once-only "another group is waiting" clip — null until uploaded,
   *  and a lingering room is simply not narrated. */
  welcomeBackLingerAudioUrl: string | null;
  /**
   * THE PIT LANE, PER TRACK — who is in holding, who is out racing, and whether
   * the lane is still held (owner 2026-08-13).
   *
   * The desk's THIRD box. Check-in gave the board Called and In the room, but the
   * step after the briefing had no home: staff pressed "Send to holding" and the
   * group vanished off the screen until they appeared on track. The same lane the
   * pit boards read is now the desk's Holding panel, so one surface carries the
   * whole journey — called → in the room → holding.
   *
   * Costs one Redis MGET plus the start/finish marker reads for tracks that hold
   * state; nothing goes to Pandora, which is what lets it ride the existing 5s
   * poll rather than needing one of its own.
   */
  lanes: PitLanes;
  /**
   * IS THE CAMERA SWEEP ARMED? (owner 2026-08-14: "build it with the kill switch
   * in settings of the check in board".)
   *
   * On the board poll rather than fetched by the settings sheet on open, so the
   * toggle shows the truth the moment staff look at it — including a change made
   * from the other desk thirty seconds ago. One Redis GET on a poll that is
   * already reading Redis.
   */
  autoHolding: { enabled: boolean };
  /**
   * Does the welcome-back greeting start on the room camera's say-so (ON,
   * default) or on the fixed post+45s timer (OFF)? Drives the settings-sheet
   * toggle under auto-holding. See greeting-setting.server.ts.
   */
  greetingByMotion: { enabled: boolean };
  /**
   * Is race-event camera bookmarking armed? Drives the second settings toggle.
   *
   * A separate switch from autoHolding, not a second field on it: one changes
   * how the night RUNS, the other only annotates footage. See
   * race-bookmarks-setting.server.ts.
   */
  raceBookmarks: { enabled: boolean };
  /**
   * Whether the desk's room previews play video or fall back to a picture a
   * second. A CHOICE rather than a switch, because both positions are a
   * reasonable way to run a night — see camera-preview-setting.server.ts for
   * what each costs the Nx server.
   */
  cameraPreview: { mode: CameraPreviewMode };
  /**
   * IS THE KART TIMING FEED ALIVE? Same reasoning as the briefing log above: a
   * signal nobody can see is a signal nobody notices has stopped.
   *
   * The heartbeat behind this has existed since the bridge shipped and no screen
   * read it, so when the feed went silent mid-session on 2026-08-15 the only
   * symptom was the race clocks quietly being wrong. It rides the board's
   * existing 5s poll rather than a new one — this is a Redis GET.
   */
  timing: TimingFeedStatus;
}

/**
 * The last group this room sent out, if they could still be coming back.
 *
 * COSTS ONE REDIS GET, and only while a group is inside the out-window: the send
 * rows are already in hand (the board lists them anyway) and the end signal is the
 * venue's own RaceFinish marker, which the timing bridge writes seconds after the
 * flag. NO PANDORA READ — the desk polls every 5 seconds, and the welcome-back
 * resolver's live per-poll Pandora read is budgeted for the TV's 15s pulse
 * (owner: "15 seconds, no more"). A bridge outage therefore costs this badge its
 * precision, never its correctness: room-return.ts falls back to the later-heat
 * rule and then to the out-window.
 *
 * `assignments` must be NEWEST-FIRST, as listBriefingAssignments returns it.
 */
async function lastGroupOut(
  room: BriefingRoom,
  assignments: BriefingAssignment[],
  now: number,
): Promise<GroupOut | null> {
  const last = assignments.find((a) => a.room === room && a.mode === "timeline");
  if (!last) return null;

  // A group re-sent to the other room belongs to THAT room now; this room's older
  // row must not keep waiting for them. Same guard the welcome-back resolver uses.
  const newestForSession = assignments.find(
    (a) => a.sessionId === last.sessionId && a.mode === "timeline",
  );
  if (newestForSession && newestForSession.room !== room) return null;

  const sentAtMs = Date.parse(last.sentAt);
  if (!Number.isFinite(sentAtMs)) return null;
  // Past the window nothing downstream would claim the room anyway — so skip the
  // Redis reads rather than paying for an answer that cannot change the outcome.
  if (now - sentAtMs > GROUP_OUT_WINDOW_MS) return null;

  // UNDO MUST REVOKE THE CLAIM, and this is what makes it do so. The send row is
  // deliberately permanent — it is the day's record — so a mis-send that staff
  // undid would otherwise leave this room announcing "out on track" about a group
  // who never went, for the whole out-window. clearRoom deletes the session's
  // briefed marker (unless the other room still holds it), so requiring the marker
  // means the claim dies the moment the send does. Its 6h TTL far outlives the
  // window, so a legitimate group can never lose its claim to expiry.
  const briefed = await sessionBriefed(last.sessionId).catch(() => null);
  if (!briefed || (briefed.room && briefed.room !== room)) return null;

  const marker = await readRaceFinishedMarker(last.sessionId).catch(() => null);
  return {
    sessionId: last.sessionId,
    heatNumber: last.heatNumber,
    sentAtMs,
    endedAtMs: marker?.endedAtMs ?? null,
  };
}

/**
 * The per-track check-in windows the track boards are actually showing.
 *
 * CACHED IN-MODULE for a minute: the desk polls every 5 seconds and this is one
 * Neon read of a table that changes when somebody edits a screen in admin — a
 * cadence measured in weeks. A minute of staleness on a deadline measured in
 * minutes is invisible; a Neon read every 5 seconds would not be.
 *
 * Screens with the countdown SWITCHED OFF are ignored (their wall shows no
 * deadline to a guest, so the desk should not invent one for that track), and when
 * two screens serve one track the SHORTER window wins — the desk must never be
 * laxer than the strictest deadline a racer was shown. No track screen at all
 * falls back to the config layer's own default rather than a literal here, so the
 * two cannot drift.
 */
const CHECKIN_WINDOW_TTL_MS = 60_000;
let checkinWindowCache: { at: number; windows: CheckinWindows } | null = null;

async function resolveCheckinWindows(now: number): Promise<CheckinWindows> {
  /**
   * THE DESK'S OVERRIDE WINS, AND IS NOT CACHED (owner 2026-08-23: the window
   * is a gear setting on the check-in board). It sits outside the 60s cache
   * deliberately — a staff member who has just changed the window watches the
   * board to see it take, and a minute of "did that work?" is exactly the
   * doubt the gear exists to remove. One Redis GET per poll against a board
   * that already makes several.
   */
  const override = await checkinWindowOverride();
  if (override != null) return { blue: override, red: override, mega: override };

  if (checkinWindowCache && now - checkinWindowCache.at < CHECKIN_WINDOW_TTL_MS) {
    return checkinWindowCache.windows;
  }
  // Configured values only, so the fallback cannot undercut a track whose wall is
  // deliberately set LONGER than the default.
  const found: Record<"blue" | "red" | "mega", number | null> = {
    blue: null,
    red: null,
    mega: null,
  };
  let read = false;

  try {
    for (const screen of await listSignageScreens()) {
      const config = resolveScreenConfig(screen.config, screen.venue as SignageVenue);
      if (!config.showCheckinCountdown) continue;
      const track = trackFromResourceIds(config.scope.resourceIds);
      if (!track) continue;
      const mins = config.checkinWindowMins;
      if (!Number.isFinite(mins) || mins <= 0) continue;
      const held = found[track];
      // First screen sets the track's window; a second one can only shorten it.
      found[track] = held == null ? mins : Math.min(held, mins);
    }
    read = true;
  } catch {
    // A failed read must not cost the board its poll: the defaults below stand and
    // nothing is cached, so the next poll tries again.
  }

  // The default the resolver itself applies to a screen that has never been
  // configured — taken FROM the resolver so this file owns no copy of it.
  const fallback = resolveScreenConfig({}, "FT").checkinWindowMins;
  const windows: CheckinWindows = {
    blue: found.blue ?? fallback,
    red: found.red ?? fallback,
    mega: found.mega ?? fallback,
  };
  if (read) checkinWindowCache = { at: now, windows };
  return windows;
}

/** Everything the control board polls, in one call. */
export async function briefingBoardStatus(): Promise<BriefingBoardStatus> {
  const now = Date.now();
  const businessDay = businessDayYmdET();

  const [
    rooms,
    assignments,
    assets,
    checkinWindowMins,
    events,
    lanes,
    autoHolding,
    greetingByMotion,
    raceBookmarks,
    cameraPreview,
    timing,
  ] = await Promise.all([
    readBriefingRooms(VENUE).catch(() => ({ red: null, blue: null })),
    listBriefingAssignments(VENUE, businessDay).catch(() => []),
    loadSignageAssetsSafe(),
    resolveCheckinWindows(now),
    listBriefingEvents(VENUE, businessDay).catch(() => []),
    // readPitLanes already swallows its own failures to EMPTY_PIT_LANE — a Redis
    // blip empties the Holding box for one poll, it never fails the board.
    readPitLanes(),
    // Defaults ON if Redis cannot answer — same direction as the sweep itself,
    // so the toggle never shows OFF for a switch that is actually armed.
    autoHoldingEnabled().catch(() => true),
    greetingByMotionEnabled().catch(() => true),
    raceBookmarksEnabled().catch(() => true),
    // Swallows to the same default the getter uses, for the same reason as the
    // two above: a Redis blip must not show staff a setting they did not choose.
    cameraPreviewMode().catch((): CameraPreviewMode => "live"),
    // Swallows its own failures to "unknown" — a Redis blip must show an
    // honest "we don't know", never a red DOWN that sends staff chasing a
    // feed that is fine.
    readTimingFeedStatus(now),
  ]);

  const [groupsOut, briefedSessions] = await Promise.all([
    Promise.all(
      BRIEFING_ROOMS.map((room) => lastGroupOut(room, assignments, now).catch(() => null)),
    ),
    // Asked about today's sends only — the bounded set the Called box can be
    // showing — and answered in one MGET however long the night gets.
    sessionsBriefed(assignments.map((a) => a.sessionId)),
  ]);

  const roomStatuses = BRIEFING_ROOMS.map((room, i): BriefingRoomStatus => {
    const state = rooms[room];
    const timeline = briefingTimelineAt(state, now);
    return {
      room,
      state,
      phase: timeline.phase,
      nextInMs: timeline.nextInMs,
      groupOut: groupsOut[i] ?? null,
    };
  });

  const slot = (
    key: "briefing-video:starter" | "briefing-video:intermediate" | "briefing-video:pro",
  ) => {
    const a = assets[key] ?? null;
    return a ? { url: a.url, durationMs: a.durationMs } : null;
  };

  return {
    now,
    businessDay,
    rooms: roomStatuses,
    checkinWindowMins,
    assignments,
    briefedSessions,
    briefings: foldBriefingLog(events, now),
    videos: {
      starter: slot("briefing-video:starter"),
      intermediate: slot("briefing-video:intermediate"),
      pro: slot("briefing-video:pro"),
    },
    helmetPosterUrl: assets["briefing-helmet-poster"]?.url ?? null,
    welcomeBackAudioUrl: assets["welcome-back-audio"]?.url ?? null,
    welcomeBackLingerAudioUrl: assets["welcome-back-linger-audio"]?.url ?? null,
    lanes,
    autoHolding: { enabled: autoHolding },
    greetingByMotion: { enabled: greetingByMotion },
    raceBookmarks: { enabled: raceBookmarks },
    cameraPreview: { mode: cameraPreview },
    timing,
  };
}
