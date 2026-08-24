"use client";

/**
 * Race control — the briefing-room half of the check-in station's `?board=1`.
 *
 * EMBEDDED, NOT A PAGE. It renders inside CheckInClient, because the person who
 * checks racers in is the person who sends the heat to a briefing room (owner:
 * "this was supposed to be a dual board, where is all the check in stuff"). State
 * lives in useBriefingControl one level up, because the scan flash unmounts this
 * subtree for four seconds.
 *
 * IT IS A TIMING BOARD FIRST (owner 2026-08-11: "timing is important — checking in
 * for X minutes, how long the video has been running… delay on track time is
 * important"). So the layout is built around four numbers, each a labelled tile
 * with its unit:
 *
 *   CHECKING IN   how long since the heat was called
 *   TRACK DELAY   how far behind the track is running
 *   ELAPSED       how long the film has been playing
 *   LEFT          how long until the room's board changes
 *
 * Everything else is subordinate to those. An earlier pass made Send a full-width
 * saturated slab, which read as the most important thing on a board whose actual
 * job is telling staff where the time has gone ("feels busy and the button is
 * overwhelming"). Send is now a normal control at the end of its row; the room
 * colour is a thin spine and a small fill, never a wall of red.
 *
 * THREE BOXES PER ROOM, FIVE STAGES — Called, In the room, and Out of the room
 * (Holding · In karts · On track as three rows of one rail). That is what makes
 * the busy case legible: a second heat called mid-briefing is two boxes saying
 * two different things, rather than one box trying to be both. Sending into an
 * occupied room still works; it asks first.
 *
 * THE RAIL EXISTS BECAUSE THE COLUMN RAN OUT OF MONITOR. Adding In Karts as a
 * fifth panel would have been five lots of border, padding, label and badge for
 * three stages that are each one session, one clock and at most one press — in a
 * column that already needed `overflowY: auto` to survive the fourth. The goal is
 * every stage on one screen (owner 2026-08-14: "all states on one screen height
 * wise"), because a box below the fold cannot flash for attention, and flashing
 * for attention is the entire job of the Called deadline and the lane-held alarm.
 *
 * IN THE ROOM IS TWO COLUMNS — numbers and controls LEFT, camera RIGHT (owner
 * 2026-08-12: "better organize this screen with the session and timer stuff to
 * left of video preview"). Stacked, the camera's letterbox band sat exactly where
 * the readouts belonged and pushed Session / Elapsed / Left down the panel; side by
 * side, the two halves of the answer — what is running, and who is in there — read
 * in one look. It wraps back to stacked on a narrow desk monitor. The left
 * column's bottom rail — progress, its caption, Restart — is flush with the bottom
 * of the picture (owner: "so it looks even"), which is why the row sizes to the
 * picture and both camera overlays live inside the frame.
 *
 * "FREE" IS A CLAIM THIS BOARD HAS TO EARN (owner 2026-08-12: "Free might not be
 * right word here… warn that race is returning in X time based on the on track
 * timer. It can say free about 1 minute after race has finished"). An idle room is
 * not an empty room: the timeline ends a minute after the helmet board, while that
 * group is mid-race and due to walk back in with the kit. So an idle room counts
 * its own group back off the live on-track clock — BACK IN 4:12 → RETURNING NOW →
 * FREE — and only the last of those means "send the next group here". The rules,
 * the heat-number match that keeps two Mega rooms from both claiming one race, and
 * every bound live in briefing/room-return.ts (pure, tested).
 *
 * THE PREVIEW EXPANDS. A thumbnail tells you a room has filled; it does not tell
 * you whether the back row has helmets on. The preview (and its ⤢) opens ONE
 * full-screen viewer at 1600px that keeps ticking at ~1fps, flips between rooms,
 * and carries Start / Restart — so staff can watch the room and roll the film
 * without closing it. Esc or the backdrop closes it. While it is open the small
 * preview stops polling, so we never pull the same camera twice a second.
 *
 * TWO PHASES PER SEND. Send assigns the room and holds a "take a seat" board;
 * Start rolls the film, because a group still walking over would miss the opening.
 * Undo covers a mis-send, Restart covers latecomers.
 *
 * AND THE SECOND PHASE IS HELD FOR TEN SECONDS (owner 2026-08-12: "they are
 * hitting send to room then hit start video right after each other"). Two presses
 * a second apart collapse the walk the two phases exist for, and the film opens on
 * an empty room. Start counts the hold down on its own face — see
 * briefing/start-hold.ts for the rule and why it is desk-only.
 *
 * NUMBERS TICK LOCALLY. The board polls every 5 seconds, which would make a timer
 * visibly jump, so a 1s clock drives the readouts and the phase comes from
 * briefingTimelineAt — the SAME pure function the TV runs, so desk and wall agree.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconAlertTriangleFilled, IconCamera, IconMaximize, IconX } from "@tabler/icons-react";
import { useTrackStatus, type CurrentRace } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import { CALL_WINDOW_MIN, type NextCheckIn } from "~/features/racing/session-call";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { briefingTimelineAt, type BriefingTimeline } from "~/features/signage/briefing/phase";
import {
  resolveFilmTier,
  tierForRaceType,
  type BriefingPhase,
  type BriefingRoom,
  type BriefingRoomState,
} from "~/features/signage/briefing/types";
import {
  sendWindow,
  type PitPost,
  type SendWindow,
} from "~/features/signage/briefing/pull-to-room";
import { callAlarmCue, sendAlarmCue, type AlarmCue } from "~/features/signage/briefing/desk-alarm";
import { laneReturnRoom, suggestMegaRoom } from "~/features/signage/briefing/room-suggest";
import { trackDisplay, verdictLabel } from "~/features/racing/on-time-display";
import { liveHeatNumber } from "~/features/signage/briefing/room-return";
import {
  checkinAlert,
  waitingAlert,
  type AlertLevel,
} from "~/features/signage/briefing/desk-alerts";
import { startHoldRemainingMs, startHoldSeconds } from "~/features/signage/briefing/start-hold";
import { useCameraStill } from "~/features/signage/useCameraStill";
import {
  MOTION_RESOLUTION,
  VIEWER_RESOLUTION,
  parseCameraPreviewMode,
  type LiveResolution,
} from "~/features/signage/nx/camera-preview";
import {
  LIVE_RECYCLE_MS,
  teardownLiveVideoRef,
  useLiveCamera,
} from "~/features/signage/nx/useLiveCamera";
import { formatWaitMs } from "~/features/racing/wait-times";
import type {
  BoardStatus,
  BriefingControl,
  CameraTarget,
  RoomStatus,
  WaitTimesBoard,
} from "./useBriefingControl";
import type { PitLaneFeed } from "~/features/signage/pit/pit-board";
import OverridePanel from "./OverridePanel";
import {
  formatRemaining,
  useLiveSessionClock,
  type LiveSessionClock,
} from "~/features/signage/live-session";
import type { TrackKey } from "~/features/signage/track";

const ROOM_COLOR: Record<BriefingRoom, string> = { red: "#ff5a52", blue: "#4a9bff" };
const MEGA = "#a06bff";
const GREEN = "#4ade80";
const AMBER = "#f0b341";
/** Overdue. Distinct from ROOM_COLOR.red, which means "the Red room" — a warning
 *  must not be readable as a room's identity colour. Declared up here because
 *  STYLES interpolates it at module evaluation (a const below would be in its
 *  temporal dead zone). */
const DANGER = "#ff4d4f";
const INK = "#e8eef7";

/**
 * THE STAFF MEMO IS GONE (owner 2026-08-14) — it was added 2026-08-12 marked
 * "delete once the habit sticks", and it was the one line on this board that
 * said so about itself.
 *
 * It taught an order of operations: send the room BEFORE fetching the group from
 * check-in. The ten-second hold on Start (start-hold.ts) enforces the same thing
 * mechanically and stays, so the lesson survives the sentence. Two days of a
 * standing amber line above the Send button is what the habit got; a fifth stage
 * needed the height more.
 */

/**
 * ONE CAMERA WIDTH FOR EVERY BOX — and it is a WIDTH, not a share.
 *
 * The cameras used to be `flex: 1 1 300px`, so each one took whatever width its
 * row had spare. At 16:9 spare width IS height, and with three boxes stacked per
 * room (Called, In the room, Holding) the pictures pushed the bottom box off a
 * desk monitor (owner 2026-08-13: "let's go smaller on the camera, I want all
 * three boxes on the screen at one time — we might be going to 4 boxes").
 *
 * Fixed and shared, so the answer does not change when a box is added: four
 * boxes cost four of these, and the number is one edit. A preview only has to
 * answer "is anyone in there" — the ⤢ viewer is where anyone actually looks —
 * so 208px (117px tall) is the size that job needs, not the size the row had.
 */
const CAM_W = 208;

/**
 * WHICH ROOM THIS CALLED SESSION HAS ALREADY GONE TO, or null if it is still
 * waiting to be sent.
 *
 * THE MARKER DECIDES, THE ASSIGNMENT ROW ONLY NAMES THE ROOM. `assignments` is
 * an append-only record of what happened tonight — Undo cannot take a row back,
 * so deriving "already sent" from it meant an undone send never returned to the
 * Called box, and re-calling the heat did not help either because the row was
 * still there (owner 2026-08-13). `briefedSessions` is the reversible fact.
 *
 * The room still comes from the assignment when the marker does not carry one:
 * markers written before the room field existed are a bare timestamp, and a
 * board that could not name the room would rather say "the red room" from the
 * row than fall back to showing the heat as unsent.
 *
 * Falls back to the old assignment-only behaviour when `briefedSessions` is
 * absent entirely, which is a board still talking to a pre-fix deploy.
 */
function sentToFor(
  board: BoardStatus | null | undefined,
  race: CurrentRace | null,
): BriefingRoom | null {
  if (!race) return null;
  const sessionId = String(race.sessionId);
  const fromRow =
    board?.assignments.find((a) => a.mode === "timeline" && a.sessionId === sessionId)?.room ??
    null;
  const briefed = board?.briefedSessions;
  if (!briefed) return fromRow;
  const marker = briefed[sessionId];
  if (!marker) return null;
  return marker.room ?? fromRow;
}

/** Is this camera target a briefing room, rather than a holding view? Narrowing
 *  helper, so the phase/film half of the viewer only ever sees a real room. */
function isRoom(target: CameraTarget): target is BriefingRoom {
  return target === "red" || target === "blue";
}

/** Which track a holding view belongs to. */
function holdingTrack(target: Exclude<CameraTarget, BriefingRoom>): "red" | "blue" {
  return target === "holding-red" ? "red" : "blue";
}

/** The holding camera for a room's column. One per track, and the venue keeps
 *  the aim on an Nx layout of the same name — see nx/camera.server.ts. */
function holdingCameraFor(room: BriefingRoom): CameraTarget {
  return room === "red" ? "holding-red" : "holding-blue";
}

const PHASE_LABEL: Record<BriefingPhase, string> = {
  waiting: "Waiting to start",
  video: "Video playing",
  helmet: "Helmet sizes",
  idle: "Free",
};

const STYLES = `
.rcb {
  border: 1px solid transparent; cursor: pointer; font-weight: 650;
  transition: filter 120ms ease, transform 60ms ease, background 120ms ease;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  white-space: nowrap;
  position: relative;
}
/* THE DESK IS A TOUCH MONITOR (see the picker note below) and the small buttons
   — Undo, Restart — are ~27px tall against the 44px floor a finger needs. The
   hit area grows to the floor invisibly; the drawn button does not change, and
   a missed Undo stops landing on the live Start beside it (owner 2026-08-23).
   Vertical only: the buttons are already wide enough, and a horizontal bleed
   would overlap the neighbour in the same row. Disabled buttons swallow the
   press either way, exactly like the visible pixels do. */
.rcb::after {
  content: ""; position: absolute; left: 0; right: 0;
  top: 50%; transform: translateY(-50%);
  height: max(100%, 44px);
}
.rcb:hover:not(:disabled) { filter: brightness(1.15); }
.rcb:active:not(:disabled) { transform: translateY(1px); filter: brightness(0.93); }
.rcb:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
.rcb:disabled { opacity: 0.35; cursor: not-allowed; filter: none; }
.rcb[aria-busy="true"] { cursor: progress; }
/* A HELD BUTTON IS NOT AN UNAVAILABLE ONE. The generic disabled treatment fades a
   control out to say "this is not yours to press"; a Start counting itself down IS
   yours to press, in eight seconds, and the number on it is the whole point — so
   it keeps its colour and its weight and only loses a little saturation. */
.rcb-hold:disabled { opacity: 1; filter: saturate(0.5) brightness(0.88); cursor: wait; }
.rcb-spin {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: rcb-spin 650ms linear infinite;
}
@keyframes rcb-spin { to { transform: rotate(360deg); } }
.rc-num { font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }

/* THE PREVIEW MUST LOOK PRESSABLE STANDING STILL (owner 2026-08-12: "make sure it
   is shown that it can be clicked"). A hover-only affordance is invisible on a
   desk touch monitor, and a camera picture otherwise reads as a picture. So,
   unconditionally: a solid "CLICK TO ENLARGE" pill, a ring around the frame, and a
   zoom cursor. Hover and press only strengthen what is already there.
   Both overlays sit INSIDE the frame, never under it — the left column's bottom
   rail aligns to this frame, so anything below it would break that line. */
.rc-cam {
  position: relative; padding: 0; border: 0; background: none; display: block;
  width: 100%; cursor: zoom-in; text-align: left;
  transition: box-shadow 120ms ease, transform 60ms ease;
}
.rc-cam:focus-visible { outline: 2px solid ${INK}; outline-offset: 3px; }
/* A FRAME WEARS ITS CAMERA'S OWN SHAPE. 16/9 is only the default — the briefing
   rooms are 2592x1944 sensors (4:3, measured 2026-08-13), so forcing them into a
   16:9 box pillarboxed them and spent a third of the width on black (owner:
   "those briefing room cameras have a lot of black space on each side"). Callers
   override aspect-ratio inline; the dewarped holding view is genuinely 16:9
   (we ask the transcode for 1280x720) and takes the default.
   NOTE: this block is inside a template literal — no backticks in here. */
.rc-cam-shot {
  display: block; position: relative; width: 100%; aspect-ratio: 16 / 9;
  border-radius: 8px; overflow: hidden; background: #05070d;
  box-shadow: inset 0 0 0 1px rgba(232,238,247,0.16);
  transition: box-shadow 120ms ease, transform 60ms ease;
}
.rc-cam:hover .rc-cam-shot { box-shadow: inset 0 0 0 2px rgba(232,238,247,0.55); }
.rc-cam:active .rc-cam-shot { transform: translateY(1px); }
.rc-cam-chip {
  transition: background 120ms ease, color 120ms ease;
  background: rgba(8,12,20,0.86); color: ${INK};
}
.rc-cam:hover .rc-cam-chip { background: ${INK}; color: #0b1220; }
.rc-lb { animation: rc-fade 120ms ease-out; }
@keyframes rc-fade { from { opacity: 0; } to { opacity: 1; } }

/* OVERDUE BOXES FLASH (owner 2026-08-12). Animated declarations outrank inline
   styles in the cascade, which is what lets these own the border and ground of a
   Panel that sets both inline — no !important, no duplicated palette.
   ONE BOX AT A TIME, deliberately: the owner asked for "just that box", and a
   board where the whole screen pulses teaches staff to stop seeing it. 1.1s is
   slow enough to read the numbers through and fast enough to catch an eye
   crossing the room. */
.rc-flash-warn { animation: rc-flash-warn 1.1s ease-in-out infinite; }
@keyframes rc-flash-warn {
  0%, 100% { border-color: ${withAlpha(AMBER, 0.45)}; background-color: ${withAlpha(AMBER, 0.06)}; }
  50%      { border-color: ${AMBER};                   background-color: ${withAlpha(AMBER, 0.22)}; }
}
.rc-flash-late { animation: rc-flash-late 0.75s ease-in-out infinite; }
@keyframes rc-flash-late {
  0%, 100% { border-color: ${withAlpha(DANGER, 0.5)}; background-color: ${withAlpha(DANGER, 0.08)}; }
  50%      { border-color: ${DANGER};                 background-color: ${withAlpha(DANGER, 0.26)}; }
}
/* THE GOOD FLASH (owner 2026-08-13: "when everyone is checked in start flashing
   checkin section green"). Every other pulse on this board means something is
   late; this one means the grid is complete and the heat is ready to send, which
   is the moment staff are actually waiting for and the one they otherwise had to
   notice by reading a fraction. Slower than the warnings — 1.4s — because it is
   an invitation, not an alarm, and it must not read as another problem. */
.rc-flash-ready { animation: rc-flash-ready 1.4s ease-in-out infinite; }
@keyframes rc-flash-ready {
  0%, 100% { border-color: ${withAlpha(GREEN, 0.45)}; background-color: ${withAlpha(GREEN, 0.05)}; }
  50%      { border-color: ${GREEN};                  background-color: ${withAlpha(GREEN, 0.2)}; }
}
/* THE SEND BUTTON SHOUTS when the grid is complete and the window is open
   (owner 2026-08-23: "this needs to be more aggressive!"). Everything on the
   box says go — all here, window counting down — and a politely green button
   was still the quietest thing on it. The ring pulse is the board's loudest
   cue reserved for its one moment: press this, now. Amber variant for the
   window's last seconds. */
.rc-send-pulse { animation: rc-send-pulse 1.1s ease-in-out infinite; }
@keyframes rc-send-pulse {
  0%, 100% { box-shadow: 0 0 0 0 ${withAlpha(GREEN, 0)}; }
  50%      { box-shadow: 0 0 0 7px ${withAlpha(GREEN, 0.45)}; }
}
.rc-send-pulse-amber { animation: rc-send-pulse-amber 0.8s ease-in-out infinite; }
@keyframes rc-send-pulse-amber {
  0%, 100% { box-shadow: 0 0 0 0 ${withAlpha(AMBER, 0)}; }
  50%      { box-shadow: 0 0 0 7px ${withAlpha(AMBER, 0.55)}; }
}
/* THE GRACE MINUTE. Faster and red: the desk is out of time and the press is
   still theirs to make, which is the most urgent live button on the board. */
.rc-send-pulse-red { animation: rc-send-pulse-red 0.7s ease-in-out infinite; }
@keyframes rc-send-pulse-red {
  0%, 100% { box-shadow: 0 0 0 0 ${withAlpha(DANGER, 0)}; }
  50%      { box-shadow: 0 0 0 8px ${withAlpha(DANGER, 0.6)}; }
}
/* A staff alert must not be motion-only anyway: reduced motion keeps the colour
   and drops the pulse, so the box still reads as overdue. */
@media (prefers-reduced-motion: reduce) {
  .rc-flash-warn, .rc-flash-late, .rc-flash-ready { animation: none; }
  .rc-send-pulse { animation: none; box-shadow: 0 0 0 4px ${withAlpha(GREEN, 0.4)}; }
  .rc-send-pulse-amber { animation: none; box-shadow: 0 0 0 4px ${withAlpha(AMBER, 0.5)}; }
  .rc-send-pulse-red { animation: none; box-shadow: 0 0 0 5px ${withAlpha(DANGER, 0.6)}; }
  .rc-flash-warn { border-color: ${AMBER}; background-color: ${withAlpha(AMBER, 0.18)}; }
  .rc-flash-late { border-color: ${DANGER}; background-color: ${withAlpha(DANGER, 0.22)}; }
  .rc-flash-ready { border-color: ${GREEN}; background-color: ${withAlpha(GREEN, 0.16)}; }
}
`;

