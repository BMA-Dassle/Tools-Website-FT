"use client";

/**
 * A briefing room's TV.
 *
 * One staff press starts a sequence this screen then runs on its own:
 *
 *     safety video (with sound)  →  helmet sizes ~30s  →  who levelled up
 *
 * EVERY PHASE IS DERIVED FROM THE CLOCK, never remembered (briefing/phase.ts).
 * The video seeks to `nowMs - triggeredAtMs`, so a player that reboots four
 * minutes into a five-minute briefing comes back four minutes in rather than
 * starting the safety film over on a room that has already watched it.
 *
 * SOUND IS ON. This is the one screen on the estate that must be heard — it is a
 * safety briefing, not signage. The generated player script already ships
 * `--autoplay-policy=no-user-gesture-required` (startup-script.ts), which is what
 * lets an unmuted video autoplay with nobody to click anything.
 *
 * IDLE IS A DESIGNED STATE, not a fallback. A briefing room between groups shows
 * helmet sizing, because the next group walks in and starts looking for their
 * size before anybody presses anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangleFilled } from "@tabler/icons-react";
import { withAlpha } from "../color";
import { formatLap, nextLevelTarget } from "~/features/racing/qualify";
import { TRACK_ACCENTS, TRACK_LABELS, type TrackKey } from "../track";
import { briefingTimelineAt, helmetBoardComplete } from "../briefing/phase";
import {
  GREETING_GAP_MS,
  LINGER_FRESH_MS,
  greetingStartMs,
  greetingWindowClosed,
  normaliseGreetingTiming,
} from "../briefing/return-greeting";
import { buildStageRail, type StageRow } from "../briefing/stage-rail";
import { roomCheckinProgress } from "../checkin-progress";
import { sendWindow } from "../briefing/pull-to-room";
import { roomBlockedAlertAt } from "../briefing/room-blocked";
import { incomingForRoom, normaliseCameraReturn } from "../briefing/camera-return";
import { resolveFilmTier, tierForRaceType, type BriefingRoom } from "../briefing/types";
import { LiveSessionChip, useLiveSessionClock } from "../live-session";
import { liveHeatNumber } from "../briefing/room-return";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { useBriefingAssets } from "../briefing/useBriefingAssets";
import { demoBriefingRooms } from "../demo";
import { CameraReturnBar, cameraBarHeight } from "../components/CameraReturnBar";
import { TvBrandLogo } from "../components/TvBrandLogo";
import type { SceneProps } from "../director/types";

const PAD_X = 96;
const PAD_Y = 54;

/**
 * How long a film may make NO progress at all before the room gives up on it.
 *
 * Deliberately generous. The failure being caught is a codec the player cannot
 * decode, which never recovers — so waiting costs nothing in the real failure case,
 * while being impatient costs a working briefing (see the note in BriefingVideo).
 * Measured from the last sign of life, not from the start of playback.
 */
const STALL_GIVE_UP_MS = 40_000;

/** Room identity colours. A briefing room is named for the track it serves, so
 *  it borrows that track's accent — someone glancing in from the corridor should
 *  know which room they are looking into. */
/** "Something still to do" — the same amber the pit board and the check-in
 *  camera board use, so one status wears one colour across every wall. */
const AMBER = "#f0b341";

const ROOM_ACCENT: Record<BriefingRoom, string> = {
  red: TRACK_ACCENTS.red,
  blue: TRACK_ACCENTS.blue,
};

const ROOM_LABEL: Record<BriefingRoom, string> = { red: "Red Briefing", blue: "Blue Briefing" };

/**
 * Which way the WHITE EXIT DOOR is from inside each room (owner 2026-08-23:
 * "have them exit out white door. Blue room that is to the right. Red that is
 * to the left"). Hardcoded beside the accent map on purpose — the doors are
 * architecture, not configuration, and if one ever moves this is a one-line
 * change next to the room's other identity facts.
 */
const EXIT_DOOR_SIDE: Record<BriefingRoom, "left" | "right"> = {
  blue: "right",
  red: "left",
};

