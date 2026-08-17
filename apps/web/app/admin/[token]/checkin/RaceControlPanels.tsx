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
import { useTrackStatus, type CurrentRace, type TrackInfo } from "@/hooks/useTrackStatus";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { briefingTimelineAt, type BriefingTimeline } from "~/features/signage/briefing/phase";
import {
  resolveFilmTier,
  tierForRaceType,
  type BriefingPhase,
  type BriefingRoom,
  type BriefingRoomState,
} from "~/features/signage/briefing/types";
import { pullIsLate } from "~/features/signage/briefing/pull-to-room";
import { punctuality } from "~/features/signage/track-delay";
import { liveHeatNumber } from "~/features/signage/briefing/room-return";
import {
  checkinAlert,
  waitingAlert,
  type AlertLevel,
} from "~/features/signage/briefing/desk-alerts";
import { startHoldRemainingMs, startHoldSeconds } from "~/features/signage/briefing/start-hold";
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
/* A staff alert must not be motion-only anyway: reduced motion keeps the colour
   and drops the pulse, so the box still reads as overdue. */
@media (prefers-reduced-motion: reduce) {
  .rc-flash-warn, .rc-flash-late, .rc-flash-ready { animation: none; }
  .rc-flash-warn { border-color: ${AMBER}; background-color: ${withAlpha(AMBER, 0.18)}; }
  .rc-flash-late { border-color: ${DANGER}; background-color: ${withAlpha(DANGER, 0.22)}; }
  .rc-flash-ready { border-color: ${GREEN}; background-color: ${withAlpha(GREEN, 0.16)}; }
}
`;

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
  checkedIn: number;
  total: number;
}

export default function RaceControlPanels({
  control,
  checkinCounts = [],
}: {
  control: BriefingControl;
  /**
   * HOW MANY OF THE HEAT ARE THROUGH THE DESK, moved down here from the top of
   * the board (owner 2026-08-12: "in board mode move the number checked in down
   * to the check-in areas"). It belongs beside the heat it counts — the Called
   * box already names that session — and it frees the top strip for the wait
   * times. Empty on any surface that does not poll it, which simply hides it.
   */
  checkinCounts?: CheckinCount[];
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
  // Only a ROOM has a briefing timeline; a holding view has no film and no
  // phase, so the viewer gets null and renders its holding half instead.
  const expandedStatus = expanded ? (board?.rooms.find((r) => r.room === expanded) ?? null) : null;

  /**
   * WHICH COLUMN OWNS A TRACK'S LANE.
   *
   * There is one pit lane per TRACK but two room columns, and on a Mega day both
   * rooms serve the one circuit — so a naive render would put the same holding
   * group, and the same "race returned" button, in both columns. The lane belongs
   * to the column whose room the group was briefed in (the holding record carries
   * it); with nobody in holding it falls to Red so the control still has a home.
   */
  const megaLaneOwner: BriefingRoom = board?.lanes?.mega?.holding?.room ?? "red";

  /**
   * WHICH ROOM THE NEXT MEGA SEND SHOULD GO TO — a suggestion, never a rule
   * (owner 2026-08-16: auto-suggest, staff confirms; the press stays the
   * assignment and the other button always works).
   *
   * One circuit feeding two rooms wants them leapfrogging: the free room takes
   * the heat, and when both are free the one that did NOT take the previous
   * group takes this one. "Previous group" is read off the mega lane's
   * furthest-along occupant — the same recorded facts the columns already
   * render. Both rooms busy = no suggestion: that send is a Replace, and
   * which film to interrupt is a human call.
   */
  const suggestedRoom: BriefingRoom | null = (() => {
    if (!megaEnabled) return null;
    const roomFree = (room: BriefingRoom) => {
      const st = board?.rooms.find((r) => r.room === room)?.state ?? null;
      return briefingTimelineAt(st, nowMs).phase === "idle";
    };
    const free = rooms.filter(roomFree);
    if (free.length === 0) return null;
    if (free.length === 1) return free[0];
    const megaLane = board?.lanes?.mega ?? null;
    const lastRoom =
      megaLane?.holding?.room ?? megaLane?.karts?.room ?? megaLane?.pitIn?.room ?? null;
    if (lastRoom === "red") return "blue";
    if (lastRoom === "blue") return "red";
    return "red";
  })();

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
          flex: 1,
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
              delay={findDelay(status?.trackStatus.tracks, track)}
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
              // 0 until the first poll lands — checkinAlert reads that as "no
              // deadline known", so a board still connecting never flashes at a
              // window it is guessing at.
              checkinWindowMins={board?.checkinWindowMins?.[track] ?? 0}
              locked={board?.enabled === false}
              pending={pending}
              expandedCamera={expanded}
              onExpandCamera={(target) => control.setExpandedCamera(target)}
              lane={board?.lanes?.[track as "blue" | "red" | "mega"] ?? null}
              ownsLane={!megaEnabled || room === megaLaneOwner}
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
  delay,
  status,
  proFilmMissing,
  videos,
  nowMs,
  checkinWindowMins,
  sentTo,
  checkedIn,
  locked,
  pending,
  expandedCamera,
  onExpandCamera,
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
  delay: TrackInfo | null;
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
  locked: boolean;
  pending: string | null;
  /** Which camera the full-screen viewer has open, if any — a preview whose own
   *  camera is up there stops pulling frames. */
  expandedCamera: CameraTarget | null;
  onExpandCamera: (target: CameraTarget) => void;
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
  const liveClock = useLiveSessionClock(track as TrackKey);
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
  /** ON TIME / n BEHIND / no reading — see the chip in the identity row. */
  const punctual = punctuality(delay);

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
  const sendLate = pullIsLate({
    remainingMs: liveClock?.remainingMs ?? null,
    pitInOccupied: !!lane?.pitIn,
    onTrack: !!liveClock || !!lane?.racing,
  });
  /** The film this heat will ACTUALLY get, and how long it runs — the second
   *  number the warning needs. Resolved through the Pro→Intermediate fallback so
   *  it quotes the film the room will really play. Null when none is uploaded. */
  const sendFilmMs = videos?.[resolveFilmTier(tier, (t) => !!videos?.[t]?.url)]?.durationMs ?? null;

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
   * celebrating a decision already taken. `total > 0` guards the empty roster —
   * 0/0 is "we do not know yet", not "everybody is here".
   */
  const gridComplete =
    !!race &&
    !sentTo &&
    !!checkedIn &&
    checkedIn.total > 0 &&
    checkedIn.checkedIn >= checkedIn.total;

  const calledAlert =
    race && !sentTo && checkingInMs != null
      ? checkinAlert(checkingInMs, checkinWindowMins)
      : "none";
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
  /**
   * WHICHEVER SLOT HOLDS THE GROUP WAITING ON THE GREEN — the karts if they have
   * climbed in, otherwise the seats. The SAME `karts ?? holding` rule the server
   * promotes on (resolveLane), because a desk that watched a different group than
   * the server did is a desk that disagrees with its own wall.
   *
   * Before In Karts this could only ever be `holding`. Reading only that now
   * would mean a group who reached the karts first never got its green-flag
   * verdict, and sat on the board until a finish marker happened to arrive.
   */
  const stagedGroup = lane?.karts ?? lane?.holding ?? null;
  const stagedHeat = stagedGroup?.heatNumber ?? null;
  const stagedSessionId = stagedGroup?.sessionId ?? null;
  const liveHeatNow = liveClock ? liveHeatNumber(liveClock.heatName) : null;
  const countingNow =
    stagedHeat != null &&
    liveHeatNow != null &&
    stagedHeat === liveHeatNow &&
    liveClock?.counting === true;

  /**
   * ONCE SEEN RACING, ALWAYS RACED. The clock only publishes while a heat is
   * running, so the verdict above evaporates the moment the flag drops — and the
   * group reappeared in seats they had long since left (owner 2026-08-14:
   * "session 64 both tracks when finished went back to holding state"). The lane
   * would normally have ended the claim on its finish marker, but that marker
   * rides the timing webhook and tonight has shown it does not always arrive.
   *
   * So the station remembers, above the scan flash, what it watched happen.
   */
  useEffect(() => {
    if (countingNow) noteLaunched(stagedSessionId);
  }, [countingNow, stagedSessionId, noteLaunched]);

  const launched =
    stagedHeat != null && (countingNow || hasLaunched(stagedSessionId))
      ? { heatNumber: stagedHeat, sessionId: stagedSessionId }
      : null;

  /**
   * IS THE LANE STILL HELD — i.e. is anybody in the pit with an announcement
   * still owed. The same rule the pit board's own rail runs (pitRailState in
   * pit/pit-board.ts), and it is now a single fact: a group sits in `pitIn`
   * from their chequered flag until their post cue clears them, so the slot
   * being occupied IS the hold. No pair of timestamps left to compare.
   */
  const holdLive = !!lane?.pitIn;

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
         * AND UNKNOWN IS NOT ON TIME. The old line read a track missing from the
         * feed as punctual; `punctuality` gives that its own verdict, so a board
         * that cannot see a track says so rather than vouching for it.
         */}
        <span
          style={{
            marginLeft: liveClock ? undefined : "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.04em",
            background:
              punctual.state === "late"
                ? withAlpha(AMBER, 0.16)
                : punctual.state === "on-time"
                  ? withAlpha(GREEN, 0.14)
                  : "transparent",
            border: `1px solid ${
              punctual.state === "late"
                ? withAlpha(AMBER, 0.55)
                : punctual.state === "on-time"
                  ? withAlpha(GREEN, 0.45)
                  : PORTAL_DARK.border
            }`,
            color:
              punctual.state === "late"
                ? AMBER
                : punctual.state === "on-time"
                  ? GREEN
                  : PORTAL_DARK.muted,
          }}
          title="How far behind schedule this track is running, from the venue's own delay figure"
        >
          {punctual.state === "unknown" ? "NO DELAY READING" : punctual.label.toUpperCase()}
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
      <Panel label="Called" flat alert={calledAlert} ready={gridComplete}>
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
              {checkedIn && (
                <Stat
                  label="Checked in"
                  value={`${checkedIn.checkedIn}/${checkedIn.total}`}
                  unit={
                    checkedIn.total > 0 && checkedIn.checkedIn >= checkedIn.total
                      ? "all here"
                      : `${Math.max(0, checkedIn.total - checkedIn.checkedIn)} still to scan`
                  }
                  tone={
                    checkedIn.total > 0 && checkedIn.checkedIn >= checkedIn.total
                      ? GREEN
                      : undefined
                  }
                />
              )}
              {/* TRACK DELAY MOVED TO THE IDENTITY ROW as an ON TIME / n BEHIND
                  chip — it is a fact about the track, not about this heat, and
                  down here it only existed while a heat happened to be waiting.
                  See the chip above. */}
            </div>

            {/* PULLING LATE — the same rule and the same five minutes the room
                tablets run (pull-to-room.ts), so the two boards cannot disagree
                about whether a group is being fetched too late. Amber, never
                red: red on this board means a missed deadline that costs a race,
                and a late send costs minutes. */}
            {sendLate && (
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
                <span style={{ fontSize: 12, lineHeight: 1.4 }}>
                  <b style={{ color: AMBER }}>
                    {liveClock && liveClock.remainingMs > 0
                      ? `${liveHeatNow != null ? `Session ${liveHeatNow}` : "The race"} ends in ${formatRemaining(liveClock.remainingMs)}.`
                      : "The track is waiting."}
                  </b>{" "}
                  {sendFilmMs
                    ? `The ${tier} film runs ${formatClock(sendFilmMs)} — send now and the track waits on the room.`
                    : "Send now and the film will still be running when the seats are wanted."}
                </span>
              </div>
            )}

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
                  {/* The leapfrog hint, on the room the rotation would pick.
                      Advice with the same authority as any other chip — the
                      other room's Send works exactly as it always has. */}
                  {suggested && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: withAlpha(MEGA, 0.2),
                        border: `1px solid ${withAlpha(MEGA, 0.6)}`,
                        color: MEGA,
                        whiteSpace: "nowrap",
                      }}
                    >
                      SUGGESTED
                    </span>
                  )}
                  <ActionButton
                    // Late reads amber the same way an occupied room does — the
                    // press is still yours to make, and the colour is the pause
                    // before you make it.
                    tone={occupied || sendLate ? AMBER : color}
                    outline={occupied}
                    textColor={sendLate && !occupied ? "#1c1204" : undefined}
                    size="md"
                    pendingKey={`send:${room}`}
                    pending={pending}
                    disabled={!race.sessionId || locked}
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
                      : sendLate
                        ? `Send to ${cap(room)} anyway →`
                        : `Send to ${cap(room)} →`}
                  </ActionButton>
                </span>
              )}
            </div>
          </>
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
          onRaceReturned={onRaceReturned}
        />
      )}
    </div>
  );
}

/* ── out of the room ───────────────────────────────────────────────────── */

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

  // WHO IS OUT. The green-flag verdict is the fresher of the two — the desk sees
  // a counting clock before any marker reaches the lane.
  const outHeat = launched?.heatNumber ?? racing?.heatNumber ?? null;

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

  return (
    <Panel
      label="Out of the room"
      // The hold is the one state on this box that wants the eye. A staged group
      // on a clear lane is good news and gets no border colour at all.
      alert={holdLive ? "late" : "none"}
      accent={holdLive ? DANGER : holding || karts ? GREEN : outHeat != null ? color : undefined}
    >
      {nothingOut ? (
        <>
          <div
            style={{
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
        </>
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
                      <span
                        className="rc-num"
                        style={{ fontSize: 20, fontWeight: 800, color: INK }}
                      >
                        {holding.heatNumber != null
                          ? `Session ${holding.heatNumber}`
                          : "In the seats"}
                      </span>
                      {holding.raceType && (
                        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                          {holding.raceType}
                        </span>
                      )}
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
                      <span
                        className="rc-num"
                        style={{ fontSize: 20, fontWeight: 800, color: INK }}
                      >
                        {karts.heatNumber != null ? `Session ${karts.heatNumber}` : "In the karts"}
                      </span>
                      {karts.raceType && (
                        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                          {karts.raceType}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <EmptyStage />
                )
              }
              clock={
                karts ? (
                  <Stat label="In the karts" value={formatClock(kartsMs)} tone={GREEN} />
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
                      <span
                        className="rc-num"
                        style={{ fontSize: 20, fontWeight: 800, color: INK }}
                      >
                        Session {outHeat}
                      </span>
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
                      <span
                        className="rc-num"
                        style={{ fontSize: 20, fontWeight: 800, color: INK }}
                      >
                        {pitIn.heatNumber != null ? `Session ${pitIn.heatNumber}` : "In the pit"}
                      </span>
                      {pitIn.raceType && (
                        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
                          {pitIn.raceType}
                        </span>
                      )}
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

          {/* THE LANE ITSELF, beside all three rows. Same still-refresh rail as
              the room cameras, but SLOWER: a dewarped frame comes off a
              transcode and takes about a second, where a room's raw frame takes
              a fifth of that. A 2-second preview is honest about that and still
              shows a group arriving; the full-screen viewer switches to live
              video, where the dewarp costs nothing because the stream is
              transcoded anyway. */}
          <div style={{ flex: "0 0 auto", width: CAM_W, maxWidth: "100%" }}>
            <HoldingCamera
              target={holdingCameraFor(room)}
              label={`${cap(room)} holding`}
              paused={cameraExpanded}
              onExpand={onExpandCamera}
              accent={color}
            />
          </div>
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
          <RoomCamera room={room} paused={cameraExpanded} onExpand={onExpandCamera} />
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
  /**
   * A NEW CAMERA MUST NOT WEAR THE OLD ONE'S PICTURE (owner 2026-08-12: "when you
   * switch between rooms on that page we need loading, it just holds the last
   * camera"). Switching rooms restarts the poll below, but the last frame belonged
   * to the room we just left — so the viewer showed the RED room under a BLUE room
   * heading until a new frame decoded, and a staff member could act on the wrong
   * room entirely.
   *
   * The frame therefore CARRIES THE CAMERA IT CAME FROM, and a frame from another
   * camera simply does not render. Derived rather than reset in an effect: there is
   * no moment, however brief, where the wrong picture is on screen, and no cascade
   * of renders to blank it.
   */
  const [frame, setFrame] = useState<{ key: string; src: string } | null>(null);
  const [offlineKey, setOfflineKey] = useState<string | null>(null);
  const lastOkRef = useRef(0);

  const key = `${room}@${width}`;
  const src = frame?.key === key ? frame.src : null;
  const offline = offlineKey === key;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const url = `/api/tv/camera?room=${room}&w=${width}&t=${Date.now()}`;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        lastOkRef.current = Date.now();
        setFrame({ key, src: url });
        setOfflineKey(null);
        timer = setTimeout(tick, cadenceMs);
      };
      img.onerror = () => {
        if (cancelled) return;
        if (Date.now() - lastOkRef.current > 6000) setOfflineKey(key);
        // Back off on failure whatever the cadence — a camera that is down must
        // not be hammered at viewer speed.
        timer = setTimeout(tick, Math.max(2_000, cadenceMs));
      };
      img.src = url;
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [room, width, enabled, cadenceMs, key]);

  return { src, offline };
}

/**
 * THE LIVE STREAM, played by the browser itself.
 *
 * The still refresh above is a picture a second through our own proxy; this is the
 * actual camera, straight from Nx's relay (owner 2026-08-12: "when we go full
 * screen on camera can we switch to live feed?"). Our functions never touch the
 * video — they only mint the single-use ticket that authorises it, which is why
 * this can exist on serverless at all. See nx/camera.server.ts.
 *
 * IT IS AN UPGRADE, NEVER A REQUIREMENT. Every failure path — no ticket, relay
 * down, a codec the browser will not take, autoplay refused — simply leaves the
 * stills showing underneath. A viewer that went black because live broke would be
 * worse than the thing it replaced.
 *
 * A TICKET IS SPENT ON USE, so a re-mint is needed for every load: opening the
 * viewer, switching rooms, and any recovery after the stream drops. Retries are
 * capped — a camera that keeps dropping should settle on stills rather than mint
 * tickets forever.
 */
const LIVE_MAX_RETRIES = 2;

function useLiveCamera(room: CameraTarget, getUrl: (room: CameraTarget) => Promise<string | null>) {
  // Both pieces of state CARRY THE CAMERA they describe, for the same reason the
  // still hook does: switching cameras must not leave the blue room's stream
  // playing under a red heading for the second it takes to mint a new ticket.
  // Derived, so there is no stale frame to blank and no reset effect to run.
  //
  // This matters more, not less, for the holding views: they are the SAME device
  // at two dewarp angles, so a stream that outlived its target would be a picture
  // that looks plausible and is aimed at the other track's seats.
  const [stream, setStream] = useState<{ room: CameraTarget; url: string } | null>(null);
  const [playingRoom, setPlayingRoom] = useState<CameraTarget | null>(null);
  const retriesRef = useRef(0);

  // The parent's callback, kept current in a ref so re-creating it cannot restart
  // a healthy stream. Only the room should do that.
  const getUrlRef = useRef(getUrl);
  useEffect(() => {
    getUrlRef.current = getUrl;
  });

  const load = useCallback(async (target: CameraTarget) => {
    const url = await getUrlRef.current(target);
    setStream(url ? { room: target, url } : null);
  }, []);

  useEffect(() => {
    retriesRef.current = 0;
    void load(room);
  }, [room, load]);

  /** The stream dropped or was refused — take one more ticket, then stand down. */
  const retry = useCallback(() => {
    setPlayingRoom(null);
    if (retriesRef.current >= LIVE_MAX_RETRIES) {
      setStream(null);
      return;
    }
    retriesRef.current += 1;
    void load(room);
  }, [load, room]);

  const url = stream?.room === room ? stream.url : null;
  return {
    url,
    playing: playingRoom === room && !!url,
    onPlaying: () => setPlayingRoom(room),
    /**
     * BUFFERING IS NOT A FAILURE. A stall spends no ticket and remounts nothing —
     * it just stops the board claiming LIVE and lets the still refresh take the
     * picture back until frames resume. Only a dead stream (`error`, `ended`)
     * costs a fresh ticket, which is what keeps a jittery relay from burning
     * through the retry budget in ten seconds.
     */
    onWaiting: () => setPlayingRoom(null),
    retry,
  };
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
}: {
  room: BriefingRoom;
  /** Viewer has this room open — hold the last frame, stop pulling. */
  paused: boolean;
  onExpand: () => void;
}) {
  const { src, offline } = useCameraFrame(room, 640, !paused);

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
        <CameraFrame
          src={src}
          offline={offline}
          alt={`${room} briefing room`}
          connectingSize={11}
        />
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
          {offline ? "RECONNECTING…" : paused ? "IN THE VIEWER" : `LIVE · ${room.toUpperCase()}`}
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
}: {
  target: CameraTarget;
  label: string;
  paused: boolean;
  onExpand: () => void;
  accent: string;
}) {
  // 640, not 960: the box is CAM_W wide, so even a 2x panel wants ~416px — and
  // every pixel here is transcoded, not merely resized (see fetchDewarpedFrame).
  const { src, offline } = useCameraFrame(target, 640, !paused, 2_000);

  return (
    <button
      type="button"
      className="rc-cam"
      onClick={onExpand}
      title={`Enlarge the ${label.toLowerCase()} camera`}
      aria-label={`Enlarge the ${label.toLowerCase()} camera`}
    >
      <span className="rc-cam-shot">
        <CameraFrame src={src} offline={offline} alt={label} connectingSize={11} />
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
          {offline ? "RECONNECTING…" : paused ? "IN THE VIEWER" : label.toUpperCase()}
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
  getLiveUrl: (target: CameraTarget) => Promise<string | null>;
}) {
  const room = isRoom(target) ? target : null;
  const live = useLiveCamera(target, getLiveUrl);
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
            src={live.url}
            autoPlay
            muted
            playsInline
            onPlaying={live.onPlaying}
            onWaiting={live.onWaiting}
            onStalled={live.onWaiting}
            onError={live.retry}
            onEnded={live.retry}
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
      className={held ? "rcb rcb-hold" : "rcb"}
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

function findDelay(tracks: TrackInfo[] | undefined, track: string): TrackInfo | null {
  if (!tracks) return null;
  return tracks.find((t) => (t.trackName || "").toLowerCase().includes(track)) ?? null;
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