/** A stable no-op for a board with no speaker — a fresh arrow in the prop would
 *  re-run every column's alarm effect on every render. */
const noopCue = () => {};

/** A local 1-second clock, so every readout ticks between 5-second polls. */
function useNowMs(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}

/** A called heat's check-in progress, as the station polls it. */
export interface CheckinCount {
  track: string;
  sessionId: number | string;
  /**
   * NULL MEANS THE ROSTER READ DID NOT COME BACK — it does NOT mean the heat is
   * empty. Until 2026-08-18 a failed read arrived here as 0, and this box
   * printed "0/0 · 0 still to scan" over a full grid, then the true count on the
   * next poll, flipping on eight of ten polls. See features/racing/roster-count.ts.
   */
  checkedIn: number | null;
  total: number | null;
  /** The numbers are the last ones counted, not a fresh read. Shown dimmed. */
  stale?: boolean;
}

export default function RaceControlPanels({
  control,
  checkinCounts = [],
  scannerOffline = false,
  onAlarmCue,
}: {
  control: BriefingControl;
  /**
   * THE BOARD'S ONE SPEAKER, owned by the page (it holds the gear that switches
   * the alarm off). Every column reports its cue here every tick and the hook
   * plays each (kind, session, slot) exactly once — so two tracks closing in the
   * same second cannot talk over each other. Absent on a surface with no
   * speaker, which simply makes the board silent.
   */
  onAlarmCue?: (cue: AlarmCue | null) => void;
  /**
   * HOW MANY OF THE HEAT ARE THROUGH THE DESK, moved down here from the top of
   * the board (owner 2026-08-12: "in board mode move the number checked in down
   * to the check-in areas"). It belongs beside the heat it counts — the Called
   * box already names that session — and it frees the top strip for the wait
   * times. Empty on any surface that does not poll it, which simply hides it.
   */
  checkinCounts?: CheckinCount[];
  /**
   * THE STATION'S SCANNER IS DOWN — the top-strip warning already says so, but
   * the Called box still reads "8 still to scan" as though the number could
   * move. Threading the outage here lets the count name its own blocker:
   * global alarm, local consequence.
   */
  scannerOffline?: boolean;
}) {
  // 1s session-status cadence (owner 2026-08-14) — cacheOnly reads against
  // the warm-loop-fresh Redis carry, never live Pandora.
  const status = useTrackStatus(1_000);
  const nowMs = useNowMs();
  const { board, note, pending } = control;

  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;
  const rooms: BriefingRoom[] = ["red", "blue"];
  const noVideos = !!board && !board.videos.starter && !board.videos.intermediate;

  // ONE viewer for every camera, owned here rather than inside a panel — two
  // independent overlays could both be open, stacked on each other, each pulling
  // its own 1600px frame every second.
  const expanded = control.expandedCamera;
  /**
   * MAY THE CAMERA SURFACES PLAY VIDEO? The desk-wide setting, chosen once in
   * the settings sheet and read here so every station agrees within one 5s poll.
   *
   * IT GOVERNS THE VIEWER TOO, not just the tiles. The reason staff reach for
   * "Stills" is that the Nx server has gone slow, and the full-screen viewer is
   * the single most expensive thing on this page when it is open (~590 KB/s and
   * a 1080p transcode). A setting that relieved the NVR of four small streams
   * and then let one big one through would not do what its copy promises.
   *
   * Undefined — a station on an older deploy, or Redis never written — reads as
   * live, matching the server's own default.
   */
  const liveCameras = parseCameraPreviewMode(board?.cameraPreview?.mode) === "live";
  // Only a ROOM has a briefing timeline; a holding view has no film and no
  // phase, so the viewer gets null and renders its holding half instead.
  const expandedStatus = expanded ? (board?.rooms.find((r) => r.room === expanded) ?? null) : null;

  /**
   * WHICH HOLDING PEN THE UNIFIED MEGA ROW WATCHES.
   *
   * On a Mega day the lane renders ONCE, full width, below both columns
   * (owner 2026-08-17: "unify the whole bottom part — remove the divider and
   * fill the whole bottom") — so this no longer picks a column, it picks the
   * holding CAMERA: the pen of the room the current holding group was briefed
   * in (the record carries it); with nobody in holding it falls to Red so the
   * preview still has a home.
   */
  const megaLaneOwner: BriefingRoom = board?.lanes?.mega?.holding?.room ?? "red";

  /**
   * WHICH ROOM THE NEXT MEGA SEND SHOULD GO TO — a suggestion, never a rule
   * (owner 2026-08-16: auto-suggest, staff confirms; the press stays the
   * assignment and the other button always works).
   *
   * The leapfrog itself is briefing/room-suggest.ts, pure and tested, so the
   * chip and the late-send warning below cannot end up naming the same room —
   * they are the same fact from two sides, and the night they disagreed the
   * desk suggested the very room a race was walking back into.
   */
  const suggestedRoom: BriefingRoom | null = megaEnabled
    ? suggestMegaRoom({
        // The phase test stays here — it is the board's own read of the room
        // states; the leapfrog itself is the rule, and it lives in the module.
        free: rooms.filter(
          (room) =>
            briefingTimelineAt(board?.rooms.find((r) => r.room === room)?.state ?? null, nowMs)
              .phase === "idle",
        ),
        lane: board?.lanes?.mega ?? null,
      })
    : null;

  return (
    <section
      className="flex flex-col border-t"
      style={{
        borderColor: PORTAL_DARK.border,
        flex: 1,
        minHeight: 0,
        padding: "14px 20px 16px",
      }}
      aria-label="Race control"
    >
      <style>{STYLES}</style>

      {/* THE SECTION LABEL IS GONE, THE ROW IS NOT. "Briefing rooms" named a
          section whose two columns already say RED ROOM and BLUE ROOM directly
          underneath, one line below a page titled "Check-In & Race Control" — a
          third naming of the same thing, costing a band of column height that a
          fifth stage now needs.
          The row itself stays, at a FIXED height, because it carries the Mega
          chip and the transient action note. Rendering it only when one of those
          exists would shift the whole board down every time a note appeared. */}
      <header
        className="flex items-center gap-3"
        style={{ flexWrap: "wrap", flexShrink: 0, marginBottom: 6, minHeight: 18 }}
      >
        {megaEnabled && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              padding: "2px 9px",
              borderRadius: 4,
              background: withAlpha(MEGA, 0.2),
              border: `1px solid ${withAlpha(MEGA, 0.5)}`,
              color: MEGA,
              letterSpacing: "0.06em",
            }}
          >
            MEGA DAY
          </span>
        )}
        {note && (
          <span
            role="status"
            style={{
              marginLeft: "auto",
              fontSize: 12,
              color: note.startsWith("✕") ? AMBER : GREEN,
            }}
          >
            {note}
          </span>
        )}
      </header>

      {(board?.enabled === false || noVideos) && (
        <div style={{ display: "grid", gap: 6, marginBottom: 10, flexShrink: 0 }}>
          {board?.enabled === false && (
            <Note>Briefing rooms are switched off — sends are refused.</Note>
          )}
          {noVideos && (
            <Note>
              No briefing videos uploaded — rooms show helmet sizes. Add them on the Lobby TVs page.
            </Note>
          )}
        </div>
      )}

      {/* THE PIT LANE USED TO BE A STRIP ACROSS THE TOP — a "Pit lane" label and
          a "race returned" button per track, sitting above the room columns and
          belonging to neither (removed 2026-08-13). It was the whole pit lane
          reduced to the one press staff had to make, with nothing on screen
          saying WHO was in holding or why the lane was held.

          It is now a row inside each room column's third box — Called, In the
          room, Out of the room — so the board carries the whole journey a group
          takes and the press sits with the group it is about. See
          OutOfRoomPanel. */}
      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(auto-fit,minmax(430px,1fr))",
          alignItems: "stretch",
          // On a Mega day the unified lane row sits BELOW this grid, so the
          // grid sizes to its content and the slack collects under the row
          // instead of between the columns and the lane. Split nights keep
          // the columns owning the full height, exactly as before.
          ...(megaEnabled ? {} : { flex: 1 }),
          minHeight: 0,
        }}
      >
        {rooms.map((room) => {
          const track = megaEnabled ? "mega" : room;
          const race =
            (megaEnabled ? status?.currentRaces?.mega : status?.currentRaces?.[room]) ?? null;
          return (
            <RoomColumn
              key={room}
              room={room}
              track={track}
              race={race}
              onTime={status?.onTime ?? null}
              // Read-only: which session BMI still owes a call for on this track.
              nextCall={status?.nextCheckIn?.[track] ?? null}
              onAlarmCue={onAlarmCue ?? noopCue}
              status={board?.rooms.find((r) => r.room === room) ?? null}
              proFilmMissing={!board?.videos.pro}
              // The uploaded films, so the late-send warning can quote the length
              // of the one this heat will actually get rather than an average.
              videos={board?.videos ?? null}
              // Once a session has gone to EITHER room it leaves the Called boxes
              // (owner 2026-08-11: "once a session is moved to the room it should
              // clear from these top boxes"). It is no longer waiting to be sent, so
              // leaving it there only invites sending it twice.
              //
              // READ FROM THE BRIEFED MARKER, NOT THE ASSIGNMENT LOG. Assignments
              // are an append-only record of what happened, so Undo could not take
              // one back and the heat never returned to Called (owner 2026-08-13).
              // The marker is the reversible fact: written on send, deleted by
              // Undo, and left standing by "send to holding" so a briefed group on
              // its way to the seats does not reappear at the desk. The assignment
              // row is still consulted for WHICH room, since the oldest markers
              // predate that field.
              sentTo={sentToFor(board, race)}
              nowMs={nowMs}
              // Matched on SESSION, never on track: two tracks can have a heat
              // called at once, and a count against the wrong group is worse
              // than no count at all.
              checkedIn={
                checkinCounts.find(
                  (c) => !!race && String(c.sessionId) === String(race.sessionId),
                ) ?? null
              }
              scannerOffline={scannerOffline}
              // 0 until the first poll lands — checkinAlert reads that as "no
              // deadline known", so a board still connecting never flashes at a
              // window it is guessing at.
              checkinWindowMins={board?.checkinWindowMins?.[track] ?? 0}
              locked={board?.enabled === false}
              pending={pending}
              expandedCamera={expanded}
              onExpandCamera={(target) => control.setExpandedCamera(target)}
              getLiveUrl={control.liveCameraUrl}
              liveCameras={liveCameras}
              lane={board?.lanes?.[track as "blue" | "red" | "mega"] ?? null}
              // On a Mega day NO column owns the lane — it renders once,
              // full width, below both columns (MegaLaneRow).
              ownsLane={!megaEnabled}
              suggested={suggestedRoom === room}
              onRaceReturned={() => control.markPitted(track)}
              hasLaunched={control.hasLaunched}
              noteLaunched={control.noteLaunched}
              onSend={() =>
                control.send({
                  room,
                  track,
                  sessionId: String(race?.sessionId ?? ""),
                  heatNumber: race?.heatNumber ?? null,
                  raceType: race?.raceType ?? null,
                })
              }
              onStart={(restart) => control.start(room, { restart })}
              onUndo={() => control.clearRoom(room)}
              // Built from the ROOM's own state, never from `race`: by the time
              // a group leaves for the seats, the track's called record can
              // already have rolled to the next heat, and sending THAT session
              // to holding would seat the wrong group.
              onSendHolding={() => {
                const st = board?.rooms.find((r) => r.room === room)?.state;
                if (!st?.sessionId) return;
                control.sendToHolding({
                  room,
                  track: st.track ?? track,
                  sessionId: st.sessionId,
                  heatNumber: st.heatNumber ?? null,
                  raceType: st.raceType ?? null,
                });
              }}
            />
          );
        })}
      </div>

      {/* THE UNIFIED BOTTOM — Mega only. Everything after the briefing is one
          single-file lane, so it renders once, full width, directly under both
          columns. A SIBLING of the grid, never a grid item: a spanning item
          stops auto-fit collapsing its empty tracks, which squeezed the two
          columns into half the board (owner screenshot, 2026-08-17). */}
      {megaEnabled && (
        <div style={{ marginTop: 14, flexShrink: 0 }}>
          <MegaLaneRow
            room={megaLaneOwner}
            lane={board?.lanes?.mega ?? null}
            nowMs={nowMs}
            locked={board?.enabled === false}
            pending={pending}
            cameraExpanded={expanded === holdingCameraFor(megaLaneOwner)}
            onExpandCamera={() => control.setExpandedCamera(holdingCameraFor(megaLaneOwner))}
            getLiveUrl={control.liveCameraUrl}
            liveCameras={liveCameras}
            onRaceReturned={() => control.markPitted("mega")}
            hasLaunched={control.hasLaunched}
            noteLaunched={control.noteLaunched}
          />
        </div>
      )}

      {/* TODAY'S BRIEFING LOG — the durable record, one button away.

          Shown because a record nobody can see is a record nobody notices has
          stopped being written: this list is the daily proof the insurance data
          is landing. It reads the Neon event log (owner 2026-08-12: "for
          insurance purposes, record when each session is briefed and the time
          they're in the room"), so each line carries what was actually recorded —
          in at, the film, whether it finished, the briefing photo, and how long
          the room was theirs. It lived along the bottom of the board as a
          details strip; it is a thing staff READ, not watch, so it is now a
          panel (owner 2026-08-13). */}
      {control.openPanel === "log" && (
        <BoardModal
          title="Briefing log"
          subtitle={`Today · ${board?.briefings.length ?? 0} briefings${
            board?.businessDay ? ` · ${board.businessDay}` : ""
          }`}
          onClose={() => control.setOpenPanel(null)}
        >
          <div style={{ marginTop: 6, display: "grid", gap: 2 }}>
            <div
              style={{
                display: "flex",
                gap: 10,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.08em",
                color: PORTAL_DARK.muted,
                textTransform: "uppercase",
              }}
            >
              <span style={{ minWidth: 38 }}>Room</span>
              <span style={{ minWidth: 88 }}>Session</span>
              <span style={{ minWidth: 96 }}>Film</span>
              <span style={{ minWidth: 76 }}>In at</span>
              <span style={{ minWidth: 76 }}>Started</span>
              <span style={{ minWidth: 104 }}>Briefing photo</span>
              {/* THE TWO ANNOUNCEMENTS (owner 2026-08-14: "in briefing log
                  monitor pre and post for each session with time stamp"). Both
                  already rode the insurance log; nothing read them back, so the
                  record of whether a group was actually called to their karts —
                  and actually called back in — was invisible to the desk. */}
              <span style={{ minWidth: 72 }}>Pre-race</span>
              <span style={{ minWidth: 72 }}>Post-race</span>
              {/* THE LEGS (owner 2026-08-14: "keep track of all the time
                  movements and how long"). The log always knew every instant;
                  what it never did was subtract them, so reading a slow night
                  meant doing arithmetic across five columns by eye. */}
              <span style={{ minWidth: 66 }}>Waited</span>
              <span style={{ minWidth: 66 }}>To start</span>
              <span style={{ minWidth: 66 }}>In room</span>
              <span style={{ minWidth: 66 }}>On track</span>
              <span style={{ marginLeft: "auto" }}>Total</span>
            </div>
            {board?.briefings.slice(0, 12).map((b) => (
              <div
                key={`${b.room}:${b.sessionId}`}
                className="rc-num"
                style={{ display: "flex", gap: 10, fontSize: 11, color: PORTAL_DARK.muted }}
              >
                <span style={{ color: ROOM_COLOR[b.room], fontWeight: 800, minWidth: 38 }}>
                  {b.room.toUpperCase()}
                </span>
                <span style={{ minWidth: 88, color: INK }}>
                  {b.heatNumber != null ? `Session ${b.heatNumber}` : "—"}
                </span>
                {/* The film question, answered per group: which tier, and did it
                    run to the end. "Never started" is the line a claim turns on,
                    so it is amber rather than another grey cell. */}
                <span
                  style={{
                    minWidth: 96,
                    color: b.startedAtMs == null ? AMBER : b.filmCompleted ? GREEN : AMBER,
                  }}
                >
                  {b.startedAtMs == null
                    ? "never started"
                    : `${b.tier ?? "film"}${b.filmCompleted ? " ✓" : " · cut off"}`}
                  {b.restarts > 0 ? ` ·${b.restarts + 1}×` : ""}
                </span>
                <span style={{ minWidth: 76 }}>{clockTimeMs(b.sentAtMs)}</span>
                <span style={{ minWidth: 76 }}>
                  {b.startedAtMs != null ? clockTimeMs(b.startedAtMs) : "—"}
                </span>
                {/* THE PICTURE, AND WHEN IT WAS TAKEN (owner 2026-08-12: "you can
                    say screenshot and timestamp of room saved for insurance on the
                    check-in board so they know"). The time is the point — it is
                    what makes the row a record rather than a claim — and it opens
                    the still, because the first thing anyone asks of a photo is to
                    see it. Staff-only surface: /admin is token-gated. */}
                <span style={{ minWidth: 104 }}>
                  {b.photoUrl ? (
                    <a
                      href={b.photoUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        color: GREEN,
                        textDecoration: "none",
                      }}
                      title="Briefing photo saved for insurance — opens the still"
                    >
                      <IconCamera size={12} aria-hidden />
                      {clockTimeMs(b.photoAtMs ?? b.startedAtMs ?? b.sentAtMs)}
                    </a>
                  ) : b.startedAtMs != null ? (
                    <span style={{ color: AMBER }}>no photo</span>
                  ) : (
                    "—"
                  )}
                </span>
                {/* A cue that never sounded is amber, not blank: on this row a
                    dash reads as "nothing to say", and the whole point of these
                    two columns is that silence is the thing worth seeing. Pre is
                    only owed once a group has left the room; post only once they
                    have been out. */}
                <Cue atMs={b.preAtMs} owed={b.endedAtMs != null} />
                <Cue atMs={b.postAtMs} owed={b.pittedAtMs != null || b.postAtMs != null} />
                <Leg ms={b.waitToRoomMs} />
                <Leg ms={b.toStartMs} />
                <Leg ms={b.inRoomMs} pending={b.inRoomMs == null ? "in there" : undefined} />
                <Leg ms={b.roomToPittedMs} />
                {/* The figure a guest would give you, and the only one that is
                    bold: every other column is a leg of it. */}
                <span
                  className="rc-num"
                  style={{ marginLeft: "auto", color: INK, fontWeight: 800 }}
                >
                  {b.totalMs != null ? formatClock(b.totalMs) : "—"}
                </span>
              </div>
            ))}
          </div>
        </BoardModal>
      )}

      {/* OVERRIDE — the manual placement modal. See OverridePanel: it is a live
          view of every lane slot first, and a set of corrections second. */}
      {control.openPanel === "override" && (
        <BoardModal
          title="Override"
          subtitle="Where every session is right now — and how to move one by hand"
          onClose={() => control.setOpenPanel(null)}
        >
          <OverridePanel control={control} megaEnabled={megaEnabled} status={status} />
        </BoardModal>
      )}

      {control.openPanel === "waits" && (
        <BoardModal
          title="Wait times"
          subtitle="Last hour against today and the last seven days, per track"
          onClose={() => control.setOpenPanel(null)}
        >
          <WaitTimesRail waitTimes={control.waitTimes} waitTimesWeek={control.waitTimesWeek} />
        </BoardModal>
      )}

      {expanded && (
        <CameraLightbox
          target={expanded}
          track={megaEnabled ? "mega" : isRoom(expanded) ? expanded : holdingTrack(expanded)}
          state={expandedStatus?.state ?? null}
          holding={
            isRoom(expanded)
              ? null
              : (board?.lanes?.[megaEnabled ? "mega" : holdingTrack(expanded)]?.holding ?? null)
          }
          nowMs={nowMs}
          locked={board?.enabled === false}
          pending={pending}
          onStart={(restart) => isRoom(expanded) && control.start(expanded, { restart })}
          onSwitch={(next) => control.setExpandedCamera(next)}
          onClose={() => control.setExpandedCamera(null)}
          getLiveUrl={control.liveCameraUrl}
          liveCameras={liveCameras}
        />
      )}
    </section>
  );
}