export function SceneBriefing({ feed, nowMs, config, demo }: SceneProps) {
  const room = config.briefingRoom;

  // Which track this room's live clock follows: its own on a normal day, the
  // combined circuit on a Mega day — the same effective-track rule every other
  // board uses. Polled at the website's cadence; the clock itself is a direct
  // websocket to the timing system (see live-session.tsx).
  const trackStatus = useTrackStatus();
  const megaEnabled = trackStatus?.trackStatus.megaTrackEnabled ?? false;
  const liveTrack = room ? (megaEnabled ? ("mega" as const) : room) : null;

  // Room state is read BEFORE the assets hook, because whether a film is playing
  // right now decides whether we may use the link to download one.
  const previewRooms =
    demo === "briefing" || demo === "briefing-return" || demo === "briefing-return-quals";
  const roomsNow = previewRooms ? demoBriefingRooms(nowMs, feed, demo) : feed?.briefingRooms;
  const stateNow = room ? (roomsNow?.[room] ?? null) : null;
  // Downloads hold during "waiting" too: the group is walking over, Start is
  // seconds-to-minutes away, and preload="auto" is using the link to get the
  // element ahead. A prefetch there would be competing with the very play it is
  // trying to make instant.
  const phaseNow = briefingTimelineAt(stateNow, nowMs).phase;
  const playingNow = phaseNow === "video" || phaseNow === "waiting";

  // Downloading a film while that same film is streaming starves the player — see
  // the note on `paused` in useBriefingAssets.
  const assets = useBriefingAssets(feed?.briefing ?? null, !!room, playingNow);

  /**
   * A ROOM MUST NEVER GO BLACK.
   *
   * If the film cannot be decoded here — an HEVC or ProRes master this player has no
   * decoder for — Edge paints a black rectangle and holds it (owner 2026-08-11: "in
   * blue I'm getting briefing starting then it blacks out… that's a .mov"). Black is
   * the worst possible output: a room full of people, staff assuming the briefing is
   * running, and nothing on the wall to say otherwise. On failure the scene hands the
   * wall back to the helmet board, which is at least useful.
   *
   * Keyed by src so a re-upload of a working film clears the failure with no reload,
   * and so one bad file cannot poison the other tier.
   *
   * DECLARED HERE, above the `!room` early return below — a hook behind a conditional
   * return is a rules-of-hooks crash, not a lint nit.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // Stable for the component's life — takes the offending src as an argument
  // instead of closing over it, so BriefingVideo's effect can depend on it
  // honestly rather than hiding it behind a ref or a lint suppression.
  const markUnplayable = useCallback((badSrc: string) => setFailedSrc(badSrc), []);

  // A screen configured as a briefing TV with no room chosen cannot know which
  // of the two states is addressed to it. Say so, quietly, rather than adopting
  // a room at random — this is a setup mistake and a staff member needs to see
  // it, but guests may be in the room, so it stays calm.
  /**
   * WHERE EVERY SESSION IS — the idle board, built by the shared rail so this
   * room's wall agrees with the pit signs to the word. Mega serves both rooms
   * off one circuit, so on a Mega night both rooms' states feed the rail.
   *
   * ABOVE THE EARLY RETURN, like the clock below it: hooks run in the same
   * order every render or they run wrong.
   */
  const railClock = useLiveSessionClock(liveTrack);
  const idleStages = useMemo(() => {
    const railTrack = liveTrack ?? "mega";
    const called = trackStatus?.currentRaces?.[railTrack] ?? null;
    const vids = feed?.briefing?.videos ?? null;
    const filmTier = resolveFilmTier(
      tierForRaceType(called?.raceType ?? null),
      (t) => !!vids?.[t]?.url,
    );
    // Same record the camera boards read — the desk's own per-track progress,
    // which carries both the count and the call stamp.
    const progress = roomCheckinProgress(feed?.checkinProgress ?? [], railTrack);
    return buildStageRail({
      called,
      rooms: (megaEnabled ? (["red", "blue"] as const) : ([room ?? "red"] as const)).map(
        (r) => roomsNow?.[r as "red" | "blue"] ?? null,
      ),
      lane: feed?.pitLanes?.[railTrack] ?? null,
      // THE TICKING CLOCK, NOT THE FEED'S STAMP (owner 2026-08-24: "why don't we
      // show real timer there?"). `feed.now` is the server clock as of the last
      // 15-second poll, so every countdown built from it sat frozen and then
      // jumped a quarter-minute — which is exactly why this rail used to round
      // the film to whole minutes. The director's `nowMs` is `Date.now()` plus
      // the shared server offset, reticked every 250ms: same authority, live.
      nowMs,
      liveHeatNumber: railClock ? liveHeatNumber(railClock.heatName) : null,
      liveCounting: railClock?.counting === true,
      /**
       * THE NUMBERS THE OWNER ASKED FOR (2026-08-24: "these screens both pit and
       * briefing should be showing how many racers are checked in, and pulling
       * race to briefing time frames"). The count only counts when it is THIS
       * track's heat; the feed carries one track's check-in at a time.
       */
      liveRemainingMs: railClock?.remainingMs ?? null,
      formatClock: formatRailClock,
      checkedIn: progress ? { checkedIn: progress.checkedIn, total: progress.total } : null,
      calledForMs: progress?.calledAtMs != null ? nowMs - progress.calledAtMs : null,
      // The venue's check-in window, so a short grid becomes PULL TO BRIEFING
      // NOW at its deadline rather than sitting on 'waiting' for ever.
      checkinWindowMins: config.checkinWindowMins,
      brief: sendWindow({
        remainingMs: railClock?.remainingMs ?? null,
        onTrack: !!railClock || !!feed?.pitLanes?.[railTrack]?.racing,
        onTrackHeatNumber: railClock ? liveHeatNumber(railClock.heatName) : null,
        filmMs: vids?.[filmTier]?.durationMs ?? null,
        pitPost: null,
        // This room speaks for its own track's flow; the Mega room-suppression
        // the desk needs answers a different question (which of two rooms a
        // returning group walks into), which this rail does not ask.
        attribution: "this-room",
      }),
    });
  }, [
    feed?.pitLanes,
    feed?.now,
    feed?.briefing?.videos,
    feed?.checkinProgress,
    nowMs,
    trackStatus?.currentRaces,
    liveTrack,
    megaEnabled,
    room,
    roomsNow,
    railClock,
  ]);

  if (!room) return <Unconfigured />;

  const accent = ROOM_ACCENT[room];
  const state = stateNow;
  const timeline = briefingTimelineAt(state, nowMs);

  const tier = state?.tier ?? tierForRaceType(null);
  const videoSrc = assets.srcFor(tier);
  const videoUnplayable = !!videoSrc && failedSrc === videoSrc;

  /**
   * The strip is on the rail unless the kill switch is off. Preview modes get it
   * too, from demo data, so it can be reviewed off a laptop.
   *
   * The band it occupies is 104 px with cameras out and a 44 px whisper when
   * everything is accounted for (cameraBarHeight owns that decision, so the
   * reserve below and the bar itself cannot disagree). Every phase lays out above
   * it, the safety film included: the group about to be handed kit is the one
   * sitting in front of the film.
   */
  // NORMALISED, NOT TRUSTED. The feed can arrive from localStorage written by an
  // OLDER BUILD — that is what crashed every briefing TV on 2026-08-12 when this
  // payload's fields were renamed. See normaliseCameraReturn.
  /**
   * WHEN THE WELCOME-BACK BOARD IS DUE (owner 2026-08-14: "as long as we're not
   * showing a briefing or helmet screen it should come up. If we are showing
   * either it should come up right after").
   *
   * It used to be idle-only, and that quietly stopped being reachable. The
   * helmet phase deliberately NO LONGER ENDS (phase.ts, owner 2026-08-14 —
   * removing the auto-advance that used to strand groups in a room the board
   * had already given away), so a room whose group nobody explicitly moved on
   * sits in `helmet` for the rest of the night and `idle` never arrives. The
   * board then only appeared on the rooms somebody happened to clear, which is
   * exactly the "worked a couple of times today" the owner saw.
   *
   * The owner's correction names the distinction exactly: "helmet phase is max
   * 30 seconds, just don't auto send them to holding after 30 seconds." The
   * SCREEN moves on; the OCCUPANCY does not. This changes only what the wall
   * shows — `briefingTimelineAt` still parks on `helmet`, so the desk still
   * counts the room as occupied and still offers Send to holding, which is the
   * limbo phase.ts was protecting against.
   *
   * So: the film always wins, the helmet board wins for its own full run, and
   * after that a returning group takes the wall. The group cannot be back
   * before their own race has ended — `welcomeBack` resolves off the timing
   * system's actualEnd for THIS room's latest group — so there is no window in
   * which this greets somebody who has not raced.
   */
  // The board's own 30 seconds, from the one place that owns that question —
  // the room-blocked alert below asks it too, and two inline copies of
  // `videoMs + HELMET_PHASE_MS` is one of them getting it wrong later.
  const helmetBoardDone = helmetBoardComplete(state, timeline, nowMs);
  const showWelcomeBack =
    (timeline.phase === "idle" || helmetBoardDone) && !!feed?.briefing?.welcomeBack;

  const venueStrip = normaliseCameraReturn(feed?.briefing?.cameraReturn);
  /**
   * SCOPED TO THIS ROOM ONCE, and the height measured off the SCOPED copy.
   *
   * Measuring the venue-wide strip instead would reserve the full band on a Red
   * screen whose only content was Blue's incoming cameras, then render the 44 px
   * all-clear line inside it — a 60 px hole under the board. One derived value, so
   * the reserve and the render cannot disagree.
   */
  const cameraReturn = venueStrip
    ? { ...venueStrip, incoming: incomingForRoom(venueStrip.incoming, room) }
    : null;
  const barH = cameraBarHeight(cameraReturn);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* EVERY PHASE LIVES INSIDE THIS BOX, which is the whole canvas minus the
          camera strip. One wrapper rather than a bottom-inset threaded through
          four boards: each branch keeps its own `inset: PAD_Y PAD_X` and is
          shifted up for free, the accent bars and radial washes stay bounded to
          the picture area instead of bleeding under the strip, and the film's
          `objectFit: cover` simply crops to the smaller box. */}
      <div style={{ position: "absolute", inset: 0, bottom: barH, overflow: "hidden" }}>
        {timeline.phase === "waiting" ? (
          <TakeASeat
            accent={accent}
            heatNumber={state?.heatNumber ?? null}
            // The session's real level, NOT which film plays — a Pro grid must not
            // be told they are in a Starter race (owner 2026-08-11).
            raceType={state?.raceType ?? null}
            trackLabel={state?.track ? TRACK_LABELS[state.track] : null}
            target={state?.track ? nextLevelTarget(state.track, state.raceType) : null}
          />
        ) : timeline.phase === "video" && videoSrc && !videoUnplayable ? (
          <BriefingVideo
            // Keyed on the send, so a NEW briefing remounts the element and starts
            // its own playback — and a re-render inside one briefing does not.
            key={`${state?.sessionId ?? "none"}:${state?.triggeredAtMs ?? 0}`}
            src={videoSrc}
            seekToMs={timeline.videoOffsetMs}
            onUnplayable={markUnplayable}
          />
        ) : showWelcomeBack ? (
          // THE GROUP IS BACK (owner 2026-08-11): their session's actualEnd is
          // stamped, so the wall greets them — kit return, who levelled up and
          // who didn't (from the end-of-race capture), the qualifying time,
          // where scores are posted. A playing video always outranks it; the
          // helmet board outranks it only for its own 30 seconds (see
          // welcomeBackDue).
          <WelcomeBack
            accent={accent}
            room={room}
            info={feed!.briefing!.welcomeBack!}
            // Idle = the occupancy is actually closed. The helmetBoardDone
            // path shows this board while the previous group is STILL in the
            // room, and the greeting must not sound over their fitting.
            roomEmpty={timeline.phase === "idle"}
            // The exit board is THE board (owner 2026-08-23: "goal is to get
            // them out of the room as quickly as possible"). The old
            // who-qualified layout is PRESERVED behind its own preview mode —
            // "save the qualifiers page case we ever want it back" — and
            // bringing it back for real is flipping this one expression.
            variant={demo === "briefing-return-quals" ? "qualifiers" : "exit"}
          />
        ) : timeline.phase === "idle" ? (
          /**
           * AN EMPTY ROOM SHOWS WHERE EVERYONE IS (owner 2026-08-24: "after the
           * leave room finally finishes I'd like to go to the session overview
           * that pit goes to when it has nothing").
           *
           * The greeting used to hold this slot until another group arrived,
           * which on a quiet stretch meant an exit sign facing an empty room
           * for half an hour (see welcomeBackExpired). What replaces it is the
           * pit signs' own idle answer, from the SAME builder they use
           * (briefing/stage-rail.ts) — so the wall outside the room and the
           * wall inside it cannot describe one night differently.
           */
          <IdleStageRail accent={accent} rows={idleStages} />
        ) : (
          <Board
            accent={accent}
            room={room}
            phase={timeline.phase === "video" ? "helmet" : timeline.phase}
            posterSrc={assets.posterSrc}
            heatNumber={state?.heatNumber ?? null}
            // The lap THIS room's group has to beat. They sit through the helmet and
            // next-race boards, which is when there is actually time to read it.
            target={state?.track ? nextLevelTarget(state.track, state.raceType) : null}
          />
        )}
      </div>

      {/* WHICH POV CAMERAS ARE STILL OUT — every phase, the film included, for
          the same reason the clock is: the group about to be handed kit is the
          one sitting in front of the film (owner 2026-08-12). Venue-wide, so
          both rooms show the identical strip. */}
      {/* WHICH POV CAMERAS ARE STILL OUT, and — at its right end — THE ON-TRACK
          CLOCK. The clock moved off the top-right corner and into the strip
          (owner 2026-08-12: "that way its out of the way"), which supersedes the
          8/11 "move on track timer to top right": that corner was only ever the
          least-bad option while the alternative was floating over a film. The
          strip is permanent staff chrome, so the clock belongs in it. */}
      {cameraReturn && (
        <CameraReturnBar
          // Already room-scoped above: STILL OUT venue-wide, INCOMING this room's
          // own (owner 2026-08-12: "Blue goes to blue, red goes to red").
          stillOut={cameraReturn.stillOut}
          incoming={cameraReturn.incoming}
          stale={cameraReturn.stale}
          padX={PAD_X}
          clockTrack={liveTrack}
          accent={accent}
        />
      )}

      {/*
        TOP RIGHT, and it is the one corner of this screen that is reliably free
        (owner 2026-08-14: "where is logo"). The eyebrow owns the top left, the
        camera-return strip owns the whole bottom band, and the on-track clock
        normally lives in that strip — it only comes back up here when the strip
        is switched off, which is why the two share one row rather than one
        corner. The clock keeps the outside position it has always had.

        NOT DURING THE FILM. A safety briefing plays full-bleed and gets the
        screen to itself; a mark in the corner of it buys nothing and is the sort
        of thing somebody has to ask to have taken off again.
      */}
      {timeline.phase !== "video" && (
        <div
          style={{
            position: "absolute",
            right: PAD_X,
            top: 40,
            zIndex: 6,
            display: "flex",
            alignItems: "center",
            gap: 30,
          }}
        >
          <div style={{ opacity: 0.85, display: "flex" }}>
            <TvBrandLogo venue="FT" height={44} />
          </div>
          {/* FALLBACK ONLY. With the strip switched off there is no band to hold
              the clock, so it returns to the corner it used to own rather than
              vanishing — a briefing room without the on-track time is a
              downgrade on what shipped 8/11. Renders nothing when no heat is
              live. */}
          {!cameraReturn && <LiveSessionChip track={liveTrack} accent={accent} />}
        </div>
      )}

      {/* OVER EVERYTHING, the film included. See RoomBlockedOverlay. */}
      <RoomBlockedOverlay
        alert={roomBlockedAlertAt({ state, waiting: feed?.roomBlocked?.[room], nowMs })}
        accent={accent}
        room={room}
      />
    </div>
  );
}

/* ── a race is waiting on this room ───────────────────────────────────── */