/* ── today's wait times, per track ─────────────────────────────────────── */
/**
 * A REFERENCE PANEL OVER THE BOARD — wait times, today's log.
 *
 * Both used to sit ON the board: the metrics as a rail across the top, the log as
 * a details strip along the bottom. Neither is an ACTION, and neither is watched —
 * they are things a staff member opens, reads, and dismisses, maybe twice a shift.
 * Board furniture that earns its space is furniture you look at constantly, and
 * these were taking permanent room from the rooms and clocks that are the job
 * (owner 2026-08-13: "move stats to a button, move briefing log to a button as
 * well with modal").
 *
 * Same dialog mechanics as the camera viewer, deliberately: ONE backdrop button
 * behind the content rather than a click handler on a non-interactive div, so it
 * answers Enter/Space for free, no keyboard is stranded, and the children have
 * nothing to guard against. Esc closes, and focus lands on Close when it opens.
 */
function BoardModal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="rc-lb"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title.toLowerCase()}`}
        style={{
          position: "absolute",
          inset: 0,
          border: 0,
          background: "rgba(3,6,12,0.86)",
          cursor: "default",
        }}
      />
      <div
        style={{
          position: "relative",
          width: "min(1180px, 100%)",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          background: PORTAL_DARK.card,
          border: `1px solid ${PORTAL_DARK.border}`,
          borderRadius: 10,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 12,
            padding: "14px 18px",
            borderBottom: `1px solid ${PORTAL_DARK.border}`,
            flexShrink: 0,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: INK,
            }}
          >
            {title}
          </h3>
          {subtitle && <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{subtitle}</span>}
          <button
            ref={closeRef}
            type="button"
            className="rcb"
            onClick={onClose}
            title="Close (Esc)"
            style={{
              marginLeft: "auto",
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 12,
              borderColor: PORTAL_DARK.border,
              background: "transparent",
              color: PORTAL_DARK.fg,
            }}
          >
            <IconX size={14} stroke={2.4} />
            Close
          </button>
        </div>
        {/* The body scrolls, never the page behind it — a log of fifty heats must
            not push the dialog off a desk monitor. */}
        <div style={{ overflowY: "auto", padding: "14px 18px 18px", minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
}

/**
 * TODAY'S WAIT TIMES — a small matrix per track, above that track's own room.
 *
 * WHAT THE DESK ACTUALLY ASKS is not "what is our average", it is "are we running
 * behind right now" (owner 2026-08-13: "I think you need day and last hour so we
 * know if we're calling behind"). A night's median is the very thing that hides a
 * shift going wrong at 9pm — twenty good heats bury three bad ones — so the LAST
 * HOUR is the number in large type, and the day and the week sit under it as the
 * baselines it is read against.
 *
 * A MATRIX, NOT A ROW OF CHIPS. Periods down the side, measures across the top:
 * every number shares a column with the one above it, so "behind" is a comparison
 * the eye makes for free rather than one an arrow has to assert. That also
 * retired the trend chips, the repeated track labels and the "TODAY · MEDIAN"
 * filler the earlier passes spent width on.
 *
 * ALIGNED TO ITS OWN ROOM. Same grid template as the room columns below, so the
 * red matrix sits directly over RED ROOM and the blue over BLUE ROOM, with the
 * spine colour carrying down the page. The previous cut floated these in the page
 * header, where red's numbers sat above the middle of the board and belonged to
 * nothing — which is exactly why it read as clutter.
 */
export function WaitTimesRail({
  waitTimes,
  waitTimesWeek,
}: {
  waitTimes: WaitTimesBoard | null;
  waitTimesWeek: WaitTimesBoard | null;
}) {
  /**
   * WHICH TRACKS TO SHOW, read off the data rather than passed in — a Mega day is
   * one circuit both rooms serve, so its heats arrive under `mega`, and red +
   * blue would be two columns of nothing beside one of everything. Before the
   * night's first heat there is nothing to read, so it falls back to red + blue:
   * a rail that fills itself in rather than one that appears mid-shift.
   */
  const ALL: Array<{ key: string; color: string }> = [
    { key: "red", color: ROOM_COLOR.red },
    { key: "blue", color: ROOM_COLOR.blue },
    { key: "mega", color: MEGA },
  ];
  const ran = ALL.filter((t) => (waitTimes?.byTrack?.[t.key]?.roomToRaceMs?.n ?? 0) > 0);
  const tracks = ran.length > 0 ? ran : ALL.slice(0, 2);

  return (
    <div
      style={{
        display: "grid",
        gap: 14,
        // The room grid's own template — so each matrix lands over its room.
        gridTemplateColumns: "repeat(auto-fit,minmax(430px,1fr))",
        flexShrink: 0,
        marginBottom: 12,
      }}
    >
      {tracks.map(({ key, color }) => (
        <TrackWaitMatrix
          key={key}
          color={color}
          hour={waitTimes?.lastHourByTrack?.[key]}
          today={waitTimes?.byTrack?.[key]}
          week={waitTimesWeek?.byTrack?.[key]}
        />
      ))}
    </div>
  );
}

type WaitStat = { n: number; medianMs: number | null } | undefined;
type TrackStats = Record<string, { n: number; medianMs: number | null }> | undefined;

/** How far the last hour must drift from the day before the board says so. */
const BEHIND_MS = 30_000;

/**
 * IS THE LAST HOUR MEANINGFULLY BEHIND TODAY, anywhere — the matrix's own
 * BEHIND_MS verdict, summarised for the button that hides it. Since the
 * metrics moved behind "Wait times" (owner 2026-08-13) the answer only existed
 * once the modal was open; an amber dot on the button surfaces it without
 * un-making that decision (owner 2026-08-23). Slower only: a fast hour is
 * good news, and good news does not need a dot.
 *
 * Reads exactly the two metrics the matrix's lead row colours, so the dot can
 * never claim something the opened panel does not show.
 */
export function waitTimesBehind(waitTimes: WaitTimesBoard | null): boolean {
  if (!waitTimes?.lastHourByTrack) return false;
  for (const [track, hour] of Object.entries(waitTimes.lastHourByTrack)) {
    const today = waitTimes.byTrack?.[track];
    if (!today) continue;
    for (const metric of ["roomToRaceMs", "calledToRaceEndMs"] as const) {
      const now = hour[metric]?.medianMs;
      const base = today[metric]?.medianMs;
      if (now != null && base != null && now - base >= BEHIND_MS) return true;
    }
  }
  return false;
}

function TrackWaitMatrix({
  color,
  hour,
  today,
  week,
}: {
  color: string;
  hour: TrackStats;
  today: TrackStats;
  week: TrackStats;
}) {
  const rows: Array<{ label: string; stats: TrackStats; lead: boolean }> = [
    { label: "Last hour", stats: hour, lead: true },
    { label: "Today", stats: today, lead: false },
    { label: "Last 7 days", stats: week, lead: false },
  ];

  return (
    <div
      style={{
        background: PORTAL_DARK.card,
        border: `1px solid ${PORTAL_DARK.border}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        padding: "8px 14px 10px",
        display: "grid",
        gridTemplateColumns: "auto 1fr 1fr",
        columnGap: 18,
        rowGap: 1,
        alignItems: "baseline",
      }}
    >
      <span />
      <ColumnHead>Room → race</ColumnHead>
      <ColumnHead>Total experience</ColumnHead>

      {rows.map(({ label, stats, lead }) => (
        <Fragment key={label}>
          <span
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: lead ? INK : PORTAL_DARK.muted,
              whiteSpace: "nowrap",
              paddingRight: 4,
            }}
          >
            {label}
            {stats?.roomToRaceMs?.n ? (
              <span style={{ color: PORTAL_DARK.muted, fontWeight: 700 }}>
                {" · "}
                {stats.roomToRaceMs.n}
              </span>
            ) : null}
          </span>
          <WaitValue
            stat={stats?.roomToRaceMs}
            against={lead ? today?.roomToRaceMs : undefined}
            lead={lead}
          />
          <WaitValue
            stat={stats?.calledToRaceEndMs}
            against={lead ? today?.calledToRaceEndMs : undefined}
            lead={lead}
          />
        </Fragment>
      ))}
    </div>
  );
}