/**
 * FULL SCREEN, BECAUSE THE ROOM IS THE ONLY PLACE THE REFUSAL WAS NEVER SHOWN
 * (owner 2026-08-16: "when a race is waiting in pit because the briefing room is
 * occupied… flash a red full screen alert that a race is waiting in pit").
 *
 * The post-race announcement calls a finished group back in to hand kit over, so
 * `postRaceGate` refuses to play it into an occupied room. That refusal has been
 * visible at the pit station since 8/14 — a dark Play Post button with `red room
 * busy` on it — and invisible to the fifteen people standing in the room causing
 * it. This is the same verdict, addressed to them.
 *
 * IT ASKS FOR THE ONLY THING THE ROOM CAN DO (owner 2026-08-16: "it can't say
 * leave room now — it can say helmet up and wait for a track marshal"). Nobody
 * walks out of a briefing room unescorted, so an instruction to leave would be
 * both unfollowable and unsafe. A group already helmeted and standing turns the
 * marshal's trip into a twenty-second walk-out instead of a two-minute one,
 * which is the whole of what this buys — it does not free the room, a marshal
 * does, and the copy must not imply otherwise.
 *
 * NEVER DURING THE FILM OR THE HELMET BOARD'S OWN 30 SECONDS — that gate is
 * `roomBlockedAlertAt`, and it is why this component takes a verdict rather than
 * facts. Shouting at a group for watching the safety briefing they were sat down
 * to watch is how a wall teaches a room to ignore it.
 *
 * MOTION IS NEVER THE ONLY SIGNAL. The same 1.4s beat the pit board's send gate
 * uses — one beat per canvas — and reduced motion keeps the colour and the words
 * while dropping the pulse.
 */
function RoomBlockedOverlay({
  alert,
  accent,
  room,
}: {
  alert: ReturnType<typeof roomBlockedAlertAt>;
  accent: string;
  room: BriefingRoom;
}) {
  if (!alert) return null;
  const heat = alert.heatNumber != null ? `Session ${alert.heatNumber}` : null;

  return (
    <div
      role="alert"
      className="room-gate"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        textAlign: "center",
        padding: `0 ${PAD_X}px`,
        // Opaque, not a tint. The helmet chart underneath has had its run, and a
        // warning you can read a poster through is not a warning.
        background: "#1a0206",
        borderTop: `13px solid ${accent}`,
      }}
    >
      <style>{ROOM_GATE_STYLES}</style>
      <span className="tv-eyebrow" style={{ fontSize: 30, color: "rgba(245,236,238,0.6)" }}>
        {ROOM_LABEL[room]}
      </span>
      <div
        className="tv-display"
        style={{
          fontSize: 140,
          lineHeight: 0.92,
          color: STOP_RED,
          textShadow: `0 0 86px ${withAlpha(STOP_RED, 0.55)}`,
        }}
      >
        Helmet up
      </div>
      <div className="tv-display" style={{ fontSize: 69, color: "#fff" }}>
        Wait for a track marshal
      </div>
      <div
        aria-hidden
        style={{
          width: 280,
          height: 5,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${accent}, ${withAlpha(accent, 0)})`,
        }}
      />
      {/* WHY, in the words that make it worth acting on. "Helmet up" with no
          reason reads as ordinary signage; the waiting race is what turns it
          into something to hurry for. */}
      <p
        style={{
          fontSize: 37,
          fontWeight: 600,
          lineHeight: 1.3,
          color: "rgba(255,255,255,0.82)",
          margin: 0,
          maxWidth: 1380,
        }}
      >
        {heat ? `${heat} is waiting in the pit. ` : "A race is waiting in the pit. "}
        Have your helmet on and be ready to move the moment a marshal comes for you.
      </p>
    </div>
  );
}

/** The house alert red — the same one the pit board's STOP SENDING owns, so one
 *  colour means one thing across every wall in the building. */
const STOP_RED = "#ff2d38";

const ROOM_GATE_STYLES = `
.room-gate { animation: room-gate 1.4s ease-in-out infinite; }
@keyframes room-gate {
  0%, 100% { background-color: #1a0206; }
  50%      { background-color: #48060f; }
}
/* A wall alert must never be motion-only — the colour and the words carry it. */
@media (prefers-reduced-motion: reduce) {
  .room-gate { animation: none; background-color: #48060f; }
}
`;

/* ── the video ────────────────────────────────────────────────────────── */

/**
 * The safety film, full-bleed, with sound.
 *
 * Seeks once on mount and then leaves playback alone. Continuously correcting
 * against the clock would be wrong here: unlike the kiosk billboard (where two
 * screens must show the same frame), a briefing room has ONE screen and the
 * audience is watching content, so a mid-video seek would be a visible stutter
 * for no benefit. The seek exists purely so a reboot rejoins in the right place.
 */
function BriefingVideo({
  src,
  seekToMs,
  onUnplayable,
}: {
  src: string;
  seekToMs: number;
  /** This player cannot decode the file — hand the wall back to the scene. Takes
   *  the src so the parent needs no per-render closure. */
  onUnplayable: (src: string) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  /**
   * THE SEEK OFFSET AND THE CALLBACK ARE HELD IN REFS, and that is the whole fix
   * for the bug that made a briefing never play at all.
   *
   * `seekToMs` is derived from the shared clock, so it changes on every director
   * tick — about four times a second. `onUnplayable` was a fresh closure each
   * render. Both were in this effect's dependency array, so the effect re-ran ~4×/s,
   * and past the two-second mark each run RE-SEEKED the element. The media pipeline
   * was reset four times a second: new range requests, aborted reads, and a picture
   * that could never start. Three HARs off the Blue player show exactly that
   * (owner 2026-08-11).
   *
   * The effect now depends only on `src` and a STABLE callback — one mount, one
   * seek, one play. The offset is captured on first render, which is the only moment
   * it means anything: "where should this film start", asked once. A remount for a
   * genuinely new briefing is handled by the `key` on the element in the scene above.
   */
  const seekOnceToMs = useRef(seekToMs);
  /**
   * The src is CAPTURED AT MOUNT and never follows the prop. The cache can finish
   * adopting mid-film (adoption deliberately runs during playback), which flips
   * srcFor's answer from the network URL to a blob: URL — and rewriting the src
   * attribute of a playing element resets it to frame zero. The cached copy is for
   * the NEXT play; this one finishes on the pipe it started on. A genuinely new
   * briefing remounts via the element's key, which re-captures.
   */
  const [mountSrc] = useState(src);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fail = () => onUnplayable(mountSrc);
    // Only seek a genuine rejoin. Seeking to ~0 on a normal start can cost a
    // keyframe decode for nothing.
    const startAtMs = seekOnceToMs.current;
    if (startAtMs > 2_000) {
      try {
        el.currentTime = startAtMs / 1000;
      } catch {
        /* not seekable yet — playback simply starts from the beginning */
      }
    }
    const play = async () => {
      try {
        await el.play();
      } catch {
        // Autoplay refused (a browser without the player's autoplay flag, e.g.
        // a laptop previewing the screen). Fall back to muted, which every
        // browser allows, so a reviewer still sees the film.
        try {
          el.muted = true;
          await el.play();
        } catch {
          fail();
        }
      }
    };
    void play();

    /**
     * IS IT STUCK, OR IS IT JUST SLOW? — and the difference matters enormously.
     *
     * A container Edge can parse but not decode paints black forever and raises NO
     * error, so something has to notice. But the first version of this check gave up
     * after six seconds flat, which condemned a perfectly good film that was merely
     * loading: these are 220 MB files, the .mov's index sits at the END so the
     * demuxer fetches the tail before it can start, and venue internet is what it is.
     * That turned a slow start into a permanent fallback to the helmet board.
     *
     * So this watches for PROGRESS rather than checking a stopwatch once. Any of a
     * decoded frame, a growing buffer, or advancing playback counts as alive, and the
     * clock only runs while nothing at all is happening. A film that is downloading
     * is never declared broken.
     */
    let lastProgressAt = Date.now();
    let lastBuffered = 0;
    const poll = setInterval(() => {
      const v = ref.current;
      if (!v) return;

      const buffered = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      const decoded = v.readyState >= 2 && v.videoWidth > 0; // HAVE_CURRENT_DATA + a picture
      if (decoded || buffered > lastBuffered || v.currentTime > 0.1) {
        lastBuffered = buffered;
        lastProgressAt = Date.now();
      }

      // Playing happily — nothing more to watch for.
      if (decoded && v.currentTime > 0.1) {
        clearInterval(poll);
        return;
      }

      if (Date.now() - lastProgressAt > STALL_GIVE_UP_MS) {
        clearInterval(poll);
        fail();
      }
    }, 2_000);
    return () => {
      clearInterval(poll);
      // TEAR THE MEDIA PIPELINE DOWN, not just the React node. A detached
      // <video> keeps its demuxer, decoder and buffered frames alive until GC
      // feels like it — and this element is keyed per send, so a briefing room
      // detaches 50-odd of them a day. pause + srcless load() is the idiom
      // Chromium actually releases on.
      //
      // `el` from the effect body, NOT ref.current: on unmount React nulls
      // host refs during the commit's mutation phase, BEFORE passive cleanups
      // run — reading the ref here would make this whole block a silent no-op.
      try {
        el.pause();
      } catch {
        /* already torn down */
      }
      el.removeAttribute("src");
      el.load();
    };
    // NO clock-derived value in this list — that is what caused the reseek loop —
    // and mountSrc never changes, so this runs exactly once per element.
  }, [mountSrc, onUnplayable]);

  return (
    /* CAPTIONS: no caption file exists for the briefing films yet. Worth having —
       this is the one video on the estate a guest is required to absorb — but a
       <track> pointing at nothing is worse than none, because it advertises
       captions that never appear. Add the VTT and the track in the same change.
       Staff brief deaf guests in person in the meantime. */
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      ref={ref}
      src={mountSrc}
      autoPlay
      playsInline
      // Buffer ahead rather than stopping at metadata: by the time staff press
      // Start, the group has usually been walking for a minute and the element has
      // had that whole time to get ahead.
      preload="auto"
      // NOT muted, NOT looping. It is a briefing: it is heard once, and it ends.
      controls={false}
      onError={() => onUnplayable(mountSrc)}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}

/* ── the boards ───────────────────────────────────────────────────────── */

/** M:SS for the rail, the same shape the pit sign's tracker uses. */
function formatRailClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * THE IDLE BOARD — where every session is, for a room with nobody in it.
 *
 * Same rows, same wording and same order as the pit signs' idle wall, because
 * both come out of buildStageRail. Typography is this scene's, not that one's:
 * a briefing room is read from a few feet away by people who have just walked
 * in, so the rows sit larger and the heading names the room rather than
 * apologising for having nothing to seat.
 */
function IdleStageRail({ accent, rows }: { accent: string; rows: StageRow[] }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: `${PAD_Y}px ${PAD_X}px`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: "min(34px, 4vh)",
      }}
    >
      <div
        className="tv-display"
        style={{ fontSize: "min(78px, 9vh)", color: "#fff", lineHeight: 0.95 }}
      >
        Where every session is
      </div>
      <div style={{ display: "grid", gap: "min(18px, 2.2vh)" }}>
        {rows.map((st) => {
          const empty = st.value === "—";
          return (
            <div
              key={st.label}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "min(32px, 3vw)",
                flexWrap: "wrap",
              }}
            >
              <span
                className="tv-display"
                style={{
                  minWidth: 300,
                  fontSize: "min(38px, 4.2vh)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: withAlpha("#f5ecee", 0.5),
                }}
              >
                {st.label}
              </span>
              <span
                className="tv-display"
                style={{
                  fontSize: "min(46px, 5vh)",
                  color: empty ? withAlpha("#f5ecee", 0.32) : "#fff",
                }}
              >
                {st.value}
              </span>
              {st.type && (
                <span style={{ fontSize: "min(32px, 3.4vh)", color: withAlpha("#f5ecee", 0.62) }}>
                  {st.type}
                </span>
              )}
              {st.detail && (
                <span style={{ fontSize: "min(32px, 3.4vh)", color: accent, fontWeight: 700 }}>
                  {st.detail}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Board({
  accent,
  room,
  phase,
  posterSrc,
  heatNumber,
  target,
}: {
  accent: string;
  room: BriefingRoom;
  phase: "helmet" | "idle";
  posterSrc: string | null;
  heatNumber: number | null;
  target: { level: string; ms: number } | null;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
          zIndex: 2,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 35%, ${withAlpha(accent, 0.4)}, transparent 74%)`,
        }}
      />

      {/* A BRIEFING SCREEN SAYS NOTHING ABOUT A RACE UNTIL THAT RACE IS SENT HERE.
          An earlier pass put the next called heat on the idle board, which on a Mega
          day announced "NEXT UP Session 32" in BOTH rooms for a session that could
          only go to one of them (owner 2026-08-11: "this shouldn't show on briefing
          screen till the race is assigned to that room"). A session that HAS been
          assigned already has its own board — the take-a-seat one — so there was
          never a moment this belonged. Idle is helmet sizes. */}
      <HelmetBoard
        accent={accent}
        room={room}
        posterSrc={posterSrc}
        heatNumber={phase === "helmet" ? heatNumber : null}
        target={target}
      />
    </div>
  );
}