function ColumnHead({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: "0.10em",
        textTransform: "uppercase",
        color: PORTAL_DARK.muted,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/**
 * One number in the matrix.
 *
 * The LAST HOUR row is the live one, so it is the only row that carries colour,
 * and it earns it by comparison with today's median: meaningfully slower is AMBER
 * — that is "we are calling behind" — and meaningfully faster is green. Under
 * half a minute either way is noise over a night's waits and stays plain, because
 * a board that changes colour on eight seconds teaches staff to ignore colour.
 *
 * NEVER RED: red here means a deadline has been missed (an overdue room, a blown
 * check-in window), and spending it on a slow stretch blunts the real alarm.
 *
 * An unknown value is a THIN dash — the fat 800-weight em-dash the first cut used
 * read as a broken loading bar, which is worse than saying nothing at all.
 */
function WaitValue({ stat, against, lead }: { stat: WaitStat; against: WaitStat; lead: boolean }) {
  const ms = stat?.medianMs ?? null;
  if (ms == null) {
    return (
      <span
        style={{
          fontSize: lead ? 22 : 14,
          fontWeight: 400,
          color: PORTAL_DARK.muted,
          lineHeight: 1.25,
        }}
      >
        —
      </span>
    );
  }

  const baseline = against?.medianMs ?? null;
  const delta = baseline != null ? ms - baseline : 0;
  const tone =
    !lead || baseline == null || Math.abs(delta) < BEHIND_MS
      ? undefined
      : delta > 0
        ? AMBER
        : GREEN;

  return (
    <span
      className="rc-num"
      style={{
        fontSize: lead ? 22 : 14,
        fontWeight: lead ? 800 : 700,
        lineHeight: 1.25,
        color: tone ?? (lead ? INK : PORTAL_DARK.muted),
      }}
    >
      {formatWaitMs(ms)}
    </span>
  );
}

/**
 * TOTAL TIME THIS GROUP HAS BEEN IN OUR HANDS — called to chequered flag.
 *
 * Owner 2026-08-14: "a small number next to or under each session that shows
 * number of minutes (total) they've been waiting from called to race till end
 * of race."
 *
 * It is the number no single box could show, which is exactly why it is worth
 * carrying: each box measures its own leg — checking in, waiting on Start, in
 * the seats — and a group can look fine in every one of them while the whole
 * visit has taken fifty minutes. This is the figure a guest would give you.
 *
 * THE CLOCK STARTS AT THE CALL, and that instant is only knowable while it is
 * happening: Pandora ages its called record out about 20 minutes later. It is
 * stamped into the briefing event at send time for precisely this reason, which
 * is why the log is the lookup here and the live called record is only the
 * fallback for a heat that has not been sent yet.
 *
 * IT STOPS AT THE FLAG, not at "now" — once the race has ended the total is a
 * fact about the visit and must stop growing, or a finished group's number
 * would keep climbing all night on a board nobody had cleared.
 */
/**
 * REMOVED 2026-08-14 (owner: "time so far can go away too"). Every box carried a
 * "N min total so far" footnote under its session number — five of them once the
 * rail existed, each costing a line, none of them a number anyone acts on in the
 * moment. It answers a question about the visit as a whole, which is what the
 * wait-times rail and the `race_timings` archive are for; the board's job is the
 * leg in front of you.
 *
 * The lookup it needed (called-at, stamped into the briefing event at send time
 * because Pandora ages its called record out ~20 min later) went with it. That
 * stamp is still written and still read by the wait-times work — nothing about
 * the record changed, only this board's rendering of it.
 */

/* ── one room ──────────────────────────────────────────────────────────── */

function RoomColumn({
  room,
  track,
  race,
  onTime,
  nextCall,
  onAlarmCue,
  status,
  proFilmMissing,
  videos,
  nowMs,
  checkinWindowMins,
  sentTo,
  checkedIn,
  scannerOffline,
  locked,
  pending,
  expandedCamera,
  onExpandCamera,
  getLiveUrl,
  liveCameras,
  lane,
  ownsLane,
  suggested,
  onRaceReturned,
  hasLaunched,
  noteLaunched,
  onSend,
  onStart,
  onUndo,
  onSendHolding,
}: {
  room: BriefingRoom;
  track: string;
  race: CurrentRace | null;
  onTime: OnTimeSnapshot | null;
  /**
   * The next session on this track that BMI has not called yet, or null.
   *
   * Only ever READ. The call is made in BMI, so this box notices and stops
   * noticing — there is no button here and must not be one (owner 2026-08-17:
   * "you can't have a call button because that comes from BMI").
   */
  nextCall: NextCheckIn | null;
  /**
   * Report this column's alarm cue every tick. ONE speaker serves the whole
   * board — both columns report here and the hook plays each (kind, session,
   * slot) exactly once, so two tracks closing at the same second cannot talk
   * over each other.
   */
  onAlarmCue: (cue: AlarmCue | null) => void;
  status: RoomStatus | null;
  /** No Pro film uploaded — a Pro pick will play the Intermediate film. */
  proFilmMissing: boolean;
  videos: BoardStatus["videos"] | null;
  nowMs: number;
  /** This track's check-in window, from the track board's own config. 0 = not
   *  known yet (or the countdown is off), which raises no alert. */
  checkinWindowMins: number;
  /** Which room this called session already went to, if any. */
  sentTo: BriefingRoom | null;
  /** This heat's check-in progress, for the Called box. Null when the station
   *  has not reported one for this session. */
  checkedIn: CheckinCount | null;
  /** The station's scanner is down — the count above cannot move, and its unit
   *  line should say why instead of promising "still to scan". */
  scannerOffline: boolean;
  locked: boolean;
  pending: string | null;
  /** Which camera the full-screen viewer has open, if any — a preview whose own
   *  camera is up there stops pulling frames. */
  expandedCamera: CameraTarget | null;
  onExpandCamera: (target: CameraTarget) => void;
  /** Mints a live stream for this column's room preview. Threaded from the page
   *  because the admin token lives in useBriefingControl, never in a panel. */
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  /** Whether the room previews may play video at all — the desk-wide setting,
   *  read from the board so every station agrees within one 5s poll. */
  liveCameras: boolean;
  /** This column's pit lane: who is in holding, who is racing, whether the lane
   *  is still held. Null before the first poll lands. */
  lane: PitLaneFeed | null;
  /**
   * Whether THIS column renders the lane. False for one of the two columns on a
   * Mega day, where both rooms serve one circuit and one lane must not appear
   * twice — see megaLaneOwner in the parent.
   */
  ownsLane: boolean;
  /** Mega days only: this room is the recommended target for the next send —
   *  see suggestedRoom in the parent. A chip, never a gate. */
  suggested: boolean;
  /** "Race returned" — the karts are fully back in the lane. */
  onRaceReturned: () => void;
  /** The station's memory of which sessions it has seen race — see the hook. */
  hasLaunched: (sessionId: string | null | undefined) => boolean;
  noteLaunched: (sessionId: string | null | undefined) => void;
  onSend: () => void;
  onStart: (restart: boolean) => void;
  onUndo: () => void;
  /** The group is leaving for the pit seats — see the parent's binding. */
  onSendHolding: () => void;
}) {
  const color = ROOM_COLOR[room];
  // The heat ON TRACK right now, live from the timing system — the same clock
  // the TVs and /leaderboards show (owner 2026-08-11: "add a race timer to
  // checkin?board=1"). In the identity row so it reads even between check-ins.
  // The launched/hold verdicts ride the same hook the Mega unified lane row
  // uses — see useLaneVerdicts.
  const { liveClock, launched, holdLive } = useLaneVerdicts(track, lane, hasLaunched, noteLaunched);
  // The late-send warning names the heat the clock is counting.
  const liveHeatNow = liveClock ? liveHeatNumber(liveClock.heatName) : null;
  const state = status?.state ?? null;
  const timeline = briefingTimelineAt(state, nowMs);
  const occupied = timeline.phase !== "idle";
  /**
   * THE ROOM NO LONGER GUESSES WHERE ITS LAST GROUP IS (owner 2026-08-14: "don't
   * need that 62 on the track message — they're not yet anyhow, but now we have
   * an on-track section so don't need it").
   *
   * An idle room used to infer, from the send record plus the live clock, whether
   * its group was on the grid, racing, or walking back — so it could say "BACK IN
   * 4:12" instead of a FREE it had not earned (owner 2026-08-12). That inference
   * was the only thing on the board that knew where a briefed group had got to.
   *
   * It is not any more. Holding says who is in the seats and On track says who is
   * racing, both from recorded fact rather than from a heat-number match against
   * a clock — and the screenshot that prompted this shows exactly what the guess
   * costs when it is wrong: "Session 62 is out on track" while 62 was sitting in
   * holding, because a briefed group with no finish marker used to read as
   * on-grid. Two boxes stating facts beat a third box inferring one.
   *
   * So an idle room here means an empty room, and says so.
   */
  /**
   * WHICH FILM THIS HEAT GETS — derived from the session, full stop.
   *
   * There used to be a `tierOverride` layered on top of this, set by three
   * buttons in the Called box. It is gone (owner 2026-08-16): the film a grid is
   * briefed with is not a desk decision, and the send it rides on is recorded
   * for insurance. See the VIDEO row below.
   */
  const tier = tierForRaceType(race?.raceType);
  // The desk says what will REALLY play before the send: a Pro pick with no Pro
  // film uploaded runs the Intermediate film (owner 2026-08-11). Availability
  // comes down as a prop — `board` lives in the parent.
  const proMissing = tier === "pro" && proFilmMissing;
  const sameSessionInRoom = !!race && state?.sessionId === String(race.sessionId);

  const calledMs = race?.calledAt ? Date.parse(race.calledAt) : NaN;
  const checkingInMs = Number.isFinite(calledMs) ? Math.max(0, nowMs - calledMs) : null;
  /**
   * ON TIME / +n LATE — from OUR data, not the outside service (2026-08-17).
   *
   * This board was the last surface still reading the vendor's delay, which only
   * called a heat late once it was 30 minutes past its slot — 1 heat in 100 on
   * 2026-08-16, so the chip was green by construction on the one screen the desk
   * actually works from. Ours measures lateness at the CALL, which is the moment
   * the printed slot names and the thing this desk controls.
   */
  const punctual = trackDisplay(onTime, track, null);
  const late = punctual.lateByMin !== null;

  /**
   * IS A SEND GOING IN LATE (owner 2026-08-16: "add a warning to check in board
   * and this board we try to pull to room with under 5 minutes").
   *
   * The same rule and the same five minutes as the room tablet's pull, from the
   * same pure module — the two boards must not disagree about whether a group is
   * being fetched too late, since either of them can be the one doing it.
   *
   * A WARNING, NEVER A REFUSAL. With the group already at the desk, sending late
   * usually still beats not sending; what it must not do is happen unnoticed.
   */
  /** The film this heat will ACTUALLY get, and how long it runs — the number
   *  the whole window is sized around. Resolved through the Pro→Intermediate
   *  fallback so it measures the film the room will really play. Null when
   *  none is uploaded (the window then assumes the starter film). */
  const sendFilmMs = videos?.[resolveFilmTier(tier, (t) => !!videos?.[t]?.url)]?.durationMs ?? null;
  /**
   * ...AND IT BELONGS TO ONE ROOM (owner 2026-08-18: "the session ends in
   * warning should only show on the side where the returning race is going
   * to").
   *
   * On a Mega night both columns read the SAME lane, so one race ending put the
   * identical amber banner — and the identical "Send anyway" button — on both
   * sides. Only one of them is true. The group out on track walks back into the
   * room they were briefed in, and that is the room this send would collide
   * with: their post-race announcement will not play into a room holding a film
   * (postRaceGate, pit/audio.server.ts). The other room is not late at all — it
   * is where this group SHOULD go, which is what the suggestion chip beside it
   * is already saying.
   *
   * UNKNOWN ROOM STILL WARNS BOTH. A group hand-placed from Override carries no
   * room, and a warning that cannot attribute itself must go quiet on neither
   * side rather than the wrong one. Split nights are untouched — one room, one
   * track, and the returning race is always this column's.
   */
  const returningRoom = laneReturnRoom(lane);
  /**
   * WHERE THE SEND SITS ON THE TRACK CLOCK — the late warning's two numbers
   * (race left, film length) turned into a verdict (owner 2026-08-23: "stop
   * them from pushing a group to briefing if they don't have time"). `blocked`
   * disables the send outright; the block lifts by itself at the chequer,
   * because once the track is waiting the hold buys nothing.
   */
  /**
   * THE ZERO GAP (owner 2026-08-23, from the live board: "why is briefing
   * available if the race just finished?"). Between the clock hitting 0:00 and
   * the finished group landing in `pitIn`, the lane says nothing — but the
   * post is seconds away, and a film started now would sit right under it. So
   * a zero clock with an empty pit slot synthesizes an owed post below, timed
   * from the moment THIS board first saw the zero; the engine's dead-cue cap
   * still bounds it, so a timer wedged at 0:00 unblocks itself in 4 minutes.
   * State + effect rather than a render-time ref (react-hooks/refs); the one
   * tick of lag is nothing against a gap that lasts tens of seconds.
   */
  const clockZeroKey = liveClock && liveClock.remainingMs <= 0 ? (liveHeatNow ?? -1) : null;
  const [zeroSeen, setZeroSeen] = useState<{ key: number; atMs: number } | null>(null);
  useEffect(() => {
    // Deferred by a frame rather than set synchronously in the effect body
    // (react-hooks/set-state-in-effect). One frame against a gap that lasts
    // tens of seconds is invisible.
    const t = setTimeout(() => {
      setZeroSeen((cur) => {
        if (clockZeroKey == null) return null;
        return cur?.key === clockZeroKey ? cur : { key: clockZeroKey, atMs: Date.now() };
      });
    }, 0);
    return () => clearTimeout(t);
  }, [clockZeroKey]);

  /**
   * THE POST-RACE ANNOUNCEMENT OWED TO THIS ROOM, from the lane's pit slot.
   * The send stays blocked through the chequer until it has PLAYED (owner
   * 2026-08-23: "unlocked at post race… if it even exists" — the existence
   * fallback lives in sendWindow's POST_WAIT_MAX_MS). Resolves to null the
   * moment the clip ends, which is what unlocks the button.
   */
  const pitPost: PitPost | null = (() => {
    const p = lane?.pitIn;
    if (!p) {
      return zeroSeen
        ? {
            phase: "owed",
            heatNumber: liveHeatNow,
            sinceFinishMs: Math.max(0, nowMs - zeroSeen.atMs),
          }
        : null;
    }
    if (p.postRaceAtMs != null) {
      const endsInMs = p.postRaceAtMs + (p.postRaceDurationS ?? 30) * 1000 - nowMs;
      return endsInMs > 0 ? { phase: "playing", heatNumber: p.heatNumber, endsInMs } : null;
    }
    return {
      phase: "owed",
      heatNumber: p.heatNumber,
      sinceFinishMs: Math.max(0, nowMs - (p.finishedAtMs ?? p.atMs)),
    };
  })();

  const sendWin: SendWindow = sendWindow({
    remainingMs: liveClock?.remainingMs ?? null,
    onTrack: !!liveClock || !!lane?.racing,
    onTrackHeatNumber: liveHeatNow,
    filmMs: sendFilmMs,
    pitPost,
    attribution:
      track !== "mega"
        ? "this-room"
        : returningRoom === room
          ? "this-room"
          : returningRoom == null
            ? "unknown"
            : "other-room",
  });

  /**
   * THE TWO DEADLINES THIS PANEL IS RESPONSIBLE FOR (owner 2026-08-12).
   *
   * Called: the check-in window the TRACK BOARD is counting a racer down against —
   * amber through its last minute, red once it has passed. Only while the heat is
   * still waiting to be sent; once it is in a room it has checked in, and a
   * deadline it has already met must not keep flashing.
   *
   * In the room: how long a group has been sitting in front of a "take a seat"
   * board with nobody pressing Start — amber past 3 minutes, red past 5.
   */
  /**
   * THE WHOLE GRID IS THROUGH THE DESK — the moment staff are waiting for
   * (owner 2026-08-13: "when everyone is checked in start flashing checkin
   * section green").
   *
   * Only while the heat is still WAITING TO BE SENT: once it is in a room the
   * box is no longer asking anything of anyone, and a pulse there would be
   * celebrating a decision already taken.
   *
   * THREE THINGS MUST ALL BE TRUE BEFORE THIS FLASHES, because it is the cue a
   * grid gets sent on:
   *   - we have a count at all (null = the roster read failed; that used to
   *     arrive as 0 and "0/0" was one bad comparison away from reading as
   *     complete — see roster-count.ts),
   *   - the count is a FRESH one, not the last known (a carried-over count says
   *     what was true minutes ago, which is not what "everyone is here" claims),
   *   - and there is somebody to be complete: `total > 0`.
   */
  const gridComplete =
    !!race &&
    !sentTo &&
    !!checkedIn &&
    !checkedIn.stale &&
    checkedIn.total !== null &&
    checkedIn.checkedIn !== null &&
    checkedIn.total > 0 &&
    checkedIn.checkedIn >= checkedIn.total;

  const calledAlert =
    race && !sentTo && checkingInMs != null
      ? checkinAlert(checkingInMs, checkinWindowMins)
      : "none";
  /**
   * IS THIS TRACK OWING A CALL, right now?
   *
   * Only while the Called box is EMPTY. With a heat sitting in it the box already
   * has a job — its own check-in window — and two amber deadlines in one box
   * cannot both be read.
   */
  const calledBoxEmpty = !(race && !sentTo);
  const callDue = calledBoxEmpty && nextCall != null && nextCall.state !== "quiet";
  /** The far edge of the owner's window: call time + 5 + 2. */
  const callWindowEndsMs =
    nextCall != null ? nextCall.callAtMs + CALL_WINDOW_MIN * 60_000 : Number.NaN;

  /**
   * THE TWO AUDIBLE DEADLINES (owner 2026-08-23). Reported every tick; the
   * alarm hook plays each once per 10-second slot, three times per event. Both
   * cues are derived from the SAME numbers the box is already showing, so the
   * sound can never claim something the screen does not.
   */
  const callCue = callAlarmCue({
    nowMs,
    next:
      nextCall != null && Number.isFinite(callWindowEndsMs)
        ? {
            sessionId: nextCall.sessionId,
            heatNumber: nextCall.heatNumber,
            callWindowEndsMs,
          }
        : null,
  });
  const sendCue = sendAlarmCue({
    called:
      race && !sentTo ? { sessionId: String(race.sessionId), heatNumber: race.heatNumber } : null,
    calledForMs: checkingInMs,
    // The alarm rides the GRACE countdown — the minute in which the desk is
    // out of time but can still act is exactly the minute worth shouting in.
    windowClosesInMs: sendWin.kind === "grace" ? sendWin.graceLeftMs : null,
  });
  // The send deadline outranks the call one: a group already standing at the
  // desk is the more expensive of the two to lose.
  const cue = sendCue ?? callCue;
  // Deps are the cue's own PRIMITIVES, so the effect runs three times an event
  // rather than once a second — and no object identity or ref is involved.
  const cueKind = cue?.kind ?? null;
  const cueSlot = cue?.slot ?? null;
  const cueSession = cue?.sessionId ?? null;
  const cueHeat = cue?.heatNumber ?? null;
  useEffect(() => {
    if (cueKind == null || cueSlot == null || cueSession == null) return;
    onAlarmCue({
      kind: cueKind,
      slot: cueSlot,
      sessionId: cueSession,
      heatNumber: cueHeat,
    });
  }, [cueKind, cueSlot, cueSession, cueHeat, onAlarmCue]);

  /** Time left in the check-in window; negative once it has passed. Null when no
   *  window is known, which is also when no alert can fire. */
  const checkinRemainingMs =
    checkinWindowMins > 0 && checkingInMs != null
      ? checkinWindowMins * 60_000 - checkingInMs
      : null;
  const waitingMs = state ? Math.max(0, nowMs - state.triggeredAtMs) : 0;
  const roomAlert = timeline.phase === "waiting" ? waitingAlert(waitingMs) : "none";

  /**
   * THE GREEN FLAG EMPTIES THE SEATS (owner 2026-08-13: "on race start for that
   * session the holding needs to clear — they're done").
   *
   * Computed HERE rather than in either box, because Holding and On track both
   * need this answer and they must never disagree: the same flag that empties
   * one puts the group on the other.
   *
   * WHY IT IS A CLIENT DECISION AND NOT A SERVER ONE. The lane deliberately keeps
   * a holding claim through the race (lane.server.ts, 92efb96f): the venue's
   * start marker fires at PHASE ONE — karts rolling out, clock armed but static,
   * stragglers still being walked to karts — so promoting on it would empty the
   * seats while staff are still filling them. Server-side a holding claim ends
   * only on the finish marker or on the next group taking the seats.
   *
   * That is right for the WALL, which has to keep presenting the group. It is
   * wrong for the DESK, whose box answers "is anyone in the seats" — and once the
   * clock is counting, nobody is.
   *
   * So the desk reads the same verdict the wall does: this track's live heat IS
   * the holding session, and its clock is genuinely COUNTING (live-session's
   * raw-frame `counting`, which phase one cannot fake — a static clock repeats
   * its value, a running one decreases). Matched on heat number, never on track
   * alone, so a neighbouring heat can never empty this group's seats.
   */
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minHeight: 0,
        borderLeft: `3px solid ${color}`,
        paddingLeft: 12,
        // THE COLUMN SCROLLS, THE PAGE NEVER DOES. Three boxes fit a desk
        // monitor at the sizes above; a fourth (owner: "we might be going to 4
        // boxes") or a short screen must degrade to a scroll INSIDE this
        // column, so the header, the room identity and the other track stay
        // exactly where staff expect them.
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexShrink: 0 }}>
        <strong style={{ fontSize: 15, color, letterSpacing: "0.02em" }}>
          {cap(room).toUpperCase()} ROOM
        </strong>
        <span style={{ fontSize: 11, color: PORTAL_DARK.muted }}>{cap(track)} Track</span>
        {/**
         * IS THIS TRACK RUNNING TO TIME (owner 2026-08-16: "add on time and not
         * on time here please on check in board").
         *
         * It was already on the board, in the least readable place available: as
         * the unit line under a number in the Called box, which only renders
         * while a heat is waiting to be sent. So for most of a shift the board
         * said nothing about whether the night was on schedule, and when it did
         * it said it in 10px grey.
         *
         * IT LIVES IN THE IDENTITY ROW because that row is always there — the
         * Called box comes and goes with the heats — and because it belongs
         * beside the on-track clock, which is the other fact about how this
         * track is running.
         *
         * UNKNOWN NOW READS AS ON TIME, which is a reversal worth naming. This
         * chip used to give a track it could not see its own third verdict. The
         * owner's call (2026-08-17) is that a board with nothing to say says "On
         * Time" rather than going grey, because a neutral chip reads as a broken
         * screen. The cost is real and accepted: a dead feed looks like a calm
         * night here. The camera monitor's sub-line is the one surface that still
         * admits it (see `feedStale`).
         */}
        {/* ONE HOME, ALWAYS. This used to float right whenever the on-track
            clock was absent (marginLeft: auto), so the pill sat beside the
            track name on one column and at the far edge on the other — and
            staff had to hunt for it as races started and stopped. It is a fact
            about the track's identity, so it stays with the track's name; the
            row's far end belongs to the clock, or to nothing (owner 2026-08-23). */}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.04em",
            background: late ? withAlpha(AMBER, 0.16) : withAlpha(GREEN, 0.14),
            border: `1px solid ${late ? withAlpha(AMBER, 0.55) : withAlpha(GREEN, 0.45)}`,
            color: late ? AMBER : GREEN,
          }}
          title="Whether this track's heats are being CALLED on time, from our own timing data"
        >
          {verdictLabel(punctual).toUpperCase()}
        </span>
        {liveClock && (
          <span
            className="rc-num"
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 13,
              fontWeight: 800,
              color: liveClock.state === "paused" ? AMBER : INK,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                alignSelf: "center",
                background: liveClock.state === "paused" ? AMBER : GREEN,
                boxShadow: `0 0 8px ${liveClock.state === "paused" ? AMBER : GREEN}`,
              }}
            />
            {liveClock.state === "paused" ? "PAUSED" : "ON TRACK"}&nbsp;
            {formatRemaining(liveClock.remainingMs)}
          </span>
        )}
      </div>

      {/* ── CALLED ── */}
      <Panel
        label="Called"
        flat
        // With a heat in the box this is its check-in-window deadline, exactly as
        // before. With the box EMPTY it is the call this track owes — amber only,
        // never red: red on this board means a missed deadline that costs a race,
        // and a late call costs minutes (same rule as the late-send notice).
        /* THE ONE-MINUTE GRACE (owner 2026-08-23: "1 minute grace period where
           check in blinks red as they're out of time to send"). Over the send
           window's last minute the whole box takes the red flash, and it
           OUTRANKS the green ready-flash for exactly that minute — "everyone
           is here" is old news beside "you are about to lose the send". */
        alert={
          race && !sentTo
            ? sendWin.kind === "grace"
              ? "late"
              : calledAlert
            : callDue
              ? "warn"
              : undefined
        }
        ready={gridComplete && sendWin.kind !== "grace"}
        // THE LEAPFROG HINT, top-right where the eye lands before the button
        // (owner 2026-08-17: "bigger/more obvious… the top right corner is
        // empty"). Solid Mega violet so it reads as the Mega rotation
        // speaking, not this room's own colour. Advice, never a gate — the
        // other room's Send works exactly as it always has.
        badge={
          suggested && race && !sentTo && !sameSessionInRoom ? (
            <span
              style={{
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: "0.08em",
                padding: "5px 14px",
                borderRadius: 6,
                background: MEGA,
                color: "#fff",
                whiteSpace: "nowrap",
                boxShadow: `0 0 16px ${withAlpha(MEGA, 0.55)}`,
              }}
            >
              SUGGESTED ROOM
            </span>
          ) : undefined
        }
      >
        {race && !sentTo ? (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <div style={{ minWidth: 150 }}>
                <div
                  className="rc-num"
                  style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.05, color: INK }}
                >
                  Session {race.heatNumber}
                </div>
                <div style={{ fontSize: 14, color: PORTAL_DARK.muted, marginTop: 2 }}>
                  {race.raceType}
                </div>
              </div>

              {/* The two numbers that matter before a send. */}
              {/* Still the ELAPSED number the board is built around, but its unit
                  line names the deadline once that deadline is close — the desk
                  should not have to do the subtraction in its head to know how
                  long a heat has left. */}
              <Stat
                label="Checking in"
                value={checkingInMs != null ? formatClock(checkingInMs) : "—"}
                unit={
                  calledAlert === "late"
                    ? `${formatClock(Math.abs(checkinRemainingMs ?? 0))} past the window`
                    : calledAlert === "warn"
                      ? `window closes in ${formatClock(checkinRemainingMs ?? 0)}`
                      : "since called"
                }
                tone={calledAlert === "late" ? DANGER : calledAlert === "warn" ? AMBER : undefined}
              />
              {/* CHECKED IN, beside the clock it belongs to. Moved down from the
                  top of the board (owner 2026-08-12) so the number sits with the
                  heat it counts rather than in a strip of its own. Green once the
                  whole grid is through the desk — the moment staff can send. */}
              {checkedIn &&
                (checkedIn.total === null || checkedIn.checkedIn === null ? (
                  /* NO COUNT IS NOT A COUNT OF NONE. The roster read did not come
                     back, so the box says so and stays quiet — it does not go
                     green, and it does not tell anyone there is nobody to wait
                     for. Staff read "—" as "ask the desk", which is correct;
                     they read "0/0" as "send them", which is how a full grid got
                     sent early. */
                  <Stat label="Checked in" value="—" unit="no roster read" />
                ) : (
                  <Stat
                    label="Checked in"
                    value={`${checkedIn.checkedIn}/${checkedIn.total}`}
                    /* THE OUTAGE REACHES THE HEAT IT IS STARVING. With the
                       scanner down, "8 still to scan" is a promise the count
                       cannot keep — the top strip's alarm gets its local
                       consequence here instead (owner 2026-08-23). "All here"
                       still wins: a complete grid is complete however the
                       scanner feels. */
                    unit={
                      checkedIn.total > 0 && checkedIn.checkedIn >= checkedIn.total
                        ? checkedIn.stale
                          ? "last known"
                          : "all here"
                        : scannerOffline
                          ? `scanner offline — ${Math.max(0, checkedIn.total - checkedIn.checkedIn)} can't scan`
                          : checkedIn.stale
                            ? "last known"
                            : `${Math.max(0, checkedIn.total - checkedIn.checkedIn)} still to scan`
                    }
                    /* A CARRIED-OVER COUNT NEVER TURNS THE BOX GREEN. Green is
                       the cue to send a grid; it has to mean "counted, just now",
                       not "counted at some point". */
                    tone={
                      !checkedIn.stale &&
                      checkedIn.total > 0 &&
                      checkedIn.checkedIn >= checkedIn.total
                        ? GREEN
                        : scannerOffline && checkedIn.total > 0
                          ? AMBER
                          : undefined
                    }
                  />
                ))}
              {/* THE SEND WINDOW AS A NUMBER, NOT A SENTENCE (owner 2026-08-23:
                  "clean it up, focus on important numbers"). This replaced a
                  full-width prose banner that restated what the button below
                  already says. One stat: the seconds that matter, coloured by
                  what they mean — grey counting down to the window, green
                  while it is open, amber over its last seconds, red once the
                  film no longer fits (the value is then the time to the flag,
                  which is when sending unlocks). */}
              {sendWin.kind !== "quiet" && (
                <Stat
                  label={
                    sendWin.kind === "blocked"
                      ? "Send locked"
                      : sendWin.kind === "grace"
                        ? "Grace left"
                        : "Send window"
                  }
                  value={
                    sendWin.kind === "early"
                      ? formatClock(Math.max(0, sendWin.opensInMs))
                      : sendWin.kind === "grace"
                        ? formatClock(Math.max(0, sendWin.graceLeftMs))
                        : sendWin.kind === "blocked"
                          ? sendWin.why === "film"
                            ? formatClock(Math.max(0, sendWin.remainingMs ?? 0))
                            : sendWin.why === "post-playing"
                              ? formatClock(Math.max(0, sendWin.postEndsInMs ?? 0))
                              : "—"
                          : formatClock(Math.max(0, sendWin.closesInMs))
                  }
                  unit={
                    sendWin.kind === "early"
                      ? "until it opens"
                      : sendWin.kind === "open"
                        ? "send now"
                        : sendWin.kind === "grace"
                          ? `out of time by ${formatClock(sendWin.overBy)} — send now`
                          : sendWin.why === "film"
                            ? "grace gone — post first"
                            : sendWin.why === "post-playing"
                              ? "post playing — then send"
                              : "waiting on the post-race call"
                  }
                  tone={
                    sendWin.kind === "open"
                      ? GREEN
                      : sendWin.kind === "grace" || sendWin.kind === "blocked"
                        ? DANGER
                        : undefined
                  }
                />
              )}
              {/* TRACK DELAY MOVED TO THE IDENTITY ROW as an ON TIME / n BEHIND
                  chip — it is a fact about the track, not about this heat, and
                  down here it only existed while a heat happened to be waiting.
                  See the chip above. */}
            </div>

            {/* GRID COMPLETENESS AS A SHAPE — "4/12" asks for arithmetic from
                across the desk; the same 6px bar the film earned makes it a
                glance. Green like the all-here flash it visibly completes
                (owner 2026-08-23). Hidden with no live count: a bar stuck at
                a stale width is a lie with a shape. */}
            {checkedIn &&
              checkedIn.total != null &&
              checkedIn.checkedIn != null &&
              checkedIn.total > 0 &&
              !checkedIn.stale && (
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.09)",
                    overflow: "hidden",
                  }}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={checkedIn.total}
                  aria-valuenow={Math.min(checkedIn.checkedIn, checkedIn.total)}
                  aria-label="Racers through the desk"
                >
                  <div
                    style={{
                      width: `${Math.min(100, (checkedIn.checkedIn / checkedIn.total) * 100)}%`,
                      height: "100%",
                      background: GREEN,
                      transition: "width 0.5s ease",
                    }}
                  />
                </div>
              )}

            {/* The send window's prose banner lived here for one deploy and was
                cut the same night (owner 2026-08-23: "too busy — focus on
                important numbers"). Its verdict now lives twice, compactly: the
                Send-window STAT in the row above, and the button below. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 2,
              }}
            >
              <span style={{ fontSize: 10, color: PORTAL_DARK.muted, letterSpacing: "0.06em" }}>
                VIDEO
              </span>
              {/* A READOUT, NOT A PICKER (owner 2026-08-16: block the briefing
                  video types from being changed on the check-in board).

                  This was three buttons — Starter · auto / Intermediate / Pro —
                  and a desk with a group standing in front of it is the worst
                  place to be choosing a SAFETY film. The session's own race type
                  already decides it (tierForRaceType), the Pro→Intermediate
                  fallback already covers the one film that can be missing, and
                  the choice is durable: whatever is picked here is what the
                  insurance log records as the briefing that grid received. A
                  mis-tap on a touch monitor could therefore put a first-timer
                  grid in front of the returning-racer film, and the log would
                  carry that as the fact of the night.

                  So the row still says which film this heat gets — that is the
                  thing staff actually read before a send — it just no longer
                  offers to change it. The chip keeps the selected button's
                  colours deliberately: the answer is unchanged, only the
                  affordance is gone. Uploading the films is still a staff job,
                  on the Lobby TVs page, where it belongs. */}
              <span
                title="The briefing film follows the session's race type and cannot be changed from this board."
                style={{
                  padding: "4px 11px",
                  borderRadius: 5,
                  border: `1px solid ${withAlpha(color, 0.8)}`,
                  background: withAlpha(color, 0.16),
                  color: INK,
                  fontSize: 11,
                  fontWeight: 650,
                }}
              >
                {cap(tier)}
              </span>
              <span style={{ fontSize: 10, color: PORTAL_DARK.muted }}>set by race type</span>
              {/* Say what will REALLY play, before the send — the fallback is
                  server-side, and hiding it would leave staff thinking a Pro grid
                  is getting a film that does not exist yet. */}
              {proMissing && (
                <span style={{ fontSize: 10, color: AMBER }}>
                  no Pro film yet — plays Intermediate
                </span>
              )}

              {sameSessionInRoom ? (
                <span style={{ marginLeft: "auto", fontSize: 11, color: GREEN }}>
                  ✓ in the {room} room
                </span>
              ) : (
                <span
                  style={{
                    marginLeft: "auto",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {/* The leapfrog hint lives on the panel header now — big,
                      top-right, above this button (owner 2026-08-17). */}
                  <ActionButton
                    // The button wears the window's state: green while the film
                    // lands cleanly, RED AND STILL LIVE through the grace
                    // minute (owner 2026-08-23 — the desk may spend it), and
                    // dead only once the grace is gone. An occupied room keeps
                    // its amber Replace flow untouched.
                    tone={
                      occupied
                        ? AMBER
                        : sendWin.kind === "blocked" || sendWin.kind === "grace"
                          ? DANGER
                          : sendWin.kind === "open"
                            ? GREEN
                            : color
                    }
                    outline={occupied || (sendWin.kind === "blocked" && !occupied)}
                    textColor={
                      !occupied && sendWin.kind === "grace"
                        ? "#26060a"
                        : !occupied && sendWin.kind === "open"
                          ? "#04220f"
                          : undefined
                    }
                    // THE BOARD'S LOUDEST MOMENT (owner 2026-08-23: "more
                    // aggressive!"): the grace minute and a complete grid on an
                    // open window are both a single right press, so the button
                    // grows and pulses — red in the grace, green while open.
                    // Never while occupied: Replace is a decision, not a reflex.
                    size={
                      !occupied &&
                      (sendWin.kind === "grace" || (gridComplete && sendWin.kind === "open"))
                        ? "lg"
                        : "md"
                    }
                    className={
                      occupied
                        ? undefined
                        : sendWin.kind === "grace"
                          ? "rc-send-pulse-red"
                          : gridComplete && sendWin.kind === "open"
                            ? "rc-send-pulse"
                            : undefined
                    }
                    pendingKey={`send:${room}`}
                    pending={pending}
                    disabled={
                      !race.sessionId || locked || (sendWin.kind === "blocked" && !occupied)
                    }
                    pendingLabel={occupied ? "Replacing…" : "Sending…"}
                    onClick={() => {
                      if (
                        occupied &&
                        !window.confirm(
                          `The ${room} room is showing ${PHASE_LABEL[
                            timeline.phase
                          ].toLowerCase()} for session ${state?.heatNumber ?? "?"}.\n\nReplace it with Session ${race.heatNumber}?`,
                        )
                      ) {
                        return;
                      }
                      onSend();
                    }}
                  >
                    {occupied
                      ? "Replace"
                      : sendWin.kind === "blocked"
                        ? "Locked — sends after the post"
                        : sendWin.kind === "grace"
                          ? `SEND ANYWAY — ${formatClock(Math.max(0, sendWin.graceLeftMs))} →`
                          : gridComplete && sendWin.kind === "open"
                            ? `SEND TO ${cap(room).toUpperCase()} NOW →`
                            : `Send to ${cap(room)} →`}
                  </ActionButton>
                </span>
              )}
            </div>
          </>
        ) : callDue && nextCall ? (
          /* NOBODY CALLED, AND ONE IS DUE. The dash below is the right answer
             when there is nothing to say; this is the case where there is.
             Same banner shape as the late-send notice above, because it is the
             same kind of fact: a clock the desk is about to lose. */
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "7px 10px",
              borderRadius: 8,
              background: withAlpha(AMBER, 0.12),
              border: `1px solid ${withAlpha(AMBER, 0.55)}`,
            }}
            role="status"
          >
            <IconAlertTriangleFilled
              size={14}
              style={{ flexShrink: 0, color: AMBER, marginTop: 2 }}
              aria-hidden
            />
            {/* THE WINDOW AS A COUNTDOWN (owner 2026-08-23: "a countdown to
                call time, then another if the space is closing"). While the
                window is open the bold line counts it down live; once it is
                gone the count flips to how far past it the call is. The board
                already ticks every second, so the number moves. */}
            <span style={{ fontSize: 12, lineHeight: 1.4 }}>
              <b style={{ color: AMBER }}>
                {nextCall.state === "overdue" ? (
                  <>
                    {nextCall.heatNumber != null
                      ? `Session ${nextCall.heatNumber}`
                      : "The next session"}
                    {` is ${nextCall.overdueMin} min overdue to be called.`}
                  </>
                ) : (
                  <>
                    {/* "window closes" was ambiguous with the SEND window and
                        read as a contradiction beside a race that had just gone
                        green (owner 2026-08-23). The countdown now names what it
                        is counting: time left to make the CALL. */}
                    {nextCall.heatNumber != null
                      ? `Call Session ${nextCall.heatNumber} — `
                      : "Call the next session — "}
                    <span className="rc-num">
                      {formatClock(Math.max(0, callWindowEndsMs - nowMs))}
                    </span>{" "}
                    left to call it on time.
                  </>
                )}
              </b>{" "}
              {`${nextCall.booked} booked · check-in ${clockMinuteMs(nextCall.slotMs)}`}
              {nextCall.state === "overdue" ? "" : ` · call by ${clockMinuteMs(callWindowEndsMs)}`}
            </span>
          </div>
        ) : nextCall ? (
          /* NOBODY CALLED, AND NONE DUE YET — say which heat is next and count
             down to its call time, quietly. The desk asked for the box to
             answer "when do I call what" before the clock starts nagging
             (owner 2026-08-23). */
          <div style={{ fontSize: 12, color: PORTAL_DARK.muted, lineHeight: 1.5 }} role="status">
            <b style={{ color: INK, fontWeight: 650 }}>
              Next: call Session {nextCall.heatNumber ?? "?"} in{" "}
              <span className="rc-num">{formatClock(Math.max(0, nextCall.callAtMs - nowMs))}</span>
            </b>
            {` · at ${clockMinuteMs(nextCall.callAtMs)} · ${nextCall.booked} booked · check-in ${clockMinuteMs(nextCall.slotMs)}`}
          </div>
        ) : (
          /* Nothing called, or the called heat has already gone to a room —
             either way this box has nobody, and the room box below names
             whoever left. The dash is the whole answer. */
          <EmptyStage />
        )}
      </Panel>

      {/* ── IN THE ROOM ── */}
      {/* NOT `grow` any more. One box stretching to fill the column made sense
          when there were two; with four it just donates the slack to whichever
          box happens to be in the middle, which is where the empty band under
          the clock came from. Every box is now content-height and the leftover
          space collects at the foot of the column, where it costs nothing. */}
      <Panel
        label="In the room"
        alert={roomAlert}
        accent={occupied ? phaseColor(timeline.phase, color) : undefined}
        badge={
          <span
            className="rc-num"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.05em",
              color: occupied ? phaseColor(timeline.phase, color) : PORTAL_DARK.muted,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: occupied ? phaseColor(timeline.phase, color) : PORTAL_DARK.muted,
              }}
            />
            {occupied ? PHASE_LABEL[timeline.phase].toUpperCase() : "FREE"}
          </span>
        }
      >
        <InRoom
          room={room}
          color={color}
          state={state}
          timeline={timeline}
          nowMs={nowMs}
          locked={locked}
          pending={pending}
          cameraExpanded={expandedCamera === room}
          onExpandCamera={() => onExpandCamera(room)}
          getLiveUrl={getLiveUrl}
          liveCameras={liveCameras}
          alert={roomAlert}
          /**
           * The RESOLVED lane is what makes this self-clearing: resolve promotes
           * a group out of `holding` the instant they take the track and moves
           * them to `karts` when they climb in, so a non-null `holding` here
           * means they are genuinely still in the seats. The button reopens on
           * its own the moment it is safe — no second press, no timer.
           */
          holdingBlockedBy={
            lane?.holding && lane.holding.sessionId !== state?.sessionId
              ? (lane.holding.heatNumber ?? 0)
              : null
          }
          onStart={onStart}
          onUndo={onUndo}
          onSendHolding={onSendHolding}
        />
      </Panel>

      {/* ── OUT OF THE ROOM ── the third box, carrying three stages. */}
      {ownsLane && (
        <OutOfRoomPanel
          room={room}
          track={track}
          color={color}
          lane={lane}
          liveClock={liveClock}
          launched={launched}
          holdLive={holdLive}
          nowMs={nowMs}
          locked={locked}
          pending={pending}
          cameraExpanded={expandedCamera === holdingCameraFor(room)}
          onExpandCamera={() => onExpandCamera(holdingCameraFor(room))}
          getLiveUrl={getLiveUrl}
          liveCameras={liveCameras}
          onRaceReturned={onRaceReturned}
        />
      )}
    </div>
  );
}

/* ── out of the room ───────────────────────────────────────────────────── */

/**
 * THE LANE'S THREE VERDICTS, one hook — the live clock, the green-flag memory
 * and the hold. Extracted from RoomColumn so the Mega board's UNIFIED lane row
 * (below the columns, full width) reads the identical rules; two copies of
 * "has this group launched" is how a column and the strip would disagree.
 *
 * WHICHEVER SLOT HOLDS THE GROUP WAITING ON THE GREEN — the karts if they have
 * climbed in, otherwise the seats. The SAME `karts ?? holding` rule the server
 * promotes on (resolveLane), because a desk that watched a different group
 * than the server did is a desk that disagrees with its own wall.
 *
 * ONCE SEEN RACING, ALWAYS RACED. The clock only publishes while a heat is
 * running, so the counting verdict evaporates the moment the flag drops — and
 * the group reappeared in seats they had long since left (owner 2026-08-14:
 * "session 64 both tracks when finished went back to holding state"). The lane
 * would normally have ended the claim on its finish marker, but that marker
 * rides the timing webhook and has been seen not to arrive. So the station
 * remembers, via noteLaunched/hasLaunched, what it watched happen.
 *
 * IS THE LANE STILL HELD — is anybody in the pit with an announcement still
 * owed. The same rule the pit board's own rail runs (pitRailState in
 * pit/pit-board.ts): a group sits in `pitIn` from their chequered flag until
 * their post cue clears them, so the slot being occupied IS the hold.
 */
function useLaneVerdicts(
  track: string,
  lane: PitLaneFeed | null,
  hasLaunched: (sessionId: string | null | undefined) => boolean,
  noteLaunched: (sessionId: string | null | undefined) => void,
): {
  liveClock: LiveSessionClock | null;
  launched: { heatNumber: number; sessionId: string | null } | null;
  holdLive: boolean;
} {
  const liveClock = useLiveSessionClock(track as TrackKey);
  const stagedGroup = lane?.karts ?? lane?.holding ?? null;
  const stagedHeat = stagedGroup?.heatNumber ?? null;
  const stagedSessionId = stagedGroup?.sessionId ?? null;
  const liveHeatNow = liveClock ? liveHeatNumber(liveClock.heatName) : null;
  const countingNow =
    stagedHeat != null &&
    liveHeatNow != null &&
    stagedHeat === liveHeatNow &&
    liveClock?.counting === true;

  useEffect(() => {
    if (countingNow) noteLaunched(stagedSessionId);
  }, [countingNow, stagedSessionId, noteLaunched]);

  const launched =
    stagedHeat != null && (countingNow || hasLaunched(stagedSessionId))
      ? { heatNumber: stagedHeat, sessionId: stagedSessionId }
      : null;

  const holdLive = !!lane?.pitIn;
  return { liveClock, launched, holdLive };
}

/**
 * THE UNIFIED LANE ROW — Mega only. Below the two briefing columns the
 * pipeline is ONE lane (owner 2026-08-16/17: "two possible briefings but
 * everything after brief is a unified single step… remove the divider and
 * fill the whole bottom"), so the Out-of-the-room rail stops living inside
 * one room's column with dead space beside it and spans the full board.
 * Wears the MEGA violet, not a room's colour — the lane belongs to the
 * circuit, and the holding camera follows whichever pen the current group
 * was briefed toward (the parent's megaLaneOwner).
 */
function MegaLaneRow({
  room,
  lane,
  nowMs,
  locked,
  pending,
  cameraExpanded,
  onExpandCamera,
  getLiveUrl,
  liveCameras,
  onRaceReturned,
  hasLaunched,
  noteLaunched,
}: {
  room: BriefingRoom;
  lane: PitLaneFeed | null;
  nowMs: number;
  locked: boolean;
  pending: string | null;
  cameraExpanded: boolean;
  onExpandCamera: () => void;
  /** The Mega lane shows the same holding camera as a room column would — one
   *  circuit, one set of seats, so it needs the same two props. */
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  liveCameras: boolean;
  onRaceReturned: () => void;
  hasLaunched: (sessionId: string | null | undefined) => boolean;
  noteLaunched: (sessionId: string | null | undefined) => void;
}) {
  const { liveClock, launched, holdLive } = useLaneVerdicts(
    "mega",
    lane,
    hasLaunched,
    noteLaunched,
  );
  return (
    <div style={{ minWidth: 0 }}>
      <OutOfRoomPanel
        room={room}
        track="mega"
        color={MEGA}
        lane={lane}
        liveClock={liveClock}
        launched={launched}
        holdLive={holdLive}
        nowMs={nowMs}
        locked={locked}
        pending={pending}
        cameraExpanded={cameraExpanded}
        onExpandCamera={onExpandCamera}
        getLiveUrl={getLiveUrl}
        liveCameras={liveCameras}
        onRaceReturned={onRaceReturned}
      />
    </div>
  );
}

/**
 * AN EMPTY STAGE SAYS SO ONCE (owner 2026-08-14: "is the extra nobody in karts,
 * nobody in seats needed?").
 *
 * It was not. Every empty row carried a sentence — "Nobody in the karts",
 * "Nobody in the seats — session 60 is out on Red" — sitting beside a badge
 * already reading EMPTY or FREE, and naming a session the ON TRACK row named
 * again two lines below. The longest of them wrapped, so the least informative
 * row on the board was also the tallest.
 *
 * The stage label and the badge are the whole statement. This is the same dash
 * the pit wall's idle list uses for an empty stage, so the two boards read alike.
 */
function EmptyStage() {
  return (
    <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color: withAlpha(INK, 0.32) }}>
      —
    </span>
  );
}

/**
 * THE ROOM THIS GROUP WILL WALK BACK INTO, beside the session itself (owner
 * 2026-08-18: "check in board should have the pill as well").
 *
 * MEGA ONLY, and that is the whole point of it. On a split night this rail
 * lives inside its own room's column, so every group in it came from that room
 * and a pill would only repeat the column header. Mega runs TWO rooms into ONE
 * lane, and then the room is the half of "Session 28" that says whose it is —
 * the fact staff need while deciding which room to clear, and the one the lane
 * used to lose between the green flag and the pit.
 *
 * Same pill, same words, same reason as the Mega session tracker's
 * (ScenePitBoard) — the wall and the desk must not describe a night
 * differently. Sized for this board, not that one: the rail is four rows on a
 * desk monitor, not a sign read from the fence.
 */