/**
 * Helmet sizing — the poster the owner supplies, full-bleed.
 *
 * `contain`, not `cover`: this is an information graphic and cropping it would
 * cut a size off the chart. Until a poster is uploaded the board shows a plain
 * sizing instruction rather than a black rectangle, so a room is never blank.
 */
function HelmetBoard({
  accent,
  room,
  posterSrc,
  heatNumber,
  target,
}: {
  accent: string;
  room: BriefingRoom;
  posterSrc: string | null;
  heatNumber: number | null;
  target: { level: string; ms: number } | null;
}) {
  if (posterSrc) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- the poster is
            usually a blob: object URL served from the player's own cache, which
            next/image cannot take as a source. Same reason the kiosk's own media
            bypasses the optimizer (features/kiosk/assets.ts). */}
        <img
          src={posterSrc}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "#000418",
          }}
        />
        {/* Overlay chips ride the BOTTOM edge, below the poster's own title band
            (owner 2026-08-12: "move the grab your helmet and qualification to
            under the helmet size text").

            This reverses the 2026-08-11 placement, and the reason it does is the
            artwork. Back then the chips sat on top of the poster's title and read
            as part of it gone wrong ("grab your helmet looks out of place"), so
            they were moved to the top edge. The current poster ends its title band
            well above the frame and leaves clear ground under it — so the chips now
            sit in that band, reading as a caption to the chart rather than as
            something stuck over it. A poster whose art runs to the bottom edge would
            put this back in play; judge it against the poster on the wall, not
            against this comment.

            THE 40 px IS ABOVE THE CAMERA STRIP, not above the panel edge: every
            phase renders inside the scene's `bottom: barH` box (see the wrapper in
            SceneBriefing), so this cluster and the strip can never overlap however
            the strip resizes. The poster is `contain` inside that same box, so its
            bottom edge and this cluster's ground are the one line.

            Solid dark chip backgrounds rather than backdrop blur: these players are
            mini PCs and a blur over a full-screen image is compositor work they can
            feel. */}
        {/* Chips cluster LEFT — the right-hand corner above them belongs to the
              live session clock on every board. */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            left: PAD_X,
            right: PAD_X,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: 20,
            flexWrap: "wrap",
            zIndex: 3,
          }}
        >
          {heatNumber != null ? (
            <div
              className="tv-display"
              style={{
                fontSize: 40,
                color: "#fff",
                padding: "10px 30px",
                borderRadius: 999,
                background: "rgba(0, 4, 24, 0.82)",
                border: `2px solid ${withAlpha(accent, 0.8)}`,
              }}
            >
              Session {heatNumber} · grab your helmet
            </div>
          ) : (
            <span />
          )}
          {target && <QualifyTarget accent={accent} target={target} compact solid />}
        </div>
      </>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: `${PAD_Y}px ${PAD_X}px`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 24,
      }}
    >
      <span className="tv-eyebrow" style={{ color: accent, fontSize: 38 }}>
        {ROOM_LABEL[room]}
      </span>
      <div className="tv-display" style={{ fontSize: 150, color: "#fff", lineHeight: 0.95 }}>
        Helmet sizes
      </div>
      <p style={{ fontSize: 46, color: "rgba(245,236,238,0.66)", margin: 0, maxWidth: 1300 }}>
        Find your size on the rack, then take a seat. Staff will fit you before you head out to the
        karts.
      </p>
      {/* Where results are (owner 2026-08-11). A group leaving the briefing asks it
          immediately, and the answer is a walk rather than a screen. */}
      <p style={{ fontSize: 40, color: "rgba(245,236,238,0.6)", margin: 0 }}>
        Race scores are posted outside the briefing room, near check-in and Red Track.
      </p>
      {target && <QualifyTarget accent={accent} target={target} />}

      <div
        aria-hidden
        style={{
          width: 260,
          height: 5,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${accent}, ${withAlpha(accent, 0)})`,
        }}
      />
    </div>
  );
}

/**
 * The holding board: sent here, film not started yet.
 *
 * A group walks in over a minute or two, so this is what they see while they find
 * seats — the session they are in, unmistakably, and an instruction. It exists
 * because rolling the safety film at send time meant the first arrivals watched
 * the opening while the rest were still in the corridor (owner 2026-08-11).
 */
function TakeASeat({
  accent,
  heatNumber,
  raceType,
  trackLabel,
  target,
}: {
  accent: string;
  heatNumber: number | null;
  raceType: string | null;
  trackLabel: string | null;
  /** The lap to beat for the next level, when there is one to aim for. */
  target: { level: string; ms: number } | null;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
        }}
      />
      <div
        aria-hidden
        className="tv-breathe"
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 45%, ${withAlpha(accent, 0.42)}, transparent 74%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 26,
        }}
      >
        {/* TRACK, then SESSION, then LEVEL — the three things a group walking in
            needs to confirm they are in the right room for the right race. */}
        <span className="tv-eyebrow" style={{ color: accent, fontSize: 44 }}>
          {trackLabel ?? "Your race"}
        </span>
        {heatNumber != null && (
          <div
            className="tv-display tv-rise"
            style={{ fontSize: 190, color: "#fff", lineHeight: 0.9 }}
          >
            Session {heatNumber}
          </div>
        )}
        {raceType && (
          <div className="tv-display" style={{ fontSize: 84, color: accent }}>
            {raceType}
          </div>
        )}
        {/* The instruction that matters in the hold: groups were suiting up
            before anyone briefed them (owner 2026-08-11). */}
        <p style={{ fontSize: 50, color: "rgba(245,236,238,0.72)", margin: 0 }}>
          Please do not get geared up. We&rsquo;ll help you after the briefing video.
        </p>

        {target && <QualifyTarget accent={accent} target={target} />}
      </div>
    </div>
  );
}

/**
 * The lap to beat for the next level — one component, every board that shows it.
 *
 * It appears on three now (before the film, during helmet sizing, and on the
 * next-race board) because those are the phases a group is SITTING there with time
 * to read it (owner 2026-08-11: "we're also listing the qualification times so that
 * they know what they need to level up"). Extracted rather than repeated: a target
 * worded three slightly different ways would be three chances to disagree with
 * itself. The number comes from the same constants the level-up decision uses, so
 * what a racer is told to beat is the line they are judged against.
 */
/**
 * RACERS DUE STRAIGHT BACK OUT — the panel beside the qualifying chip.
 *
 * A racer booked in one of the next two heats should walk back to the holding
 * seats, not out through check-in and round again. Nothing told them, and
 * nothing told the staff member seating the next grid either.
 *
 * NO TRACK IN THE HEADING, and no "seats" (owner 2026-08-14: "don't say seat and
 * its cut off"). Two faults in one line: it ran past the panel edge, and it
 * named ONE track while these racers can be joining two — a single "go to the
 * Blue holding" would have sent half of them to the wrong lane. The track lives
 * on each row, where it is right per racer.
 *
 * ONE LINE PER DESTINATION HEAT, not one line for everybody, for the same reason.
 *
 * "JOINING" IS ON THE CHIP (owner 2026-08-14: "update this to they're joining
 * and to where"). A bare session number read as though that heat was the one
 * coming back; the word makes it a destination — and it is the same word the
 * staff camera board uses, so the two screens cannot describe one fact
 * differently.
 */
function RacingAgainPanel({
  groups,
}: {
  groups: Array<{ session: number | null; track: string; names: string[] }>;
}) {
  if (groups.length === 0) return null;
  // Names shrink as the destinations grow, so the panel never outgrows the chip
  // beside it — the same discipline pillScale applies above.
  const nameSize = groups.length > 2 ? 26 : groups.length > 1 ? 30 : 34;
  const toSize = groups.length > 2 ? 22 : 26;
  return (
    <div
      style={{
        flex: "1 1 auto",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 6,
        padding: "14px 30px",
        borderRadius: 18,
        border: `3px solid ${withAlpha(AMBER, 0.7)}`,
        background: withAlpha(AMBER, 0.12),
      }}
    >
      <span
        style={{
          fontSize: 24,
          fontWeight: 800,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: AMBER,
        }}
      >
        Racing again — go straight to holding
      </span>
      {groups.map((g) => {
        const key = g.track as TrackKey;
        const trackAccent: string = TRACK_ACCENTS[key] ?? AMBER;
        const trackName = (TRACK_LABELS[key] ?? g.track).replace(" Track", "");
        return (
          <div
            key={`${g.session ?? "?"}-${g.track}`}
            style={{ display: "flex", alignItems: "baseline", gap: 14, minWidth: 0 }}
          >
            <span
              className="tv-display"
              style={{
                flexShrink: 0,
                fontSize: toSize,
                padding: "2px 14px",
                borderRadius: 999,
                whiteSpace: "nowrap",
                color: trackAccent,
                border: `2px solid ${trackAccent}`,
                background: withAlpha(trackAccent, 0.16),
              }}
            >
              <em style={{ fontStyle: "normal", fontWeight: 700, opacity: 0.8 }}>Joining </em>
              {g.session ?? "—"} · {trackName}
            </span>
            <span
              style={{
                fontSize: nameSize,
                color: "#fff",
                fontWeight: 600,
                lineHeight: 1.2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {g.names.join("  ·  ")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function QualifyTarget({
  accent,
  target,
  compact,
  solid,
}: {
  accent: string;
  target: { level: string; ms: number };
  /** Pill form, for sitting alongside other chrome rather than owning a row. */
  compact?: boolean;
  /** Opaque dark ground — for riding on top of poster artwork, where the
   *  translucent accent fill vanishes into whatever is behind it. */
  solid?: boolean;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: compact ? 14 : 20,
        alignSelf: "flex-start",
        padding: compact ? "10px 22px" : "18px 34px",
        borderRadius: compact ? 999 : 18,
        border: `${solid ? 2 : 3}px solid ${withAlpha(accent, solid ? 0.8 : 0.75)}`,
        background: solid ? "rgba(0, 4, 24, 0.82)" : withAlpha(accent, 0.16),
      }}
    >
      <span style={{ fontSize: compact ? 26 : 34, color: "rgba(245,236,238,0.78)" }}>Beat</span>
      <span className="tv-display tv-num" style={{ fontSize: compact ? 44 : 92, color: "#fff" }}>
        {formatLap(target.ms)}
      </span>
      <span style={{ fontSize: compact ? 26 : 34, color: "rgba(245,236,238,0.78)" }}>
        to qualify {target.level}
      </span>
    </div>
  );
}

/**
 * WELCOME BACK — the group has raced and is walking in to return kit.
 *
 * SINCE 2026-08-23 THIS IS AN EXIT BOARD (owner: "goal is to get them out of
 * the room as quickly as possible" — the room cameras show the median group
 * spends 1:27 in here, and on busy nights most returns blend straight into
 * the next send). The hero is the way OUT: a chevron run into the white door
 * on the side it actually is, a four-line kit checklist, and the racing-again
 * band for anyone who must stay. The who-qualified name board this replaced
 * is PRESERVED below (WelcomeBackQualifiers) behind its own preview mode —
 * "save the qualifiers page case we ever want it back".
 */
/** What the welcome-back feed section carries — see types.ts for field notes. */
interface WelcomeBackInfo {
  heatNumber: number | null;
  raceType: string | null;
  track: "blue" | "red" | "mega";
  endedAtMs: number;
  postPlayedAtMs: number | null;
  arrivedAtMs: number | null;
  lingerAtMs: number | null;
  motionHealthy: boolean;
  greetingByMotion: boolean;
  greetingTiming?: { fallbackMs: number; maxPlays: number; lingerAfterMs: number };
  audioUrl: string | null;
  lingerAudioUrl: string | null;
  results: {
    levelledUp: Array<{ name: string; bestMs: number }>;
    keepPushing: Array<{ name: string; bestMs: number | null }>;
  } | null;
  racingAgain: Array<{ session: number | null; track: string; names: string[] }>;
}

/** Tear an Audio element all the way down. removeAttribute alone leaves the
 *  fetched resource selected; a srcless load() is what makes Edge let go. */
function releaseAudio(el: HTMLAudioElement): void {
  el.onended = null;
  el.onplaying = null;
  el.onpause = null;
  el.onerror = null;
  el.pause();
  el.removeAttribute("src");
  el.load();
}

/**
 * WHAT IS ACTUALLY COMING OUT OF THE SPEAKER — the state behind the board's
 * audio chip (owner 2026-08-23: "add an audio playing message somewhere on
 * the board just so we can visually see it").
 *
 * DRIVEN BY THE ELEMENT'S OWN EVENTS, never by our schedule. The whole point
 * of the chip is to answer "did the clip actually play" from across the room,
 * and a chip driven by intent would light up on a TV whose browser had
 * refused autoplay — which is precisely the failure it needs to expose. So
 * `playing` comes from `playing`/`pause`/`ended`/`error` on the element.
 */
interface GreetingAudioState {
  /** Sounding right now. */
  playing: boolean;
  /** Which clip — the greeting, or the still-in-the-room reminder. */
  clip: "greeting" | "reminder" | null;
  /** Greeting plays used in this return, and the cap they are counted against. */
  plays: number;
  maxPlays: number;
  /** No greeting will sound at all for this group, and why. Staff standing in
   *  a silent room should be able to tell "working as intended" from "broken". */
  silentBecause: "pro" | "no-clip" | null;
}

/**
 * The greeting, re-timed (owner 2026-08-23). WHEN it speaks is pure arithmetic
 * in briefing/return-greeting.ts — the room camera's server-stamped arrival,
 * or post + 45s, per the settings-sheet "greeting by motion" switch — this
 * hook only schedules what those numbers say.
 *
 * THE ROOM GATE STANDS (owner 2026-08-15: "audio cannot play at all unless
 * briefing is empty/coming back"): the board legitimately shows while the
 * PREVIOUS group still occupies the room, and no clip may talk over a helmet
 * fitting. So does the POST anchor (owner 2026-08-15): every timing input is
 * a server stamp, so a remounted or rebooted TV agrees on the schedule and a
 * spent greeting can never return.
 *
 * PRO GRIDS ARE SILENT (owner 2026-08-23: "No message is needed for pro
 * racers") — the board still shows, the sound never arms. tierForRaceType
 * counts Junior Pro as pro, which is the intent: they know the drill.
 *
 * Repeats: GREETING_GAP_MS after each play's END, at most `maxPlays` plays,
 * never past the post + 2-minute window — three bounds, first to land wins
 * (owner 2026-08-23: "have a timeout on number of repeats"). The delay and the
 * cap are staff settings; the window and the gap are not. The next briefing
 * taking the room unmounts the board and the cleanup stops the sound mid-note.
 * Every play failure is swallowed: a TV whose browser refuses autoplay shows
 * the board silently — and the chip says so, because it follows the element.
 *
 * RETURNS what is audible, for the board's chip. See GreetingAudioState.
 */
function useWelcomeBackAudio(info: WelcomeBackInfo, roomEmpty: boolean): GreetingAudioState {
  const {
    audioUrl,
    lingerAudioUrl,
    postPlayedAtMs,
    arrivedAtMs,
    lingerAtMs,
    motionHealthy,
    greetingByMotion,
    raceType,
  } = info;
  const proSilent = tierForRaceType(raceType) === "pro";
  // Defaulted field by field: this payload can come from an older build's
  // localStorage, and a missing blob must read as house behaviour rather than
  // as zero plays (the 2026-08-12 renamed-payload crash is the precedent).
  const timing = normaliseGreetingTiming(info.greetingTiming);

  /** Sounding now, and which clip. One piece of state so the two effects
   *  cannot both claim the chip. */
  const [audible, setAudible] = useState<"greeting" | "reminder" | null>(null);
  /** Plays used, mirrored into state purely so the chip can count them — the
   *  ref below stays the source of truth for the cap. */
  const [playCount, setPlayCount] = useState(0);

  /**
   * THE PLAY CAP OUTLIVES THE EFFECT. The effect below legitimately restarts
   * mid-window — the arrival stamp landing, the room-empty gate flapping, a
   * camera recovering after the 45s fallback already spoke — and a counter
   * inside it would reset each time, letting one return be greeted six times.
   * The count therefore lives up here, keyed on the post stamp (one return =
   * one post press) so the NEXT return starts its own tally.
   */
  const playsRef = useRef<{ anchor: number; count: number } | null>(null);

  /**
   * WHEN THIS RETURN'S GREETING SPEAKS, LATCHED (owner 2026-08-24: "it seems
   * like the motion will interrupt an already playing announcement and it
   * shouldn't").
   *
   * The audio effect below used to depend on `arrivedAtMs` directly, so the
   * arrival stamp landing — which normally happens a poll or two AFTER the
   * fixed timer has already started the clip — tore the element down mid-word
   * and started the schedule again. The room heard the greeting restart.
   *
   * So the start moment is state, not a derived value: a fresh arrival may pull
   * it EARLIER, which is the whole point of motion mode, but only while the
   * clip has not spoken yet. Once it has, nothing moves it, and the audio
   * effect's dependencies stop changing.
   */
  const [greetStart, setGreetStart] = useState<{ anchor: number; atMs: number } | null>(null);
  useEffect(() => {
    if (postPlayedAtMs == null) {
      setGreetStart(null);
      return;
    }
    const computed = greetingStartMs({
      byMotion: greetingByMotion,
      postPlayedAtMs,
      arrivedAtMs,
      motionHealthy,
      fallbackMs: timing.fallbackMs,
    });
    if (computed == null) return;
    setGreetStart((cur) => {
      if (cur?.anchor !== postPlayedAtMs) return { anchor: postPlayedAtMs, atMs: computed };
      // Same return. Earlier is allowed until it has spoken; after that the
      // schedule is fixed for the rest of the window.
      if (playsRef.current?.count) return cur;
      return computed < cur.atMs ? { anchor: postPlayedAtMs, atMs: computed } : cur;
    });
  }, [postPlayedAtMs, arrivedAtMs, motionHealthy, greetingByMotion, timing.fallbackMs]);

  useEffect(() => {
    if (!audioUrl || !roomEmpty || proSilent || postPlayedAtMs == null) return;
    if (greetingWindowClosed(postPlayedAtMs, Date.now())) return;
    const startAtMs = greetStart?.anchor === postPlayedAtMs ? greetStart.atMs : null;
    if (startAtMs == null) return;

    if (playsRef.current?.anchor !== postPlayedAtMs) {
      playsRef.current = { anchor: postPlayedAtMs, count: 0 };
      setPlayCount(0);
    }
    const tally = playsRef.current;
    const el = new Audio(audioUrl);
    let timer: number | null = null;
    let stopped = false;
    const playOnce = () => {
      if (stopped || tally.count >= timing.maxPlays) return;
      if (greetingWindowClosed(postPlayedAtMs, Date.now())) return;
      tally.count++;
      setPlayCount(tally.count);
      void el.play().catch(() => {});
    };
    // The CHIP FOLLOWS THE ELEMENT, not the schedule — a refused autoplay must
    // read as silence on the wall, because that is what the room hears.
    el.onplaying = () => {
      if (!stopped) setAudible("greeting");
    };
    const quiet = () => {
      if (!stopped) setAudible((c) => (c === "greeting" ? null : c));
    };
    el.onpause = quiet;
    el.onerror = quiet;
    el.onended = () => {
      if (stopped) return;
      quiet();
      timer = window.setTimeout(playOnce, GREETING_GAP_MS);
    };
    // The arrival stamp normally reaches the TV a poll after the fact, so the
    // start moment is usually already behind us — play now. A future start
    // (the fixed timer, mostly) waits out the difference.
    timer = window.setTimeout(playOnce, Math.max(0, startAtMs - Date.now()));
    return () => {
      stopped = true;
      if (timer != null) window.clearTimeout(timer);
      releaseAudio(el);
      setAudible((c) => (c === "greeting" ? null : c));
    };
    // DELIBERATELY NOT `arrivedAtMs` / `motionHealthy` — they are folded into
    // the latched start above, and depending on them here is exactly what let a
    // motion stamp interrupt a playing clip.
  }, [audioUrl, roomEmpty, proSilent, postPlayedAtMs, greetStart, timing.maxPlays]);

  /**
   * THE LINGER NAG — "another group is waiting" — exactly once per return
   * (owner 2026-08-23). The server stamps `lingerAtMs` when the room camera
   * still sees movement LINGER_AFTER_MS after the group walked in; this plays
   * the clip once while that stamp is fresh. A stale stamp (a TV rebooting
   * minutes later) is history, not an instruction — LINGER_FRESH_MS guards
   * the replay, and the ref guards re-renders inside one mount. NOT
   * pro-gated: an over-staying Pro grid needs the nudge exactly as much —
   * what Pro skips is the greeting. No clip uploaded → lingering is simply
   * not narrated. Motion mode only by construction: the stamp requires an
   * arrival stamp, which the fixed-timer mode never writes.
   */
  const lingerPlayedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!lingerAudioUrl || !roomEmpty || lingerAtMs == null) return;
    if (Date.now() - lingerAtMs > LINGER_FRESH_MS) return;
    if (lingerPlayedRef.current === lingerAtMs) return;
    /**
     * NEVER OVER A CLIP ALREADY SOUNDING (owner 2026-08-24: "the motion will
     * interrupt an already playing announcement and it shouldn't").
     *
     * The linger nag is itself motion-triggered — the room still moving after
     * the group walked in — and its stamp regularly lands while the greeting is
     * still speaking, so two clips talked over each other in a small room. It
     * WAITS instead: returning without claiming `lingerPlayedRef` leaves the
     * nag owed, and `audible` is a dependency, so the moment the greeting falls
     * silent this effect runs again and speaks. The freshness check above is
     * what stops it waiting forever.
     */
    if (audible !== null) return;
    lingerPlayedRef.current = lingerAtMs;
    let stopped = false;
    const el = new Audio(lingerAudioUrl);
    el.onplaying = () => {
      if (!stopped) setAudible("reminder");
    };
    const quiet = () => {
      if (!stopped) setAudible((c) => (c === "reminder" ? null : c));
    };
    el.onended = quiet;
    el.onpause = quiet;
    el.onerror = quiet;
    void el.play().catch(() => {});
    return () => {
      stopped = true;
      releaseAudio(el);
      setAudible((c) => (c === "reminder" ? null : c));
    };
  }, [lingerAudioUrl, roomEmpty, lingerAtMs, audible]);

  return {
    playing: audible != null,
    clip: audible,
    plays: playCount,
    maxPlays: timing.maxPlays,
    // Named in priority order: a Pro grid is silent whether or not a clip is
    // uploaded, so "pro" is the honest reason to show.
    silentBecause: proSilent ? "pro" : audioUrl ? null : "no-clip",
  };
}

/**
 * THE AUDIO CHIP — what the speaker is doing, on the glass (owner 2026-08-23:
 * "add an audio playing message somewhere on the board just so we can visually
 * see it").
 *
 * Rides the eyebrow row, which is the one line on this board with room to
 * spare, so it costs the exit hero nothing. Three states, and the quiet ones
 * are deliberately dim: a staff member standing in a silent room needs to tell
 * "working as intended" (Pro, or no clip uploaded) from "the TV refused to
 * play it", and the chip is the only place that distinction exists. `tv-blink`
 * on the live state so it catches an eye from the doorway.
 */
function AudioChip({ state }: { state: GreetingAudioState }) {
  const live = state.playing;
  const label = live
    ? state.clip === "reminder"
      ? "Reminder playing"
      : `Greeting playing${state.maxPlays > 1 ? ` · ${state.plays} of ${state.maxPlays}` : ""}`
    : state.silentBecause === "pro"
      ? "Pro session · no greeting"
      : state.silentBecause === "no-clip"
        ? "No greeting clip uploaded"
        : "Greeting ready";
  const colour = live ? "#46d68c" : "rgba(245,236,238,0.45)";
  return (
    <span
      className={live ? "tv-blink" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        flexShrink: 0,
        padding: "6px 18px",
        borderRadius: 999,
        border: `2px solid ${withAlpha(colour, live ? 0.8 : 0.35)}`,
        background: "rgba(0, 4, 24, 0.6)",
        fontSize: 22,
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: colour,
      }}
    >
      {/* A speaker, drawn rather than an emoji (house rule) — with sound waves
          only while something is actually sounding. */}
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9 H8 L13 4.5 V19.5 L8 15 H4 Z" fill="currentColor" />
        {live && (
          <>
            <path
              d="M16 8.5 C17.6 10 17.6 14 16 15.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M19 6 C21.6 8.6 21.6 15.4 19 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
      {label}
    </span>
  );
}

function WelcomeBack({
  accent,
  room,
  info,
  roomEmpty,
  variant,
}: {
  accent: string;
  room: BriefingRoom;
  info: WelcomeBackInfo;
  /** The room's timeline reads idle — nobody is briefing or helmet-fitting in
   *  it. Gates the greeting AUDIO only; the board itself shows regardless. */
  roomEmpty: boolean;
  /** `exit` is the live board; `qualifiers` is the preserved 2026-08-11 layout,
   *  reachable only through the `briefing-return-quals` preview. */
  variant: "exit" | "qualifiers";
}) {
  // The audio lives on the WRAPPER, not a variant, so previewing the old
  // layout exercises the same sound path the wall uses — and both boards can
  // show the same chip.
  const audio = useWelcomeBackAudio(info, roomEmpty);
  return variant === "qualifiers" ? (
    <WelcomeBackQualifiers accent={accent} room={room} info={info} audio={audio} />
  ) : (
    <WelcomeBackExit accent={accent} room={room} info={info} audio={audio} />
  );
}

/* ── the exit board (live) ────────────────────────────────────────────── */

/** One line of the kit checklist — icon chip and instruction, sized to be read
 *  mid-walk from across the room. */
function ChecklistRow({
  accent,
  icon,
  text,
  sub,
  color,
}: {
  accent: string;
  icon: React.ReactNode;
  text: string;
  sub?: string;
  /** Overrides the row colour — the headsock line reads as good news. */
  color?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
      <span
        style={{
          flexShrink: 0,
          width: 78,
          height: 78,
          borderRadius: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0, 4, 24, 0.6)",
          border: `3px solid ${withAlpha(color ?? accent, 0.6)}`,
          color: color ?? "#fff",
        }}
      >
        {icon}
      </span>
      <span
        style={{
          fontSize: 40,
          fontWeight: 600,
          lineHeight: 1.15,
          minWidth: 0,
          color: color ?? "rgba(245,236,238,0.9)",
        }}
      >
        {text}
        {sub && (
          <span style={{ display: "block", fontSize: 26, color: "rgba(245,236,238,0.55)" }}>
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

/* Kit glyphs — hand-sized shapes, stroke-drawn so they read at 78px from
   across a room. currentColor throughout, so the row's colour choice is the
   only decision. */
const GLYPH_HELMET = (
  <svg width="52" height="48" viewBox="0 0 64 60" aria-hidden="true">
    <path
      d="M6 34 C6 15 20 4 32 4 C44 4 58 15 58 34 L58 46 C58 52 54 56 48 56 L16 56 C10 56 6 52 6 46 Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="4.5"
      strokeLinejoin="round"
    />
    <path d="M26 26 L58 26 L58 38 L34 38 C29 38 26 34 26 30 Z" fill="currentColor" opacity="0.85" />
  </svg>
);
const GLYPH_HEADSOCK = (
  <svg width="48" height="48" viewBox="0 0 64 60" aria-hidden="true">
    <path
      d="M32 4 C17 4 10 16 10 28 L10 44 C10 51 15 56 22 56 L42 56 C49 56 54 51 54 44 L54 28 C54 16 47 4 32 4 Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="4.5"
      strokeLinejoin="round"
    />
    <ellipse cx="32" cy="30" rx="11" ry="14" fill="currentColor" opacity="0.85" />
  </svg>
);
const GLYPH_CAMERA = (
  <svg width="52" height="52" viewBox="0 0 64 64" aria-hidden="true">
    <rect
      x="6"
      y="14"
      width="52"
      height="36"
      rx="8"
      fill="none"
      stroke="currentColor"
      strokeWidth="4.5"
    />
    <circle cx="40" cy="32" r="10" fill="none" stroke="currentColor" strokeWidth="4.5" />
    <circle cx="40" cy="32" r="3.5" fill="currentColor" />
    <rect x="13" y="22" width="12" height="6" rx="3" fill="currentColor" />
  </svg>
);
const GLYPH_LOCKER = (
  <svg width="50" height="50" viewBox="0 0 64 62" aria-hidden="true">
    <rect
      x="14"
      y="4"
      width="36"
      height="54"
      rx="4"
      fill="none"
      stroke="currentColor"
      strokeWidth="4.5"
    />
    <line x1="22" y1="14" x2="42" y2="14" stroke="currentColor" strokeWidth="4" />
    <line x1="22" y1="23" x2="42" y2="23" stroke="currentColor" strokeWidth="4" />
    <rect x="38" y="32" width="5" height="12" rx="2.5" fill="currentColor" />
  </svg>
);

/** The white door itself, with a breathing light spill — what the chevron run
 *  points at. Drawn light-on-dark so "white door" is literal on the wall. */
function ExitDoor() {
  return (
    <div style={{ position: "relative", display: "flex", flexShrink: 0 }}>
      <span
        aria-hidden
        className="tv-breathe"
        style={{
          position: "absolute",
          inset: "-28px -38px",
          borderRadius: "50%",
          background:
            "radial-gradient(50% 50% at 50% 55%, rgba(245,240,230,0.28), transparent 70%)",
        }}
      />
      {/* SIZED IN VIEWPORT HEIGHT, not pixels. The exit hero shares a flex band
          with the checklist, and that band shrinks whenever the boards below it
          grow — the racing-again panel is the one that does it. At 140x245 fixed
          the art outgrew the band, and a centred overflow rides BOTH ways: the
          Exit wordmark climbed into "Welcome back!" and "Through the white door"
          was clipped off the bottom (owner 2026-08-23). Height leads and the
          aspect ratio follows, so the door keeps its shape at any wall size. */}
      <svg
        viewBox="0 0 160 280"
        aria-hidden="true"
        style={{
          position: "relative",
          height: "min(245px, 26vh)",
          width: "auto",
          display: "block",
        }}
      >
        <rect
          x="10"
          y="6"
          width="140"
          height="268"
          rx="6"
          fill="none"
          stroke="rgba(245,236,238,0.5)"
          strokeWidth="7"
        />
        <rect x="24" y="18" width="112" height="256" rx="4" fill="#f3f0ea" />
        <rect
          x="38"
          y="36"
          width="84"
          height="92"
          rx="4"
          fill="none"
          stroke="#c9c3b4"
          strokeWidth="4"
        />
        <rect
          x="38"
          y="148"
          width="84"
          height="104"
          rx="4"
          fill="none"
          stroke="#c9c3b4"
          strokeWidth="4"
        />
        <circle cx="118" cy="140" r="8" fill="#8a8578" />
      </svg>
    </div>
  );
}

/** Four chevrons whose pulse travels toward the door — motion in the direction
 *  the feet should go. The wave classes live in tv.css (tv-exit-chev). */
function ChevronRun({ side }: { side: "left" | "right" }) {
  const chev = (delay: 0 | 1 | 2 | 3) => (
    <span
      key={delay}
      className={`tv-exit-chev${delay ? ` tv-exit-chev-d${delay}` : ""}`}
      style={{ display: "flex", transform: side === "left" ? "scaleX(-1)" : undefined }}
    >
      <svg width="58" height="106" viewBox="0 0 68 124" aria-hidden="true">
        <path
          d="M4 4 L64 62 L4 120"
          fill="none"
          stroke="#fff"
          strokeWidth="26"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
  // The wave always runs TOWARD the door: DOM order 0→3 pointing right, 3→0
  // mirrored — mirroring the glyphs without reversing the delays would run
  // the pulse AWAY from the door it points at.
  const order: Array<0 | 1 | 2 | 3> = side === "right" ? [0, 1, 2, 3] : [3, 2, 1, 0];
  return <div style={{ display: "flex", alignItems: "center", gap: 18 }}>{order.map(chev)}</div>;
}

function WelcomeBackExit({
  accent,
  room,
  info,
  audio,
}: {
  accent: string;
  room: BriefingRoom;
  info: WelcomeBackInfo;
  audio: GreetingAudioState;
}) {
  const side = EXIT_DOOR_SIDE[room];
  const checklist = (
    <div style={{ display: "grid", gap: 24, flex: "0 0 620px", minWidth: 0 }}>
      <ChecklistRow accent={accent} icon={GLYPH_HELMET} text="Helmet back on the shelves" />
      {/* Good news reads green — the one line that is theirs to keep (owner
          2026-08-23: "headsock is yours to keep"). */}
      <ChecklistRow
        accent={accent}
        icon={GLYPH_HEADSOCK}
        text="Headsock is yours to keep!"
        sub="Bring it back next visit"
        color="#46d68c"
      />
      <ChecklistRow accent={accent} icon={GLYPH_CAMERA} text="Cameras back to the attendant" />
      <ChecklistRow
        accent={accent}
        icon={GLYPH_LOCKER}
        text="Grab your belongings from the lockers"
      />
    </div>
  );
  /**
   * THE HERO MUST FIT THE BAND IT IS GIVEN. Every measurement here is capped
   * against viewport height for the reason in ExitDoor: the band this sits in
   * shrinks when the racing-again panel appears, and fixed pixels made the
   * wordmark collide with the headline while the caption fell off the bottom.
   * `minHeight: 0` is what lets a flex child actually shrink; the gap scales
   * too, or three tight elements read as one blob on a short wall.
   */
  const exitHero = (
    <div
      style={{
        flex: "1 1 auto",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "min(20px, 2vh)",
      }}
    >
      <div
        className="tv-display"
        style={{
          fontSize: "min(128px, 13vh)",
          lineHeight: 1,
          color: "#fff",
          textShadow: `0 0 70px ${withAlpha(accent, 0.6)}`,
        }}
      >
        Exit
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "min(30px, 3vw)", minHeight: 0 }}>
        {/* The door sits on the side it physically is; the chevrons run at it. */}
        {side === "left" && <ExitDoor />}
        <ChevronRun side={side} />
        {side === "right" && <ExitDoor />}
      </div>
      <div
        className="tv-eyebrow"
        style={{
          fontSize: "min(30px, 3.2vh)",
          color: "rgba(245,236,238,0.85)",
          letterSpacing: "0.24em",
          whiteSpace: "nowrap",
        }}
      >
        {side === "left" ? "← Through the white door" : "Through the white door →"}
      </div>
    </div>
  );

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
        }}
      />
      <div
        aria-hidden
        className="tv-breathe"
        style={{
          position: "absolute",
          inset: 0,
          // The wash leans toward the exit — the same cue as everything else
          // on the board.
          background: `radial-gradient(75% 65% at ${side === "right" ? "42%" : "58%"} 40%, ${withAlpha(accent, 0.38)}, transparent 74%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        {/* The eyebrow shares its row with the audio chip — the one line on
            this board with room to spare, so the readout costs the exit hero
            nothing and cannot collide with anything. */}
        <div style={{ display: "flex", alignItems: "center", gap: 26, flexShrink: 0, minWidth: 0 }}>
          <span className="tv-eyebrow" style={{ color: accent, fontSize: 38 }}>
            {ROOM_LABEL[room]}
            {info.heatNumber != null ? ` · Session ${info.heatNumber}` : ""}
          </span>
          <AudioChip state={audio} />
        </div>
        <div
          className="tv-display tv-rise"
          style={{ fontSize: 92, color: "#fff", lineHeight: 0.92, flexShrink: 0 }}
        >
          Welcome back!
        </div>

        {/* THE MIDDLE OWNS THE SLACK: checklist beside the exit hero, laid so
            the door end of the ROW is the door end of the ROOM. Everything
            above and below stays flexShrink: 0 for the reason every board on
            this scene does — only this band can shrink gracefully. */}
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            gap: 56,
            overflow: "hidden",
          }}
        >
          {side === "right" ? (
            <>
              {checklist}
              {exitHero}
            </>
          ) : (
            <>
              {exitHero}
              {checklist}
            </>
          )}
        </div>

        <p
          style={{
            fontSize: 40,
            color: "rgba(245,236,238,0.72)",
            margin: 0,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          Please head out quickly — the next group is on its way in.
        </p>

        {/* Anyone due straight back out STAYS — the one exception on the whole
            board, so it keeps its amber band (owner 2026-08-23: "still show
            anyone that is in a heat coming up that should stay"). */}
        {info.racingAgain.length > 0 && (
          <div style={{ flexShrink: 0, display: "flex", alignItems: "stretch" }}>
            <RacingAgainPanel groups={info.racingAgain} />
          </div>
        )}

        {/* Blinking on purpose (owner 2026-08-11) — and it earns its place on
            an exit board twice over: the scores it points at are OUTSIDE. */}
        <p
          className="tv-blink"
          style={{
            fontSize: 40,
            fontWeight: 600,
            color: "rgba(245,236,238,0.92)",
            margin: 0,
            flexShrink: 0,
          }}
        >
          Race scores are posted outside the briefing room, near check-in and Red Track.
        </p>
      </div>
    </div>
  );
}

/* ── the qualifiers board (PRESERVED, preview-only) ───────────────────── */

/**
 * The 2026-08-11 welcome-back layout — who qualified, who didn't, the time to
 * beat — retired from the wall on 2026-08-23 because groups stood reading it
 * instead of leaving, and PRESERVED per the owner: "save the qualifiers page
 * case we ever want it back." Reachable through the `briefing-return-quals`
 * preview; putting it back on the wall is one variant flip in the scene.
 * Everything below it (ResultsBoard, pillScale, NameColumn) exists for this
 * board.
 */
function WelcomeBackQualifiers({
  accent,
  room,
  info,
  audio,
}: {
  accent: string;
  room: BriefingRoom;
  info: WelcomeBackInfo;
  audio: GreetingAudioState;
}) {
  const target = nextLevelTarget(info.track, info.raceType);
  const results = info.results;
  // The name board only exists where qualification exists: no target (a Pro
  // grid — nothing above it) means no split to show, so the plain welcome
  // board renders instead. NO LAP TIMES on this screen either way (owner
  // 2026-08-11: "I don't want race times on here — who qualified and who
  // didn't"); times live on the score screens outside.
  const hasNames =
    target !== null &&
    results !== null &&
    results.levelledUp.length + results.keepPushing.length > 0;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
        }}
      />
      <div
        aria-hidden
        className="tv-breathe"
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 40%, ${withAlpha(accent, 0.4)}, transparent 74%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
          // With names the board owns the whole panel: header at the top, the
          // name area absorbing the slack, chip and scores anchored at the
          // bottom (owner 2026-08-11: "utilize full screen").
          justifyContent: hasNames ? "flex-start" : "center",
          gap: hasNames ? 30 : 26,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 26, flexShrink: 0, minWidth: 0 }}>
          <span className="tv-eyebrow" style={{ color: accent, fontSize: 40 }}>
            {ROOM_LABEL[room]}
            {info.heatNumber != null ? ` · Session ${info.heatNumber}` : ""}
          </span>
          <AudioChip state={audio} />
        </div>
        <div
          className="tv-display tv-rise"
          style={{ fontSize: hasNames ? 130 : 170, color: "#fff", lineHeight: 0.92, flexShrink: 0 }}
        >
          Welcome back!
        </div>

        {/* Kit return — the two things staff otherwise repeat to every group.
            One line when the name board needs the vertical room. */}
        {hasNames ? (
          <p style={{ fontSize: 46, color: "rgba(245,236,238,0.85)", margin: 0, flexShrink: 0 }}>
            Return helmets to the shelves — cameras go back to the attendant.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <p style={{ fontSize: 54, color: "rgba(245,236,238,0.85)", margin: 0 }}>
              Return helmets to the shelves.
            </p>
            <p style={{ fontSize: 54, color: "rgba(245,236,238,0.85)", margin: 0 }}>
              Cameras go back to the attendant.
            </p>
          </div>
        )}

        {hasNames && (
          /**
           * A FLOOR, NOT JUST A SHARE OF THE LEFTOVER.
           *
           * This was `flex: 1, minHeight: 0`, which is a share of whatever space
           * the fixed blocks above and below leave over — and `flex: 1` bases at
           * zero, so on a shorter viewport, a longer heading or one more line of
           * copy, the share can round to nothing. That was survivable while the
           * names simply overflowed; once the pill area clips (NameColumn), a
           * zero-height share renders the whole qualification board INVISIBLE
           * while the rest of the screen looks perfectly healthy.
           *
           * So the names get a guaranteed 200px and take the leftover on top.
           * If the screen is ever too short for that, the blocks below give up
           * their space instead — the right trade, because the chip and the
           * scores line repeat information staff already know, and the names are
           * the only thing on this board that cannot be got anywhere else.
           */
          <div style={{ flex: "1 1 auto", minHeight: 200, overflow: "hidden" }}>
            <ResultsBoard accent={accent} target={target!} results={results!} />
          </div>
        )}

        {/*
          flexShrink: 0 ON EVERY FIXED BLOCK, and this one is why.

          A flex item's BOX shrinks under pressure; the type inside it does not.
          With the column over-full, the qualifying chip's box was squeezed while
          its 92px number kept its size, so the number bled upward out of the box
          and printed over the name pills above it — the overlap the owner kept
          seeing even after the pills themselves were clipped (2026-08-14).

          Only the name area may shrink now. It is the one block that can do it
          gracefully: it clips (see NameColumn) rather than spilling.
        */}
        {/*
          THE CHIP AND THE RACING-AGAIN PANEL SHARE ONE ROW. The chip is inline
          and only ever filled the left half of its line, so the panel costs the
          board no vertical room at all and nothing above it moves — which is the
          whole reason it sits here rather than anywhere else (owner 2026-08-14:
          "on welcome back put right of qualification number").

          `alignItems: stretch` so the panel matches the chip's height whatever
          the chip is; `flexShrink: 0` on the row for the same reason every other
          fixed block has it (see the note above) — the 92px number must never be
          squeezed up out of its box.
        */}
        {(target || info.racingAgain.length > 0) && (
          <div style={{ flexShrink: 0, display: "flex", alignItems: "stretch", gap: 26 }}>
            {target && (
              <div style={{ flexShrink: 0 }}>
                <QualifyTarget accent={accent} target={target} />
              </div>
            )}
            <RacingAgainPanel groups={info.racingAgain} />
          </div>
        )}

        {/* Blinking on purpose (owner 2026-08-11: "blink the race-results line
            so they pay attention") — the one animated element on the board. */}
        <p
          className="tv-blink"
          style={{
            fontSize: hasNames ? 46 : 42,
            fontWeight: 600,
            color: "rgba(245,236,238,0.92)",
            margin: 0,
            flexShrink: 0,
          }}
        >
          Race scores are posted outside the briefing room, near check-in and Red Track.
        </p>
      </div>
    </div>
  );
}