function RoomPill({ room }: { room: BriefingRoom | null }) {
  if (!room) return null;
  return (
    <span
      className="rc-num"
      style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.05em",
        whiteSpace: "nowrap",
        color: ROOM_COLOR[room],
        border: `1px solid ${withAlpha(ROOM_COLOR[room], 0.7)}`,
        background: withAlpha(ROOM_COLOR[room], 0.14),
        borderRadius: 6,
        padding: "2px 8px",
      }}
    >
      {`→ ${room.toUpperCase()} ROOM`}
    </span>
  );
}

/**
 * ONE STAGE OF THE RAIL — one group, one clock, one badge, one row.
 *
 * The three stages after the briefing room (Holding, In karts, On track) are
 * each a single session, a single clock and at most one press. As three separate
 * Panels that was three lots of border, padding, label and badge chrome for
 * three one-line facts — and with In Karts added it was a fifth box in a column
 * that already needed a scrollbar to survive the fourth (owner 2026-08-14: the
 * goal is "all states on one screen height wise"). A box that has scrolled below
 * the fold cannot flash for attention, which is the whole job of the lane-held
 * alarm.
 *
 * So they share one Panel and become rows. The row keeps the board's own
 * grammar — a labelled tile with its unit (see the file header) — just at the
 * unemphasised Stat size rather than `big`, because three 40px numbers stacked
 * is most of a monitor.
 *
 * THE BADGE IS PER ROW, NOT PER PANEL. One badge on the Panel would have to
 * speak for three different records, and the moment two of them are occupied it
 * has to pick one and lie about the others.
 */
function StageRow({
  stage,
  badge,
  first,
  who,
  clock,
  end,
}: {
  stage: string;
  badge: { label: string; tone: string };
  /** Skips the divider. The rule is `row + row`, so the first row has none. */
  first?: boolean;
  who: ReactNode;
  clock?: ReactNode;
  end?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        // Tight, because three of these stack. The floor is what an empty row
        // needs to stay readable as a row rather than a stray line of text.
        padding: "4px 0",
        minHeight: 38,
        ...(first ? null : { borderTop: `1px solid ${withAlpha(INK, 0.07)}` }),
      }}
    >
      <span
        style={{
          flex: "0 0 66px",
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          color: PORTAL_DARK.muted,
        }}
      >
        {stage}
      </span>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>{who}</div>
      {clock ? <div style={{ flex: "0 0 auto", minWidth: 108 }}>{clock}</div> : null}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
          minWidth: 132,
        }}
      >
        <span
          className="rc-num"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.05em",
            color: badge.tone,
          }}
        >
          <span
            aria-hidden
            style={{ width: 7, height: 7, borderRadius: "50%", background: badge.tone }}
          />
          {badge.label}
        </span>
        {end}
      </div>
    </div>
  );
}

/**
 * EVERYTHING AFTER THE BRIEFING ROOM — Holding, In karts, On track.
 *
 * The column's third and last box, and the one that carries three of the five
 * stages. It replaces the separate Holding and On-track panels; the name pairs
 * with "In the room" directly above it, which is exactly the distinction it
 * draws.
 *
 * IT ANSWERS ONE QUESTION IN THREE PLACES: where is each group that has left the
 * room. Splitting that across three boxes put the reason a group cannot move
 * (the lane is held) in one box and the press that fixes it in another — they
 * are now two rows apart with the press on the row it belongs to.
 *
 * ONE CAMERA FOR THE WHOLE RAIL. The holding view used to sit inside its own
 * box; it now spans all three rows, because the lane is what all three are about
 * — who is in the seats, who is in the karts, who is out on it. CAM_W is
 * untouched, which is what its own note asks for: the answer must not change
 * when a box is added.
 *
 * THE HOLD KEEPS THE ALARM. `late` rather than the On-track box's old `warn`:
 * merged into one box there can be only one level, and the hold is a safety fact
 * with a press attached — the stronger of the two is the honest one.
 *
 * EMPTY COLLAPSES TO ONE LINE. Early evening nothing is past the room, and three
 * empty Panels cannot shrink below their own chrome; three empty rows can.
 */
function OutOfRoomPanel({
  room,
  track,
  color,
  lane,
  liveClock,
  launched,
  holdLive,
  nowMs,
  locked,
  pending,
  cameraExpanded,
  onExpandCamera,
  getLiveUrl,
  liveCameras,
  onRaceReturned,
}: {
  room: BriefingRoom;
  track: string;
  color: string;
  lane: PitLaneFeed | null;
  liveClock: LiveSessionClock | null;
  /** The group whose green flag has been seen — computed in the room column so
   *  no two rows here can ever disagree about it. Null when nobody has just
   *  launched. */
  launched: { heatNumber: number; sessionId: string | null } | null;
  /** Whether the lane is still held. Also from the column, so the Holding row's
   *  badge and the On-track row's press read one value. */
  holdLive: boolean;
  nowMs: number;
  locked: boolean;
  pending: string | null;
  cameraExpanded: boolean;
  onExpandCamera: () => void;
  /** Mints the holding preview's live stream — see HoldingCamera. */
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  /** The desk-wide "Live video" / "Stills" choice. */
  liveCameras: boolean;
  onRaceReturned: () => void;
}) {
  /**
   * Has this group been seen to take the green flag? Matched on session id when
   * we have one and heat number otherwise — never on heat number alone if an id
   * is available, because heat numbers collide across tracks (27 of them on
   * 2026-08-14) and this decides whether a row empties.
   *
   * Checked per slot rather than "launched ⇒ blank both": a group already in the
   * karts can have gone green while a NEW group sits in the seats behind them,
   * and blanking both would erase the group staff just sent over.
   */
  const isLaunched = (g: { sessionId: string; heatNumber: number | null } | null | undefined) =>
    !!g &&
    !!launched &&
    (launched.sessionId != null
      ? g.sessionId === launched.sessionId
      : g.heatNumber === launched.heatNumber);

  const holding = isLaunched(lane?.holding) ? null : (lane?.holding ?? null);
  const karts = isLaunched(lane?.karts) ? null : (lane?.karts ?? null);
  const racing = lane?.racing ?? null;
  const pitIn = lane?.pitIn ?? null;

  const heldMs = holding ? Math.max(0, nowMs - holding.atMs) : 0;
  const kartsMs = karts ? Math.max(0, nowMs - karts.atMs) : 0;

  /** The pill, per row — see RoomPill for why it is Mega-only. Each slot's OWN
   *  room: on a busy night these four hold four groups briefed in two rooms. */
  const pillRoom = (g: { room: BriefingRoom | null } | null | undefined) =>
    track === "mega" ? (g?.room ?? null) : null;

  // WHO IS OUT. The green-flag verdict is the fresher of the two — the desk sees
  // a counting clock before any marker reaches the lane.
  const outHeat = launched?.heatNumber ?? racing?.heatNumber ?? null;

  /**
   * ...AND WHOSE ROOM THAT IS. The verdict above can name a group the lane has
   * not promoted out of the seats yet, so the room has to come from the slot
   * that same session is still sitting in. Reading `racing.room` regardless
   * would pill this row with the room of the group BEFORE them.
   */
  const launchedSessionId = launched?.sessionId ?? null;
  const launchedHeat = launched?.heatNumber ?? null;
  const outGroup = launched
    ? ([lane?.karts, lane?.holding, racing].find(
        (g) =>
          g != null &&
          (launchedSessionId != null
            ? g.sessionId === launchedSessionId
            : g.heatNumber === launchedHeat),
      ) ?? null)
    : racing;

  // Does the live clock belong to the group we are naming? On a shared circuit
  // it might be someone else's heat, and a clock against the wrong session is
  // worse than no clock.
  const liveHeat = liveClock ? liveHeatNumber(liveClock.heatName) : null;
  const clockIsOurs = !!liveClock && liveHeat != null && outHeat != null && liveHeat === outHeat;

  // The group in the pit, and how long they have been waiting on their
  // announcement. A separate row now, so the heat on track and the heat rolling
  // in behind it are two lines rather than two meanings of one.
  const sinceFinishMs = pitIn ? Math.max(0, nowMs - (pitIn.finishedAtMs ?? pitIn.atMs)) : 0;

  /**
   * THE BADGES DESCRIBE THEIR OWN ROW (owner 2026-08-14: "why do we see an on
   * track in holding when that area is free?"). Holding says what the SEATS are,
   * In karts what the KARTS are, On track what the CIRCUIT is. None of them
   * borrows another row's state.
   */
  // EMPTY, NOT "FREE" (owner 2026-08-14: "why is one free and one empty, use
  // same terms"). Two rows one line apart described the same fact — nobody is
  // standing here — in two different words, which reads as two different states
  // to anyone scanning the rail rather than reading it.
  const holdingBadge = holdLive
    ? { label: "LANE HELD", tone: DANGER }
    : holding
      ? { label: "CLEAR TO SEAT", tone: GREEN }
      : { label: "EMPTY", tone: PORTAL_DARK.muted };

  // Green, like CLEAR TO SEAT — "they are in and waiting on the flag" is good
  // news of the same kind. Deliberately NOT the room colour: red is one keystroke
  // from DANGER on this palette and a staff alarm must never be readable as a
  // room's identity.
  const kartsBadge = karts
    ? { label: "IN THE KARTS", tone: GREEN }
    : { label: "EMPTY", tone: PORTAL_DARK.muted };

  /**
   * ON TRACK NO LONGER BORROWS THE PIT'S STATE (owner 2026-08-15: "on track only
   * is when they're really out on track"). It used to read KARTS COMING IN about
   * a group that had finished, because a finished race had nowhere else to be.
   * That group has their own row now, so this one describes the circuit and
   * nothing else.
   */
  const trackBadge =
    clockIsOurs && liveClock?.state === "paused"
      ? { label: "PAUSED", tone: AMBER }
      : outHeat != null
        ? { label: "RACING", tone: GREEN }
        : { label: "TRACK CLEAR", tone: PORTAL_DARK.muted };

  // The pit: occupied means an announcement is owed, which is the one state on
  // this rail with a press attached and the one that wants the eye.
  const pitInBadge = pitIn
    ? { label: "POST OWED", tone: DANGER }
    : { label: "EMPTY", tone: PORTAL_DARK.muted };

  const nothingOut = !holding && !karts && outHeat == null && !pitIn;

  /**
   * THE LANE ITSELF, beside whatever the rows are saying — INCLUDING when they
   * are saying nothing (owner 2026-08-17: "always show the holding cams, don't
   * collapse that section").
   *
   * The rows collapse to one line when nothing is out, and the camera used to
   * collapse with them, so the view of the seats vanished exactly when it was
   * the only way to know whether anyone had wandered into them. An empty rail
   * is a claim about the seats; the picture is what checks it.
   *
   * The rows still collapse. Only the camera is exempt.
   */
  const holdingCam = (
    <div style={{ flex: "0 0 auto", width: CAM_W, maxWidth: "100%" }}>
      <HoldingCamera
        target={holdingCameraFor(room)}
        label={`${cap(room)} holding`}
        paused={cameraExpanded}
        onExpand={onExpandCamera}
        accent={color}
        getLiveUrl={getLiveUrl}
        liveCameras={liveCameras}
      />
    </div>
  );

  return (
    <Panel
      label="Out of the room"
      // The hold is the one state on this box that wants the eye. A staged group
      // on a clear lane is good news and gets no border colour at all.
      alert={holdLive ? "late" : "none"}
      accent={holdLive ? DANGER : holding || karts ? GREEN : outHeat != null ? color : undefined}
    >
      {nothingOut ? (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              display: "flex",
              alignItems: "baseline",
              gap: 18,
              flexWrap: "wrap",
              padding: "3px 0 2px",
            }}
          >
            {["Holding", "In karts", "On track", "Pit in"].map((s) => (
              <span
                key={s}
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                  color: PORTAL_DARK.muted,
                }}
              >
                {s}
                <b style={{ color: withAlpha(INK, 0.45), marginLeft: 6 }}>—</b>
              </span>
            ))}
          </div>
          {holdingCam}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
            {/* ── HOLDING ── */}
            <StageRow
              first
              stage="Holding"
              badge={holdingBadge}
              who={
                holding ? (
                  <>
                    <div
                      style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}
                    >
                      {/* TRACK COLOUR ON THE SESSION NUMBER, here and on every
                          rail row below: heat numbers are per-track, so two
                          "Session 52"s can be on screen at once. Identity colour
                          on identity data — the same rule the briefing log uses
                          for room names (owner 2026-08-23). */}
                      <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color }}>
                        {holding.heatNumber != null
                          ? `Session ${holding.heatNumber}`
                          : "In the seats"}
                      </span>
                      {holding.raceType && (
                        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                          {holding.raceType}
                        </span>
                      )}
                      <RoomPill room={pillRoom(holding)} />
                    </div>
                    {/* NO PROSE ON AN OCCUPIED ROW. "Hold them — karts are still
                        coming into the lane" said in a sentence what the LANE
                        HELD badge beside it, the red flashing border around it,
                        and the KARTS COMING IN row below it were already all
                        saying at once. */}
                  </>
                ) : (
                  <EmptyStage />
                )
              }
              clock={
                holding ? (
                  <Stat
                    label="In the seats"
                    value={formatClock(heldMs)}
                    tone={holdLive ? AMBER : GREEN}
                  />
                ) : undefined
              }
            />

            {/* ── IN KARTS ── the stage between the seats and the green flag.
                Skippable: a group may go straight from Holding to On track, and
                on a night when nothing fires the pre-message this row simply
                reads EMPTY all evening. */}
            <StageRow
              stage="In karts"
              badge={kartsBadge}
              who={
                karts ? (
                  <>
                    <div
                      style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}
                    >
                      <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color }}>
                        {karts.heatNumber != null ? `Session ${karts.heatNumber}` : "In the karts"}
                      </span>
                      {karts.raceType && (
                        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                          {karts.raceType}
                        </span>
                      )}
                      <RoomPill room={pillRoom(karts)} />
                    </div>
                  </>
                ) : (
                  <EmptyStage />
                )
              }
              clock={
                karts ? (
                  /* Not "In the karts" a third time — the stage label and the
                     badge both already say it. The clock names what the wait is
                     FOR, the way Holding's trio does (owner 2026-08-23). */
                  <Stat label="Waiting on green" value={formatClock(kartsMs)} tone={GREEN} />
                ) : undefined
              }
            />

            {/* ── ON TRACK ── */}
            <StageRow
              stage="On track"
              badge={trackBadge}
              who={
                outHeat != null ? (
                  <>
                    <div
                      style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}
                    >
                      <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color }}>
                        Session {outHeat}
                      </span>
                      <RoomPill room={pillRoom(outGroup)} />
                    </div>
                  </>
                ) : (
                  <EmptyStage />
                )
              }
              clock={
                clockIsOurs && liveClock ? (
                  <Stat
                    label={liveClock.state === "paused" ? "Paused at" : "Time left"}
                    value={formatRemaining(liveClock.remainingMs)}
                    tone={liveClock.state === "paused" ? AMBER : color}
                  />
                ) : undefined
              }
            />

            {/* ── PIT IN ── the stage the lane was missing (owner 2026-08-15:
                "the inbound race that is still sitting in karts waiting for post
                announcements gets cleared by the race that is sent to track").
                A returning group had nowhere to be but the racing slot, so the
                next group going out overwrote them. They own a row now, and the
                press that clears them sits on it. */}
            <StageRow
              stage="Pit in"
              badge={pitInBadge}
              who={
                pitIn ? (
                  <>
                    <div
                      style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}
                    >
                      <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color }}>
                        {pitIn.heatNumber != null ? `Session ${pitIn.heatNumber}` : "In the pit"}
                      </span>
                      {pitIn.raceType && (
                        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                          {pitIn.raceType}
                        </span>
                      )}
                      <RoomPill room={pillRoom(pitIn)} />
                    </div>
                  </>
                ) : (
                  <EmptyStage />
                )
              }
              clock={
                pitIn ? (
                  <Stat label="Waiting" value={formatClock(sinceFinishMs)} tone={AMBER} />
                ) : undefined
              }
              end={
                pitIn ? (
                  <ActionButton
                    tone={AMBER}
                    textColor="#1a1205"
                    size="md"
                    pendingKey={`pitted:${track}`}
                    pending={pending}
                    disabled={locked}
                    pendingLabel="Marking…"
                    title="The karts are fully back in the lane — the manual stand-in for the post-race announcement"
                    onClick={onRaceReturned}
                  >
                    ⏎ Race returned
                  </ActionButton>
                ) : undefined
              }
            />
          </div>

          {holdingCam}
        </div>
      )}
    </Panel>
  );
}

/* ── the in-room body ──────────────────────────────────────────────────── */