/**
 * The name board: WHO QUALIFIED and WHO DIDN'T — names only, no lap times
 * (owner 2026-08-11: "I don't want race times on here"). The split is decided
 * server-side against the same qualify.ts cutoffs the level-up texts use; the
 * bestMs the payload carries is deliberately not rendered here.
 */
function ResultsBoard({
  accent,
  target,
  results,
}: {
  accent: string;
  target: { level: string; ms: number };
  results: {
    levelledUp: Array<{ name: string; bestMs: number }>;
    keepPushing: Array<{ name: string; bestMs: number | null }>;
  };
}) {
  // ONE scale for the whole board, from the taller column — see pillScale.
  const scale = pillScale(Math.max(results.levelledUp.length, results.keepPushing.length));
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 44,
        height: "100%",
        minHeight: 0,
      }}
    >
      {results.levelledUp.length > 0 ? (
        <NameColumn
          scale={scale}
          heading={`Qualified for ${target.level}`}
          headingColor="#46d68c"
          pillBorder="rgba(70, 214, 140, 0.65)"
          names={results.levelledUp.map((d) => d.name)}
        />
      ) : (
        <div
          style={{
            alignSelf: "start",
            padding: "22px 28px",
            borderRadius: 18,
            border: `2px solid ${withAlpha(accent, 0.5)}`,
            background: "rgba(0, 4, 24, 0.6)",
            fontSize: 38,
            color: "rgba(245,236,238,0.75)",
          }}
        >
          Nobody beat {formatLap(target.ms)} this race — the time to beat stands.
        </div>
      )}
      {results.keepPushing.length > 0 && (
        <NameColumn
          scale={scale}
          heading="Didn't qualify — next time!"
          headingColor="rgba(245,236,238,0.65)"
          pillBorder="rgba(245,236,238,0.25)"
          names={results.keepPushing.map((d) => d.name)}
        />
      )}
    </div>
  );
}