function InRoom({
  room,
  color,
  state,
  timeline,
  nowMs,
  locked,
  pending,
  cameraExpanded,
  onExpandCamera,
  getLiveUrl,
  liveCameras,
  alert,
  holdingBlockedBy,
  onStart,
  onUndo,
  onSendHolding,
}: {
  room: BriefingRoom;
  color: string;
  state: BriefingRoomState | null;
  timeline: BriefingTimeline;
  nowMs: number;
  locked: boolean;
  pending: string | null;
  cameraExpanded: boolean;
  onExpandCamera: () => void;
  /** Mints the room preview's live stream — see RoomCamera. */
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  /** The desk-wide "Live video" / "Stills" choice. */
  liveCameras: boolean;
  /** How overdue the wait for Start is — the box is already flashing, so the
   *  number itself follows rather than staying a calm amber under a red border. */
  alert: AlertLevel;
  /**
   * Who is ALREADY in the pit seats and has not gone out — the group this press
   * would evict. Null when the seats are free.
   *
   * Read from the RESOLVED lane, which is what makes it self-clearing: resolve
   * promotes a group out of `holding` the moment they take the track, and moves
   * them to `karts` when they climb in. So the button unblocks on its own the
   * instant the seats are genuinely empty — no second press, no timer.
   */
  holdingBlockedBy: number | null;
  onStart: (restart: boolean) => void;
  onUndo: () => void;
  onSendHolding: () => void;
}) {
  const phase = timeline.phase;
  const running = phase === "video" || phase === "helmet";
  const pct =
    timeline.videoMs > 0 ? Math.min(100, (timeline.videoOffsetMs / timeline.videoMs) * 100) : 0;
  const waitingMs = state ? Math.max(0, nowMs - state.triggeredAtMs) : 0;
  // The ten seconds Start is held for after a send, so the film cannot start
  // before the group has left the desk. Ticks with nowMs.
  const holdMs = startHoldRemainingMs(state, nowMs);
  /** How long since the film finished — the helmet phase has no end of its own
   *  any more, so this is what the readout counts up. */
  const waitingSinceFilmMs = state ? waitingMs - timeline.videoMs : 0;
  /** The film is still playing, so the group is not going anywhere yet. */
  const filmRunning = phase === "video";

  return (
    // CONTENT HEIGHT, NOT PANEL HEIGHT. This wrapper used to take the panel's
    // growth so the row inside could stay as tall as the picture; with four boxes
    // the panel no longer grows at all, so there is nothing to absorb and the
    // box is exactly as tall as what is in it.
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 16,
          flexShrink: 0,
          // Wraps to stacked when the panel is too narrow for both halves — a
          // squeezed 40px timer is worse than a camera under it.
          flexWrap: "wrap",
          alignItems: "stretch",
        }}
      >
        {/* LEFT — the session and the clocks. The reason the board exists. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            flex: "1 1 220px",
            minWidth: 200,
          }}
        >
          {phase === "idle" ? (
            <EmptyStage />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color: INK }}>
                  {state?.heatNumber != null ? `Session ${state.heatNumber}` : "Briefing"}
                </span>
                {state?.raceType && (
                  <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{state.raceType}</span>
                )}
                {state?.tier && (
                  <span style={{ fontSize: 11, color: PORTAL_DARK.muted }}>
                    · {state.tier} film
                  </span>
                )}
              </div>

              {phase === "waiting" && (
                <>
                  {/* THE CLOCK AND ITS CONTROLS ON ONE LINE (owner 2026-08-13:
                      "organize buttons and such a bit more to use less space").
                      Four boxes now share this column, and Waiting used to spend
                      three full rows — the number, a sentence, then a button
                      row — on what is one thought: it has been this long, press
                      this. The buttons sit at the end of the number's own row. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-end",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <Stat
                      label="Waiting"
                      value={formatClock(waitingMs)}
                      unit={
                        alert === "late"
                          ? "since sent — start it now"
                          : alert === "warn"
                            ? "since sent — running long"
                            : "since sent"
                      }
                      tone={alert === "late" ? DANGER : AMBER}
                      big
                    />
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        marginLeft: "auto",
                        paddingBottom: 2,
                      }}
                    >
                      <ActionButton
                        tone={GREEN}
                        textColor="#052e14"
                        size="lg"
                        pendingKey={`start:${room}`}
                        pending={pending}
                        disabled={locked}
                        holdSeconds={startHoldSeconds(holdMs)}
                        pendingLabel="Starting…"
                        title={
                          holdMs > 0
                            ? "Held for 10 seconds after the send — fetch the group from check-in first"
                            : undefined
                        }
                        onClick={() => onStart(false)}
                      >
                        ▶ Start video
                      </ActionButton>
                      <ActionButton
                        size="sm"
                        pendingKey={`clear:${room}`}
                        pending={pending}
                        disabled={locked}
                        pendingLabel="Undoing…"
                        onClick={() => {
                          if (window.confirm(`Undo the send to the ${room} room?`)) onUndo();
                        }}
                      >
                        Undo
                      </ActionButton>
                    </div>
                  </div>
                  {/* Only the lines that CHANGE what staff do survive as prose:
                      the ten-second hold, and a tier with no film. "TV is holding
                      a take-a-seat board" was true of every send and told nobody
                      anything they could act on. */}
                  {/* The hold explains itself ON the button, which counts down
                      in its own face; only the missing-film case survives,
                      because that one changes what the press will DO. */}
                  {!state?.videoUrl && (
                    <p style={{ fontSize: 11, color: PORTAL_DARK.muted, margin: 0 }}>
                      No film for this tier — Start skips to helmet sizes.
                    </p>
                  )}
                </>
              )}

              {running && (
                <>
                  {/* THE TIMING ROW. */}
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                    {phase === "video" ? (
                      <>
                        <Stat
                          label="Elapsed"
                          value={formatClock(timeline.videoOffsetMs)}
                          unit={`of ${formatClock(timeline.videoMs)}`}
                          big
                        />
                        <Stat
                          label="Left"
                          value={timeline.nextInMs != null ? formatClock(timeline.nextInMs) : "—"}
                          unit="of the film"
                          big
                          tone={color}
                        />
                      </>
                    ) : (
                      /* THE FILM IS DONE AND NOTHING IS COUNTING. This used to
                         read "Left … until the room is free" against a 30-second
                         helmet timer; the room no longer frees itself, so what
                         staff need is how long the group has been standing there
                         waiting to be sent to the seats. */
                      <Stat
                        label="Helmets"
                        value={formatClock(Math.max(0, waitingSinceFilmMs))}
                        unit="since the film ended"
                        big
                        tone={color}
                      />
                    )}
                  </div>

                  {/* THE BOTTOM RAIL, flush with the bottom of the camera frame
                    (owner 2026-08-12: "status bar should align to bottom of video
                    so it looks even"). Progress, its caption and Restart are ONE
                    bottom-anchored block rather than three things drifting up the
                    column: the row is only ever as tall as the picture, so a lone
                    `marginTop: auto` on the button left the bar floating in the
                    middle with a gap under it. */}
                  <div
                    style={{
                      marginTop: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {phase === "video" && timeline.videoMs > 0 && (
                      <div
                        style={{
                          height: 6,
                          borderRadius: 999,
                          background: "rgba(255,255,255,0.09)",
                          overflow: "hidden",
                        }}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(pct)}
                        aria-label="Briefing video progress"
                      >
                        <div
                          style={{
                            width: `${pct}%`,
                            height: "100%",
                            background: color,
                            transition: "width 1s linear",
                          }}
                        />
                      </div>
                    )}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      {/* JUST THE NUMBER. "then helmet sizes, then send them
                          out" narrated a sequence the two controls beside it
                          already describe, and it was long enough to push those
                          controls onto a line of their own — a whole row of
                          column height spent on a sentence that is wallpaper by
                          the second heat of a shift. */}
                      {phase === "video" && timeline.videoMs > 0 && (
                        <span className="rc-num" style={{ fontSize: 10, color: PORTAL_DARK.muted }}>
                          {Math.round(pct)}%
                        </span>
                      )}
                      <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                        <ActionButton
                          size="sm"
                          tone={color}
                          pendingKey={`restart:${room}`}
                          pending={pending}
                          disabled={locked}
                          pendingLabel="Restarting…"
                          onClick={() => onStart(true)}
                          title="Play from the top — latecomers, or a second showing"
                        >
                          ⟲ Restart video
                        </ActionButton>
                        {/* PHASE THREE (owner 2026-08-13): the group walks out
                            to the pit seats. Frees this room for the returning
                            race and flips the pit board's rail to seat them —
                            without un-briefing the session the way Undo does.

                            NOT WHILE THE FILM IS PLAYING (owner 2026-08-14: "send
                            to holding should not be available till video is
                            over"). The safety briefing is the one thing this room
                            exists to deliver, and a group sent to the seats
                            part-way through it has not had it. Disabled rather
                            than hidden, so staff can see the next step coming and
                            the row does not reflow when the film ends. */}
                        <ActionButton
                          size="sm"
                          tone={GREEN}
                          textColor="#052e14"
                          pendingKey={`holding:${room}`}
                          pending={pending}
                          disabled={
                            locked || !state?.sessionId || filmRunning || holdingBlockedBy != null
                          }
                          pendingLabel="Sending…"
                          onClick={onSendHolding}
                          title={
                            holdingBlockedBy != null
                              ? `Session ${holdingBlockedBy} is still in the pit seats — this unlocks the moment they move to the karts`
                              : filmRunning
                                ? "The safety film is still playing — this unlocks when it finishes"
                                : "The group is leaving for the pit seats — frees this room and tells the pit board to seat them"
                          }
                        >
                          {holdingBlockedBy != null
                            ? `Seats busy · Session ${holdingBlockedBy}`
                            : "➜ Send to holding"}
                        </ActionButton>
                      </span>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* RIGHT — the live room (owner: "camera view on the in-room section").
            Shown in every phase, idle included, so staff can watch a room fill
            before the send; backed by the same frame proxy the TV boards use. */}
        <div style={{ flex: "0 0 auto", width: CAM_W, maxWidth: "100%" }}>
          <RoomCamera
            room={room}
            paused={cameraExpanded}
            onExpand={onExpandCamera}
            getLiveUrl={getLiveUrl}
            liveCameras={liveCameras}
          />
        </div>
      </div>

      {/* THE DIAGNOSIS, ACROSS THE BOTTOM OF THE BOX (owner 2026-08-12: "add text
          at the bottom — video never started for session #"). A flashing border
          says something is wrong; this says WHAT, and about WHICH session, so a
          manager walking past the desk needs no interpretation. It names the
          session because at 5 minutes overdue the group in the room and the group
          on the board are not always the same thought. */}
      {alert !== "none" && (
        <div
          style={{
            // NOT bottom-anchored. It used to be `marginTop: auto` inside a
            // panel that stretched, which parked it at the foot of the box with
            // a hand's width of nothing above it (owner 2026-08-14: "video never
            // started is wasting space, move it up"). It belongs under the clock
            // it is about.
            paddingTop: 2,
            display: "flex",
            alignItems: "center",
            gap: 6,
            // Smaller than it was: it names the session for a manager walking
            // past (owner 2026-08-12), but the box is already flashing and the
            // Waiting clock beside it is already red and already says "start it
            // now" — so this is the caption on an alarm, not the alarm.
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.01em",
            color: alert === "late" ? DANGER : AMBER,
          }}
        >
          <IconAlertTriangleFilled size={13} aria-hidden />
          {alert === "late" ? "Video never started for " : "Video not started yet for "}
          {state?.heatNumber != null ? `Session ${state.heatNumber}` : "this group"}
        </div>
      )}
    </div>
  );
}

/* ── the camera ───────────────────────────────────────────────────────── */

/**
 * A briefing-room camera as a still-refresh, from the same /api/tv/camera proxy
 * the TV boards use, addressed by ROOM (the server maps the room to one
 * allowlisted device — the client never names a camera).
 *
 * DOUBLE-BUFFERED: each frame is decoded off-screen and only swapped in on load,
 * so the picture never blanks between pulls. A run of failures greys the last good
 * frame and says so, rather than showing a broken-image icon.
 *
 * CADENCE IS THE CALLER'S CHOICE, because the two views want different things: a
 * 300px preview only has to show that a room has filled (1s is plenty), while the
 * full-screen viewer is somebody actually WATCHING the room and wants motion.
 * Either way the real rate is bounded by the round trip — the next pull is only
 * ever queued once the previous frame has decoded, so a slow relay throttles this
 * naturally instead of piling requests up behind each other.
 *
 * `enabled` exists so the small preview can stand down while the full-screen
 * viewer has the same room open. The proxy's frame cache is keyed by device AND
 * size, so two pollers at two sizes are two upstream pulls at the camera.
 */
function useCameraFrame(room: CameraTarget, width: number, enabled: boolean, cadenceMs = 1_000) {
  // The shared still-poller carries every rule this hook used to own: the
  // room-switch "a new camera must not wear the old one's picture" derivation
  // (owner 2026-08-12), the double-buffered decode, the failure backoff — and
  // adds the hang watchdog plus one-live-blob memory behavior these previews
  // need on a desk PC that runs all shift. Room and width both live in the
  // base URL, so a change to either is a new camera as far as the frame key
  // is concerned, exactly as before.
  return useCameraStill(`/api/tv/camera?room=${room}&w=${width}`, cadenceMs, enabled, 6_000);
}

/** The frame itself — shared by the preview and the viewer so they can never
 *  disagree about what "offline" or "connecting" looks like. */
function CameraFrame({
  src,
  offline,
  alt,
  connectingSize,
  connectingLabel,
}: {
  src: string | null;
  offline: boolean;
  alt: string;
  connectingSize: number;
  /** What the blank state says. Defaults to the connecting copy; the viewer names
   *  the room it is loading, because a switch there is a deliberate act whose
   *  progress the staff member is waiting on. */
  connectingLabel?: string;
}) {
  if (!src) {
    // A span, not a div: this renders inside the preview BUTTON, and a button may
    // only contain phrasing content.
    return (
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: connectingSize,
          color: PORTAL_DARK.muted,
        }}
      >
        {connectingLabel ?? "Connecting to camera…"}
      </span>
    );
  }
  return (
    // A live proxied frame with a cache-busting query, not a static asset
    // next/image can optimize.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "contain",
        filter: offline ? "grayscale(0.6) brightness(0.6)" : "none",
      }}
    />
  );
}

/**
 * The small in-panel preview. It is a BUTTON, not a picture: the whole frame opens
 * the viewer, because 300px of fisheye is enough to see that a room has people in
 * it and not enough to see anything about them.
 *
 * AND IT SAYS SO WITHOUT BEING TOUCHED — pill on the frame, caption under it, ring
 * around it. See the .rc-cam rules; the desk monitor is a touch screen with no
 * hover, so nothing about "you can click this" may depend on a pointer.
 */
function RoomCamera({
  room,
  paused,
  onExpand,
  getLiveUrl,
  liveCameras,
}: {
  room: BriefingRoom;
  /** Viewer has this room open — hold the last frame, stop pulling. */
  paused: boolean;
  onExpand: () => void;
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  /** The desk's server-wide choice: video, or a picture a second. False leaves
   *  this tile exactly as it was before live existed. */
  liveCameras: boolean;
}) {
  // THE TILE IS LIVE NOW, NOT A PICTURE A SECOND (owner 2026-08-16: "I want a
  // live view"). 480p because that is what MOVES — 720p is the camera's 2fps
  // substream, and the tile is ~208px wide, so 640x480 is already twice the
  // picture the box can show. See live-resolution.ts for the measurements.
  const live = useLiveCamera(room, getLiveUrl, {
    enabled: !paused && liveCameras,
    resolution: MOTION_RESOLUTION,
    recycleMs: LIVE_RECYCLE_MS,
  });
  // STILLS REMAIN THE FLOOR. They paint while the ticket is minted and the
  // stream buffers, take the picture back the moment live stalls or dies, and
  // are all there is if Nx refuses a stream at all — the tile is never worse
  // than it was before this. They stand down once video is actually playing, so
  // a live tile costs no proxy pulls rather than paying for both pictures.
  const { src, offline } = useCameraFrame(room, 640, !paused && !live.playing);

  return (
    <button
      type="button"
      className="rc-cam"
      onClick={onExpand}
      title={`Enlarge the ${room} room camera`}
      aria-label={`Enlarge the ${room} room camera`}
    >
      {/* 4:3 — the room sensors are 2592x1944, and a 16:9 box pillarboxed them. */}
      <span className="rc-cam-shot" style={{ aspectRatio: "4 / 3" }}>
        <span style={{ opacity: live.playing ? 0 : 1 }}>
          <CameraFrame
            src={src}
            offline={offline}
            alt={`${room} briefing room`}
            connectingSize={11}
          />
        </span>
        {live.url && (
          // No `controls`, so this stays non-interactive content and remains
          // legal inside the button — and `pointer-events: none` guarantees the
          // click lands on the button whatever a browser thinks of a <video>.
          <video
            key={live.url}
            ref={teardownLiveVideoRef}
            src={live.url}
            autoPlay
            muted
            playsInline
            onPlaying={live.onPlaying}
            onWaiting={live.onWaiting}
            onStalled={live.onWaiting}
            onError={(e) => {
              live.onFailure("error", e.currentTarget);
              live.retry();
            }}
            onEnded={(e) => {
              live.onFailure("ended", e.currentTarget);
              live.retry();
            }}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity: live.playing ? 1 : 0,
              pointerEvents: "none",
            }}
          />
        )}
        <span
          className="rc-cam-chip"
          aria-hidden
          style={{
            position: "absolute",
            top: 7,
            right: 7,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 9px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.06em",
          }}
        >
          <IconMaximize size={12} stroke={2.6} />
          CLICK TO ENLARGE
        </span>
        {/* Liveness bottom-left, INSIDE the frame. It used to be a caption under
            the picture, which made the camera column taller than the picture and
            left the left-hand column's bottom rail aligned to nothing (owner
            2026-08-12: "so it looks even"). On the frame, the column's height IS
            the frame's height. */}
        <span
          className="rc-cam-live"
          style={{
            position: "absolute",
            bottom: 7,
            left: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "3px 8px",
            borderRadius: 999,
            background: "rgba(8,12,20,0.78)",
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.06em",
            color: offline ? AMBER : PORTAL_DARK.muted,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: offline ? AMBER : GREEN,
            }}
          />
          {/* THE WORD MATCHES THE PICTURE. This said LIVE over a 1fps still
              refresh before there was any video behind it; now it says which
              one you are actually looking at, so a staff member judging motion
              in the room knows whether motion is something this box can show. */}
          {offline
            ? "RECONNECTING…"
            : paused
              ? "IN THE VIEWER"
              : `${live.playing ? "LIVE" : "STILLS"} · ${room.toUpperCase()}`}
        </span>
      </span>
    </button>
  );
}

/**
 * The holding-area preview.
 *
 * Same button-shaped, click-to-enlarge frame as the room camera, with two
 * differences that both come from the picture being DEWARPED:
 *
 *  • IT POLLS AT 2s, NOT 1s. A dewarped still is transcoded out of an MJPEG
 *    stream (see fetchDewarpedFrame) and measured ~0.9s against ~0.2s for a raw
 *    room frame. Asking every second would simply queue — the hook only requests
 *    the next frame once the last has decoded, so the real effect would be a
 *    ragged cadence and twice the transcoding for no more information.
 *  • IT IS 960px WIDE, not 640. The dewarp is a crop out of a fisheye, so the
 *    detail that survives is what we ask the transcode for, not what the sensor
 *    has.
 */
function HoldingCamera({
  target,
  label,
  paused,
  onExpand,
  accent,
  getLiveUrl,
  liveCameras,
}: {
  target: CameraTarget;
  label: string;
  paused: boolean;
  onExpand: () => void;
  accent: string;
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  liveCameras: boolean;
}) {
  /**
   * HOLDING PLAYS TOO NOW (owner 2026-08-17), and the reason it did not is gone.
   *
   * This was left on stills deliberately: a dewarped view is a transcode on the
   * NVR whatever we ask for, and the mp4v streams it was answering with cost
   * ~590 KB/s at full size. With `videoCodec=h264` the same dewarped view is a
   * fifth of that, so the bandwidth argument for holding back no longer holds —
   * and the transcode session it costs is the same one the still refresh was
   * already paying for every two seconds.
   *
   * The desk's Stills setting still governs it, which is the real relief valve
   * if the NVR ever does struggle.
   */
  const live = useLiveCamera(target, getLiveUrl, {
    enabled: !paused && liveCameras,
    resolution: MOTION_RESOLUTION,
    recycleMs: LIVE_RECYCLE_MS,
  });
  // 640, not 960: the box is CAM_W wide, so even a 2x panel wants ~416px — and
  // every pixel here is transcoded, not merely resized (see fetchDewarpedFrame).
  // Stands down once video plays, and is the floor if it never does.
  const { src, offline } = useCameraFrame(target, 640, !paused && !live.playing, 2_000);

  return (
    <button
      type="button"
      className="rc-cam"
      onClick={onExpand}
      title={`Enlarge the ${label.toLowerCase()} camera`}
      aria-label={`Enlarge the ${label.toLowerCase()} camera`}
    >
      <span className="rc-cam-shot">
        <span style={{ opacity: live.playing ? 0 : 1 }}>
          <CameraFrame src={src} offline={offline} alt={label} connectingSize={11} />
        </span>
        {live.url && (
          <video
            key={live.url}
            ref={teardownLiveVideoRef}
            src={live.url}
            autoPlay
            muted
            playsInline
            onPlaying={live.onPlaying}
            onWaiting={live.onWaiting}
            onStalled={live.onWaiting}
            onError={(e) => {
              live.onFailure("error", e.currentTarget);
              live.retry();
            }}
            onEnded={(e) => {
              live.onFailure("ended", e.currentTarget);
              live.retry();
            }}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity: live.playing ? 1 : 0,
              pointerEvents: "none",
            }}
          />
        )}
        <span
          className="rc-cam-chip"
          aria-hidden
          style={{
            position: "absolute",
            top: 7,
            right: 7,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 9px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.06em",
          }}
        >
          <IconMaximize size={12} stroke={2.6} />
          CLICK TO ENLARGE
        </span>
        <span
          style={{
            position: "absolute",
            bottom: 7,
            left: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "3px 8px",
            borderRadius: 999,
            background: "rgba(8,12,20,0.78)",
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.06em",
            color: offline ? AMBER : PORTAL_DARK.muted,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: offline ? AMBER : accent,
            }}
          />
          {offline
            ? "RECONNECTING…"
            : paused
              ? "IN THE VIEWER"
              : `${live.playing ? "LIVE · " : ""}${label.toUpperCase()}`}
        </span>
      </span>
    </button>
  );
}