/**
 * HOW BIG A NAME PILL CAN BE, given how many have to fit.
 *
 * The board used ONE size for every group, which is fine for the four or five
 * racers it was designed against and breaks visibly past that: at 44px a column
 * of names wraps to more rows than the panel has room for, overflows its flex
 * box, and paints straight over the qualifying-time chip below it (owner
 * 2026-08-14, with a screenshot of exactly that — "you could have up to 14
 * racers qualify, needs to not overlap").
 *
 * A GF group is 14 and they can all qualify, so the size has to come down as
 * the count goes up. The steps are deliberately coarse: a continuous formula
 * would make every group's board a slightly different size, and the wall reads
 * better when a normal five-racer heat always looks the same.
 *
 * THE STEPS MOVED DOWN ONE (owner 2026-08-14, on a photo of Red session 38:
 * "the non qualified is screwed up still"). They were chosen against how many
 * names LOOK right, not against how much room the names area actually gets —
 * which is roughly 300px once the chip and the blinking scores line have taken
 * theirs. Four names at 44px needed more than that, so the last pill in the
 * taller column was being clipped away on a perfectly ordinary heat. Every
 * threshold now assumes the SMALLEST names area, not the emptiest board.
 *
 * Driven by the BIGGER of the two columns, because they share one height and it
 * is the taller one that decides whether anything overflows.
 */
function pillScale(count: number): {
  font: number;
  padY: number;
  padX: number;
  gap: number;
  maxWidth: number;
  heading: number;
} {
  if (count <= 2) return { font: 44, padY: 12, padX: 30, gap: 16, maxWidth: 700, heading: 32 };
  if (count <= 4) return { font: 36, padY: 10, padX: 24, gap: 13, maxWidth: 600, heading: 29 };
  if (count <= 6) return { font: 32, padY: 9, padX: 21, gap: 12, maxWidth: 520, heading: 27 };
  if (count <= 9) return { font: 28, padY: 8, padX: 18, gap: 11, maxWidth: 440, heading: 25 };
  if (count <= 12) return { font: 24, padY: 7, padX: 16, gap: 10, maxWidth: 380, heading: 23 };
  return { font: 21, padY: 6, padX: 14, gap: 9, maxWidth: 330, heading: 22 };
}

/** A heading and a wrap of name pills — scales from 2 racers to a full GF grid
 *  of 14 without the column outgrowing the panel the way timed rows did. */
function NameColumn({
  heading,
  headingColor,
  pillBorder,
  names,
  scale,
}: {
  heading: string;
  headingColor: string;
  pillBorder: string;
  names: string[];
  /** Shared by both columns so the two sides always match — a board with big
   *  pills on the left and small ones on the right reads as a bug. */
  scale: ReturnType<typeof pillScale>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 18,
        alignContent: "start",
        height: "100%",
        // Both are required for the clip below to work: a grid item defaults to
        // min-height:auto and would grow to fit its content rather than letting
        // the pill area scroll-clip inside it.
        minHeight: 0,
        gridTemplateRows: "auto minmax(0, 1fr)",
      }}
    >
      <span className="tv-eyebrow" style={{ fontSize: scale.heading, color: headingColor }}>
        {heading}
      </span>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: scale.gap,
          alignContent: "start",
          // THE BACKSTOP. Scaling should mean this never triggers, but a group
          // larger than any we have seen, or a set of unusually long names, must
          // lose a pill off the bottom rather than paint over the chip below —
          // an overlapping board is unreadable, a clipped one is merely short.
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {names.map((name) => (
          <span
            key={name}
            style={{
              padding: `${scale.padY}px ${scale.padX}px`,
              borderRadius: 999,
              border: `2px solid ${pillBorder}`,
              background: "rgba(0, 4, 24, 0.6)",
              fontSize: scale.font,
              color: "#fff",
              whiteSpace: "nowrap",
              maxWidth: scale.maxWidth,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── setup states ─────────────────────────────────────────────────────── */

function Unconfigured() {
  return (
    <Centered>
      <div style={{ textAlign: "center", display: "grid", gap: 18, justifyItems: "center" }}>
        <IconAlertTriangleFilled size={96} color="#f0b341" />
        <span className="tv-display" style={{ fontSize: 84, color: "#fff" }}>
          Briefing screen
        </span>
        <span style={{ fontSize: 40, color: "rgba(245,236,238,0.66)" }}>
          Pick Red or Blue for this screen on the Lobby TVs admin page.
        </span>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000418",
        padding: PAD_X,
      }}
    >
      {children}
    </div>
  );
}