/**
 * The full-screen camera viewer (owner 2026-08-12: "need the ability to expand the
 * camera view to popup and see more").
 *
 * IT IS NOT JUST A BIGGER PICTURE. Staff expand the camera to answer a question
 * they are about to act on — is everyone seated, do they all have helmets — so the
 * viewer carries the phase, the clocks and the Start / Restart button. Closing it
 * to press a button on the panel behind it would defeat the point.
 *
 * ONE OVERLAY, EITHER ROOM: the header switches rooms in place, so a desk with one
 * monitor can watch Red then Blue without reopening anything.
 *
 * Esc, the ✕, and the backdrop all close it. The picture is capped by both axes so
 * a fisheye is never cropped and never overflows a short monitor.
 */
function CameraLightbox({
  target,
  track,
  state,
  holding,
  nowMs,
  locked,
  pending,
  onStart,
  onSwitch,
  onClose,
  getLiveUrl,
  liveCameras,
}: {
  target: CameraTarget;
  track: string;
  /** The briefing state, for a ROOM target. Null for a holding view. */
  state: BriefingRoomState | null;
  /** Who is in the seats, for a HOLDING target. Null for a room. */
  holding: PitLaneFeed["holding"];
  nowMs: number;
  locked: boolean;
  pending: string | null;
  onStart: (restart: boolean) => void;
  onSwitch: (target: CameraTarget) => void;
  onClose: () => void;
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  /** The desk-wide choice. False keeps this viewer on its 1600px stills, which
   *  is what it showed before live existed. */
  liveCameras: boolean;
}) {
  const room = isRoom(target) ? target : null;
  // The viewer is the one place someone is deliberately watching, so it buys the
  // sharp MOVING picture — 1440x1080 at ~19fps. It used to ask for 720p, which
  // Nx answers from the 2fps substream, so "LIVE" here was a slideshow.
  // No recycle: this overlay is opened, looked at, and closed.
  const live = useLiveCamera(target, getLiveUrl, {
    enabled: liveCameras,
    resolution: VIEWER_RESOLUTION,
  });
  // STILLS ARE THE BRIDGE, NOT THE FALLBACK ONLY. They paint in ~200ms while the
  // ticket is minted and the video buffers, then stand down the moment live is
  // actually playing — so the viewer is never blank waiting for video, and never
  // pays for two pictures of the same room at once.
  //
  // A holding still is transcoded and slower (see HoldingCamera), so it polls at
  // the same 2s here — it is only ever the bridge to live on this surface.
  const { src, offline } = useCameraFrame(target, 1600, !live.playing, room ? 1_000 : 2_000);
  const closeRef = useRef<HTMLButtonElement>(null);
  const color = room ? ROOM_COLOR[room] : ROOM_COLOR[holdingTrack(target as "holding-red")];
  const timeline = briefingTimelineAt(state, nowMs);
  const phase = timeline.phase;
  // The same hold the panel behind this viewer is showing — both read the room's
  // own send stamp, so Start cannot be live here and held there.
  const holdMs = startHoldRemainingMs(state, nowMs);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="rc-lb"
      role="dialog"
      aria-modal="true"
      aria-label={room ? `${cap(room)} room camera` : "Holding area camera"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "14px 18px 18px",
      }}
    >
      {/* THE BACKDROP IS A REAL BUTTON, UNDERNEATH. The obvious spelling — onClick
          on the overlay, stopPropagation on every child — is a click handler on a
          non-interactive div that no keyboard can reach, and it makes each control
          responsible for not closing the thing it sits in. One button behind the
          content closes on backdrop clicks, answers Enter/Space for free, and
          leaves the children with nothing to guard against. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close camera viewer"
        style={{
          position: "absolute",
          inset: 0,
          border: 0,
          background: "rgba(3,6,12,0.93)",
          cursor: "default",
        }}
      />

      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 18, color, letterSpacing: "0.02em" }}>
          {room ? `${cap(room).toUpperCase()} ROOM` : "HOLDING"}
        </strong>
        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{cap(track)} Track</span>
        {room ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.05em",
              color: phase === "idle" ? PORTAL_DARK.muted : phaseColor(phase, color),
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: phaseColor(phase, color),
              }}
            />
            {PHASE_LABEL[phase].toUpperCase()}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: PORTAL_DARK.muted }}>the pit seats</span>
        )}

        {/* ANY CAMERA, WITHOUT REOPENING. Four now rather than two — the rooms
            and each track's holding area — so a staff member can follow a group
            from the film to the seats without closing the viewer once. */}
        <span style={{ display: "inline-flex", gap: 6, marginLeft: 6, flexWrap: "wrap" }}>
          {(["red", "blue", "holding-red", "holding-blue"] as CameraTarget[]).map((t) => {
            const tone = isRoom(t) ? ROOM_COLOR[t] : ROOM_COLOR[holdingTrack(t)];
            const on = t === target;
            return (
              <button
                key={t}
                type="button"
                className="rcb"
                onClick={() => onSwitch(t)}
                aria-pressed={on}
                style={{
                  padding: "5px 12px",
                  borderRadius: 5,
                  fontSize: 11,
                  borderColor: on ? withAlpha(tone, 0.85) : PORTAL_DARK.border,
                  background: on ? withAlpha(tone, 0.18) : "transparent",
                  color: on ? INK : PORTAL_DARK.muted,
                }}
              >
                {isRoom(t) ? cap(t) : `${cap(holdingTrack(t))} holding`}
              </button>
            );
          })}
        </span>

        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 12 }}>
          {/* WHICH PICTURE THIS IS. A viewer that silently degrades to one frame a
              second would have staff reading a still as live and waiting for
              movement that is not coming. */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.05em",
              color: live.playing ? GREEN : PORTAL_DARK.muted,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: live.playing ? GREEN : PORTAL_DARK.muted,
                boxShadow: live.playing ? `0 0 8px ${GREEN}` : "none",
              }}
            />
            {live.playing ? "LIVE" : "STILLS · 1/SEC"}
          </span>
          {offline && !live.playing && (
            <span style={{ fontSize: 12, color: AMBER }}>Reconnecting…</span>
          )}
          <button
            ref={closeRef}
            type="button"
            className="rcb"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close camera viewer"
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 12,
              borderColor: PORTAL_DARK.border,
              background: "transparent",
              color: PORTAL_DARK.fg,
            }}
          >
            <IconX size={14} stroke={2.4} />
            Close
          </button>
        </span>
      </div>

      {/* The picture. Capped on both axes by the flex row, so a fisheye is never
          cropped and never overflows a short monitor. */}
      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          borderRadius: 10,
          overflow: "hidden",
          background: "#05070d",
          border: `1px solid ${withAlpha(color, 0.3)}`,
        }}
      >
        {/* The still, underneath — the first thing on screen and the thing that
            stays if live never arrives. Hidden rather than unmounted once video is
            playing, so a stream that drops has a picture to fall back to
            instantly. */}
        <span style={{ opacity: live.playing ? 0 : 1 }}>
          <CameraFrame
            src={src}
            offline={offline}
            alt={room ? `${room} briefing room, enlarged` : `${track} holding area, enlarged`}
            connectingSize={18}
            connectingLabel={
              room ? `Loading the ${room} room…` : `Loading the ${track} holding area…`
            }
          />
        </span>
        {live.url && (
          // A live CCTV feed: no audio track, nothing to caption.
          <video
            key={live.url}
            // Ref-callback CLEANUP (React 19): keyed on the ticket URL, this
            // element is replaced on every retry — tear the media pipeline
            // down when each one goes, or the detached players and their
            // buffers ride until GC. MODULE-LEVEL for a stable identity: an
            // inline arrow is a new callback every render, and React 19 runs
            // the old cleanup + re-attaches on every identity change — which,
            // on a panel that re-renders every second, tore the src off the
            // PLAYING element one second in and left a black viewer that
            // still said LIVE (React never re-writes an attribute it thinks
            // is already there, and a srcless load() fires no error).
            ref={teardownLiveVideoRef}
            src={live.url}
            autoPlay
            muted
            playsInline
            onPlaying={live.onPlaying}
            onWaiting={live.onWaiting}
            onStalled={live.onWaiting}
            onError={(e) => {
              live.onFailure("error", e.currentTarget);
              live.retry();
            }}
            onEnded={(e) => {
              live.onFailure("ended", e.currentTarget);
              live.retry();
            }}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity: live.playing ? 1 : 0,
            }}
          />
        )}
      </div>

      {/* The clocks and the one action worth having here. */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "flex-end",
          gap: 24,
          flexWrap: "wrap",
          flexShrink: 0,
          minHeight: 62,
        }}
      >
        {!room ? (
          // A holding view has no film and no phase — the one thing worth saying
          // is who is sitting there, and there is nothing to press from here
          // ("race returned" belongs on the board, beside the lane it clears).
          holding ? (
            <>
              <div>
                <div className="rc-num" style={{ fontSize: 22, fontWeight: 800, color: INK }}>
                  {holding.heatNumber != null ? `Session ${holding.heatNumber}` : "In the seats"}
                </div>
                <div style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                  {holding.raceType ?? ""}
                  {holding.room ? ` · from the ${holding.room} room` : ""}
                </div>
              </div>
              <Stat
                label="In the seats"
                value={formatClock(Math.max(0, nowMs - holding.atMs))}
                unit="since the briefing"
                big
                tone={color}
              />
            </>
          ) : (
            <span style={{ fontSize: 14, color: PORTAL_DARK.muted }}>
              Nobody in the seats on {cap(track)}.
            </span>
          )
        ) : phase === "idle" ? (
          <span style={{ fontSize: 14, color: PORTAL_DARK.muted }}>
            Nothing in this room — the TV is showing helmet sizes.
          </span>
        ) : (
          <>
            <div>
              <div className="rc-num" style={{ fontSize: 22, fontWeight: 800, color: INK }}>
                {state?.heatNumber != null ? `Session ${state.heatNumber}` : "Briefing"}
              </div>
              <div style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                {state?.raceType ?? ""}
                {state?.tier ? ` · ${state.tier} film` : ""}
              </div>
            </div>
            {phase === "waiting" ? (
              <Stat
                label="Waiting"
                value={formatClock(Math.max(0, nowMs - (state?.triggeredAtMs ?? nowMs)))}
                unit="since sent"
                tone={AMBER}
                big
              />
            ) : (
              <>
                {phase === "video" && (
                  <Stat
                    label="Elapsed"
                    value={formatClock(timeline.videoOffsetMs)}
                    unit={`of ${formatClock(timeline.videoMs)}`}
                    big
                  />
                )}
                <Stat
                  label="Left"
                  value={timeline.nextInMs != null ? formatClock(timeline.nextInMs) : "—"}
                  unit={phase === "video" ? "of the film" : "until the room is free"}
                  big
                  tone={color}
                />
              </>
            )}
            <span style={{ marginLeft: "auto" }}>
              {phase === "waiting" ? (
                <ActionButton
                  tone={GREEN}
                  textColor="#052e14"
                  size="lg"
                  pendingKey={`start:${room}`}
                  pending={pending}
                  disabled={locked}
                  holdSeconds={startHoldSeconds(holdMs)}
                  pendingLabel="Starting…"
                  title={
                    holdMs > 0
                      ? "Held for 10 seconds after the send — fetch the group from check-in first"
                      : undefined
                  }
                  onClick={() => onStart(false)}
                >
                  ▶ Start video
                </ActionButton>
              ) : (
                <ActionButton
                  size="sm"
                  tone={color}
                  pendingKey={`restart:${room}`}
                  pending={pending}
                  disabled={locked}
                  pendingLabel="Restarting…"
                  onClick={() => onStart(true)}
                  title="Play from the top — latecomers, or a second showing"
                >
                  ⟲ Restart video
                </ActionButton>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* ── pieces ───────────────────────────────────────────────────────────── */

/** A labelled number with its unit. The board is read at a glance, so the value is
 *  large and tabular and the words around it are small. */
function Stat({
  label,
  value,
  unit,
  tone,
  big,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: string;
  big?: boolean;
}) {
  return (
    <div style={{ minWidth: big ? 118 : 96 }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          color: PORTAL_DARK.muted,
        }}
      >
        {label}
      </div>
      <div
        className="rc-num"
        style={{
          fontSize: big ? 40 : 28,
          fontWeight: 800,
          lineHeight: 1.1,
          color: tone ?? INK,
        }}
      >
        {value}
      </div>
      {unit && <div style={{ fontSize: 10, color: PORTAL_DARK.muted }}>{unit}</div>}
    </div>
  );
}

function Panel({
  label,
  badge,
  accent,
  grow,
  flat,
  alert,
  ready,
  children,
}: {
  label: string;
  badge?: React.ReactNode;
  accent?: string;
  grow?: boolean;
  flat?: boolean;
  /** Overdue — the whole box flashes amber, then red. See the .rc-flash rules. */
  alert?: AlertLevel;
  /**
   * The good news — this box's job is DONE and staff can act. Flashes green.
   *
   * It OUTRANKS `alert` deliberately: the only thing the amber/red pulse is
   * counting down to on the Called box is the check-in window, and a heat whose
   * racers are all through the desk has answered that question. Leaving it red
   * would have the board still nagging about a deadline that no longer exists.
   */
  ready?: boolean;
  children: React.ReactNode;
}) {
  const flash = ready
    ? "rc-flash-ready"
    : alert === "late"
      ? "rc-flash-late"
      : alert === "warn"
        ? "rc-flash-warn"
        : undefined;
  return (
    <div
      className={flash}
      style={{
        border: `1px solid ${accent ? withAlpha(accent, 0.35) : PORTAL_DARK.border}`,
        background: flat ? "transparent" : PORTAL_DARK.card,
        borderRadius: 8,
        // Tighter than it was. Four boxes multiply every millimetre of chrome by
        // four, and padding is the cheapest thing to give back.
        padding: "7px 10px 9px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        ...(grow ? { flex: 1, minHeight: 0 } : { flexShrink: 0 }),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: PORTAL_DARK.muted,
          }}
        >
          {label}
        </span>
        {badge && <span style={{ marginLeft: "auto" }}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

/** One leg of the journey. A leg we cannot measure is a thin dash, never a
 *  zero — zero is a real answer here (a group sent the moment they were
 *  called) and must not be confused with "we do not know". */
function Leg({ ms, pending }: { ms: number | null; pending?: string }) {
  return (
    <span className="rc-num" style={{ minWidth: 66, color: ms != null ? INK : PORTAL_DARK.muted }}>
      {ms != null ? formatClock(ms) : (pending ?? "—")}
    </span>
  );
}

/**
 * ONE PA CUE, AND WHETHER IT SOUNDED.
 *
 * A played cue shows the clock time it played at, in green — it happened, and
 * the instant is the record. A cue that is OWED and has not played is amber and
 * says so in words: that is the state worth catching, because it means a group
 * is standing somewhere waiting for an announcement nobody made.
 *
 * A cue that is not owed yet is a plain dash. The distinction matters — a blank
 * because it is too early reads identically to a blank because it was missed,
 * and only one of those is a problem.
 */
function Cue({ atMs, owed }: { atMs: number | null; owed: boolean }) {
  if (atMs != null) {
    return (
      <span className="rc-num" style={{ minWidth: 72, color: GREEN }}>
        {clockTimeMs(atMs)}
      </span>
    );
  }
  return (
    <span className="rc-num" style={{ minWidth: 72, color: owed ? AMBER : PORTAL_DARK.muted }}>
      {owed ? "not played" : "—"}
    </span>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        border: `1px solid ${withAlpha(AMBER, 0.35)}`,
        background: withAlpha(AMBER, 0.08),
        fontSize: 12,
        color: INK,
      }}
    >
      {children}
    </div>
  );
}

/** A button that acknowledges its own press: only the in-flight one disables, and
 *  it is the one that spins. */
function ActionButton({
  children,
  onClick,
  tone,
  textColor,
  outline,
  size,
  pendingKey,
  pending,
  disabled,
  pendingLabel,
  title,
  holdSeconds,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: string;
  textColor?: string;
  outline?: boolean;
  size: "sm" | "md" | "lg";
  pendingKey: string;
  pending: string | null;
  disabled?: boolean;
  pendingLabel: string;
  title?: string;
  /** Extra classes on the button itself — the send-now pulse rides here. */
  className?: string;
  /**
   * Seconds until this button may be pressed — it disables itself and counts down
   * ON ITS OWN FACE ("Start video in 6s") rather than going quietly dead. 0 or
   * absent is a live button. See briefing/start-hold.ts.
   */
  holdSeconds?: number;
}) {
  const isPending = pending === pendingKey;
  const held = !isPending && (holdSeconds ?? 0) > 0;
  const pad = size === "lg" ? "11px 20px" : size === "md" ? "9px 16px" : "6px 12px";
  const font = size === "lg" ? 15 : size === "md" ? 13 : 11;
  const solid = !!tone && !outline && size !== "sm";
  return (
    <button
      type="button"
      className={[held ? "rcb rcb-hold" : "rcb", className].filter(Boolean).join(" ")}
      onClick={onClick}
      title={title}
      aria-busy={isPending}
      disabled={isPending || held || disabled === true}
      style={{
        padding: pad,
        borderRadius: 6,
        fontSize: font,
        background: solid ? tone : "transparent",
        borderColor: solid ? "transparent" : tone ? withAlpha(tone, 0.55) : PORTAL_DARK.border,
        color: solid ? (textColor ?? "#0b1220") : (tone ?? PORTAL_DARK.fg),
      }}
    >
      {isPending && <span aria-hidden className="rcb-spin" />}
      {isPending ? (
        pendingLabel
      ) : held ? (
        <>
          {children} in {holdSeconds}s
        </>
      ) : (
        children
      )}
    </button>
  );
}

function phaseColor(phase: BriefingPhase, roomColor: string): string {
  if (phase === "waiting") return AMBER;
  if (phase === "idle") return PORTAL_DARK.muted;
  return roomColor;
}

/** `m:ss`, ceiled — a timer reading 0:00 while a film still plays is worse than one
 *  that rounds up. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Venue-local wall time. VENUE TIME, not the desk PC's: a board reading a record
 *  in the browser's own zone would misdate an insurance answer on any machine
 *  whose clock is set wrong (the same trap the camera-monitor clock fell into). */
function clockTimeMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/New_York",
  });
}

/** The same venue-local wall time to the MINUTE. A scheduled slot is a minute-
 *  precision fact — printing "7:45:00 PM" for it reads as a measurement rather
 *  than the time on somebody's ticket. */
function clockMinuteMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}
