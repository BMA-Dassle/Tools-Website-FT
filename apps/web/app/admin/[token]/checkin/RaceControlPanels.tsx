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
 * TWO BOXES PER ROOM — Called, and In the room. That is what makes the busy case
 * legible: a second heat called mid-briefing is two boxes saying two different
 * things, rather than one box trying to be both. Sending into an occupied room
 * still works; it asks first.
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
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangleFilled, IconCamera, IconMaximize, IconX } from "@tabler/icons-react";
import { useTrackStatus, type CurrentRace, type TrackInfo } from "@/hooks/useTrackStatus";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { briefingTimelineAt, type BriefingTimeline } from "~/features/signage/briefing/phase";
import {
  tierForRaceType,
  type BriefingPhase,
  type BriefingRoom,
  type BriefingRoomState,
  type BriefingTier,
} from "~/features/signage/briefing/types";
import {
  liveHeatNumber,
  roomReturnStateAt,
  type RoomReturnState,
} from "~/features/signage/briefing/room-return";
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
 * A TEMPORARY MEMO TO THE DESK — added 2026-08-12, delete once the habit sticks.
 *
 * The order of operations went inside out on the floor: staff were sending the
 * room and starting the film in two presses at the desk, THEN going to fetch the
 * group (owner: "please make sure you send to room before pulling from check in").
 * The ten-second hold on Start (start-hold.ts) buys the walk; this says why, in
 * words, because a pause nobody understands is a pause staff learn to wait out
 * without changing what they do around it.
 *
 * IT LIVES ON THE SEND BUTTON, NOT ACROSS THE TOP OF THE BOARD (owner 2026-08-12:
 * "I don't want as a banner, put somewhere near that button"). A standing banner
 * is read once and becomes wallpaper by the second heat; a line attached to the
 * control is read at the moment it is about to be disobeyed, and it is on screen
 * only while there is actually a session waiting to be sent.
 *
 * Disposable by design — one constant, one line that renders it.
 */
const STAFF_MEMO = "Send to the room BEFORE you pull them from check-in.";

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
  const status = useTrackStatus();
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

      <header
        className="flex items-center gap-3"
        style={{ flexWrap: "wrap", flexShrink: 0, marginBottom: 12 }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: "0.08em",
            margin: 0,
            color: PORTAL_DARK.muted,
            textTransform: "uppercase",
          }}
        >
          Briefing rooms
        </h2>
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

          It is now the third box in each room's column — Called, In the room,
          Holding — so the board carries the whole journey a group takes and the
          press sits with the group it is about. See HoldingPanel. */}
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
              tierOverride={control.tierOverride[room] ?? null}
              onTierOverride={(tier) => control.setTierOverride(room, tier)}
              locked={board?.enabled === false}
              pending={pending}
              expandedCamera={expanded}
              onExpandCamera={(target) => control.setExpandedCamera(target)}
              lane={board?.lanes?.[track as "blue" | "red" | "mega"] ?? null}
              ownsLane={!megaEnabled || room === megaLaneOwner}
              onRaceReturned={() => control.markPitted(track)}
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
              <span style={{ marginLeft: "auto" }}>In room</span>
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
                <span style={{ marginLeft: "auto", color: b.inRoomMs != null ? INK : AMBER }}>
                  {b.inRoomMs != null ? formatClock(b.inRoomMs) : "in there now"}
                </span>
              </div>
            ))}
          </div>
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

/* ── one room ──────────────────────────────────────────────────────────── */

function RoomColumn({
  room,
  track,
  race,
  delay,
  status,
  proFilmMissing,
  nowMs,
  checkinWindowMins,
  sentTo,
  checkedIn,
  tierOverride,
  onTierOverride,
  locked,
  pending,
  expandedCamera,
  onExpandCamera,
  lane,
  ownsLane,
  onRaceReturned,
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
  nowMs: number;
  /** This track's check-in window, from the track board's own config. 0 = not
   *  known yet (or the countdown is off), which raises no alert. */
  checkinWindowMins: number;
  /** Which room this called session already went to, if any. */
  sentTo: BriefingRoom | null;
  /** This heat's check-in progress, for the Called box. Null when the station
   *  has not reported one for this session. */
  checkedIn: CheckinCount | null;
  tierOverride: BriefingTier | null;
  onTierOverride: (tier: BriefingTier | null) => void;
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
  /** "Race returned" — the karts are fully back in the lane. */
  onRaceReturned: () => void;
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
   * AN IDLE ROOM IS NOT NECESSARILY A FREE ROOM — its group may still be on track,
   * due to walk back in with the kit (owner 2026-08-12). Same live clock the
   * identity row above already shows, matched to the room's own group by heat
   * number; every rule and bound is in room-return.ts.
   */
  const returning = roomReturnStateAt({
    group: status?.groupOut ?? null,
    liveHeat: liveClock
      ? { heatNumber: liveHeatNumber(liveClock.heatName), remainingMs: liveClock.remainingMs }
      : null,
    // `track` is already "mega" on a Mega day (the parent resolves it), which is
    // exactly the "two rooms, one circuit" condition the matcher guards.
    megaDay: track === "mega",
    nowMs,
  });
  const idleBadge = idleBadgeFor(returning, color);
  const autoTier = tierForRaceType(race?.raceType);
  const tier = tierOverride ?? autoTier;
  // The desk says what will REALLY play before the send: a Pro pick with no Pro
  // film uploaded runs the Intermediate film (owner 2026-08-11). Availability
  // comes down as a prop — `board` lives in the parent.
  const proMissing = tier === "pro" && proFilmMissing;
  const sameSessionInRoom = !!race && state?.sessionId === String(race.sessionId);

  const calledMs = race?.calledAt ? Date.parse(race.calledAt) : NaN;
  const checkingInMs = Number.isFinite(calledMs) ? Math.max(0, nowMs - calledMs) : null;
  const delayMins = delay?.delayMinutes ?? null;

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
  const holdingHeat = lane?.holding?.heatNumber ?? null;
  const liveHeatNow = liveClock ? liveHeatNumber(liveClock.heatName) : null;
  const launched =
    holdingHeat != null && liveHeatNow != null && holdingHeat === liveHeatNow && liveClock?.counting
      ? { heatNumber: holdingHeat }
      : null;

  /**
   * IS THE LANE STILL HELD. The same rule the pit board's own rail runs
   * (pitRailState in pit/pit-board.ts): a finish raises the hold, and only a
   * "race returned" stamp NEWER than that finish clears it — a stamp from the
   * previous cycle is a stale stamp and must not release this hold.
   */
  const holdLive =
    !!lane?.racing &&
    lane.racing.finishedAtMs != null &&
    (lane.racing.pittedAtMs == null || lane.racing.pittedAtMs < lane.racing.finishedAtMs);

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
              <Stat
                label="Track delay"
                value={delayMins != null ? (delayMins > 0 ? `+${delayMins}` : "0") : "—"}
                unit={delayMins && delayMins > 0 ? "min behind" : "on time"}
                tone={delayMins && delayMins > 0 ? AMBER : undefined}
              />
            </div>

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
              {(["starter", "intermediate", "pro"] as BriefingTier[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="rcb"
                  onClick={() => onTierOverride(t === autoTier ? null : t)}
                  aria-pressed={tier === t}
                  style={{
                    padding: "4px 11px",
                    borderRadius: 5,
                    borderColor: tier === t ? withAlpha(color, 0.8) : PORTAL_DARK.border,
                    background: tier === t ? withAlpha(color, 0.16) : "transparent",
                    color: tier === t ? INK : PORTAL_DARK.muted,
                    fontSize: 11,
                  }}
                >
                  {cap(t)}
                  {t === autoTier ? " · auto" : ""}
                </button>
              ))}
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
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 4,
                  }}
                >
                  {/* THE MEMO, ON THE BUTTON IT IS ABOUT. Temporary — see
                      STAFF_MEMO. Above rather than below, because it is an
                      instruction about what to do BEFORE the press. */}
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 11,
                      fontWeight: 700,
                      color: AMBER,
                      textAlign: "right",
                    }}
                  >
                    <IconAlertTriangleFilled size={13} aria-hidden style={{ flexShrink: 0 }} />
                    {STAFF_MEMO}
                  </span>
                  <ActionButton
                    tone={occupied ? AMBER : color}
                    outline={occupied}
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
                    {occupied ? "Replace" : `Send to ${cap(room)} →`}
                  </ActionButton>
                </span>
              )}
            </div>
          </>
        ) : sentTo && race ? (
          <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: "2px 0" }}>
            Session {race.heatNumber} went to the {sentTo} room — waiting on the next call.
          </p>
        ) : (
          <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: "2px 0" }}>
            Nothing called on {cap(track)} Track.
          </p>
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
        accent={
          occupied
            ? phaseColor(timeline.phase, color)
            : // A room waiting on its group is not a neutral room — the border
              // carries the warning too, so it reads from across the desk.
              (idleBadge.accent ?? undefined)
        }
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
              color: occupied ? phaseColor(timeline.phase, color) : idleBadge.tone,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: occupied ? phaseColor(timeline.phase, color) : idleBadge.tone,
              }}
            />
            {occupied ? PHASE_LABEL[timeline.phase].toUpperCase() : idleBadge.label}
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
          returning={returning}
          alert={roomAlert}
          onStart={onStart}
          onUndo={onUndo}
          onSendHolding={onSendHolding}
        />
      </Panel>

      {/* ── HOLDING ── the third spot (owner 2026-08-13: "we have the button to
          send to holding but we don't have a box for holding … that screen will
          show all three spots"). */}
      {ownsLane && (
        <>
          <HoldingPanel
            room={room}
            track={track}
            color={color}
            lane={lane}
            launched={launched}
            holdLive={holdLive}
            nowMs={nowMs}
            cameraExpanded={expandedCamera === holdingCameraFor(room)}
            onExpandCamera={() => onExpandCamera(holdingCameraFor(room))}
          />
          <OnTrackPanel
            track={track}
            color={color}
            lane={lane}
            liveClock={liveClock}
            launched={launched}
            holdLive={holdLive}
            nowMs={nowMs}
            locked={locked}
            pending={pending}
            onRaceReturned={onRaceReturned}
          />
        </>
      )}
    </div>
  );
}

/* ── holding ───────────────────────────────────────────────────────────── */

/**
 * WHERE A GROUP GOES BETWEEN THE ROOM AND THE GRID.
 *
 * The board's third box, and the one that closes the loop: Called says who is
 * coming, In the room says who is watching the film, and until now the moment
 * staff pressed "Send to holding" the group simply left the screen — they were
 * in the pit seats, on the pit board's wall, and nowhere on the desk's.
 *
 * IT ANSWERS TWO QUESTIONS, WHICH IS WHY IT IS ONE BOX AND NOT TWO. Who is
 * seated (the holding half), and whether the lane will let them go (the racing
 * half). Those are the same question to a staff member — "can I send them out
 * yet" — and splitting them would put the reason on one side of the board and
 * the press that fixes it on the other.
 *
 * "RACE RETURNED" LIVES HERE NOW. It was a strip across the top of the board,
 * one button per track, attached to nothing. It is the ONLY thing that releases
 * the pit board's hold (a race finishing raises the hold on the venue's own
 * finish signal; only a human who can see the lane says the karts are in), so it
 * belongs beside the group it is holding up. The strip is gone — see the note
 * where it used to render.
 *
 * THE CAMERA IS THE HOLDING AREA ITSELF, aimed by the Nx layout the venue keeps
 * for it. See nx/camera.server.ts: red and blue are the same ceiling fisheye at
 * two saved angles, so the picture in this box is the track's own seats and not
 * a raw fisheye of the whole walkway.
 */
function HoldingPanel({
  room,
  track,
  color,
  lane,
  launched,
  holdLive,
  nowMs,
  cameraExpanded,
  onExpandCamera,
}: {
  room: BriefingRoom;
  track: string;
  color: string;
  lane: PitLaneFeed | null;
  /** The group whose green flag has been seen — computed in the room column so
   *  Holding and On track can never disagree about it. Null when nobody has
   *  just launched. */
  launched: { heatNumber: number } | null;
  /** Whether the lane is still held. Also from the column, for the same reason —
   *  the badge here and the press on the On-track box read one value. */
  holdLive: boolean;
  nowMs: number;
  cameraExpanded: boolean;
  onExpandCamera: () => void;
}) {
  const holding = launched ? null : (lane?.holding ?? null);
  const racing = lane?.racing ?? null;

  const heldMs = holding ? Math.max(0, nowMs - holding.atMs) : 0;

  const badge = holdLive
    ? { label: "LANE HELD", tone: DANGER }
    : holding
      ? { label: "CLEAR TO SEAT", tone: GREEN }
      : // A group that has just taken the green flag is ON TRACK even before the
        // lane's own racing half catches up — the clock is the earlier truth.
        launched || racing
        ? { label: "ON TRACK", tone: AMBER }
        : { label: "EMPTY", tone: PORTAL_DARK.muted };

  return (
    <Panel
      label="Holding"
      // The hold is the one state on this box that wants the eye — it is a
      // safety fact with a press attached. A seated group on a clear lane is
      // good news and gets no border colour at all.
      alert={holdLive ? "late" : "none"}
      accent={holdLive ? DANGER : holding ? GREEN : undefined}
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
            color: badge.tone,
          }}
        >
          <span
            aria-hidden
            style={{ width: 7, height: 7, borderRadius: "50%", background: badge.tone }}
          />
          {badge.label}
        </span>
      }
    >
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "stretch" }}>
        {/* LEFT — who is seated, and what the lane is doing. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            // Takes whatever the fixed-width camera leaves. The wrap threshold
            // is low on purpose: with a 208px picture beside it, this column has
            // room to stay alongside on any desk monitor we run.
            flex: "1 1 200px",
            minWidth: 180,
          }}
        >
          {holding ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color: INK }}>
                  {holding.heatNumber != null ? `Session ${holding.heatNumber}` : "In the seats"}
                </span>
                {holding.raceType && (
                  <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{holding.raceType}</span>
                )}
              </div>
              <Stat
                label="In the seats"
                value={formatClock(heldMs)}
                unit={
                  holding.room
                    ? `since the ${holding.room} room`
                    : `since they left the ${room} room`
                }
                tone={holdLive ? AMBER : GREEN}
                big
              />
            </>
          ) : (
            <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: 0 }}>
              {launched
                ? `Nobody in the seats — session ${launched.heatNumber} took the green flag and is out on ${cap(track)}.`
                : racing
                  ? `Nobody in the seats — ${racing.heatNumber != null ? `session ${racing.heatNumber}` : "the last group"} is out on ${cap(track)}.`
                  : "Nobody in the seats yet — send a briefed group over."}
            </p>
          )}

          {/* WHY THEY CANNOT GO YET — one line, no control. The race itself and
              the press that clears the lane belong to the On-track box below;
              this box only has to say whether these seats can empty. */}
          {holding && holdLive && (
            <p style={{ fontSize: 12, color: AMBER, margin: 0 }}>
              Hold them — karts are still coming into the lane.
            </p>
          )}
        </div>

        {/* RIGHT — the holding area itself. Same still-refresh rail as the room
            cameras, but SLOWER: a dewarped frame comes off a transcode and takes
            about a second, where a room's raw frame takes a fifth of that. A
            2-second preview is honest about that and still shows a group
            arriving; the full-screen viewer switches to live video, where the
            dewarp costs nothing because the stream is transcoded anyway. */}
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
    </Panel>
  );
}

/* ── on track ──────────────────────────────────────────────────────────── */

/**
 * THE FOURTH BOX — who is out on the circuit right now (owner 2026-08-13: "I
 * want an on-track box under holding").
 *
 * It completes the journey the column describes: Called → In the room → Holding
 * → On track. Everything above it is a group the desk is moving; this is the
 * group the desk is WAITING on, and until now the only trace of them was a chip
 * in the room heading and a sentence in someone else's box.
 *
 * IT OWNS THE LANE, and that is why "Race returned" moved here. The press means
 * "the finished race's karts are fully back", which is a fact about THIS group —
 * it sat in Holding only because a held lane is what stops the next group being
 * seated. Holding now states the consequence ("hold them") and this box carries
 * the race and the release.
 *
 * TWO GROUPS CAN BE TRUE AT ONCE and the box says so rather than choosing: the
 * heat that just took the green flag is on track, while the previous heat's
 * karts may still be rolling in behind them. Normally staff mark the lane
 * returned before seating the next group, so the overlap is brief — but a board
 * that silently showed one of them would be wrong for exactly the minute that
 * matters.
 */
function OnTrackPanel({
  track,
  color,
  lane,
  liveClock,
  launched,
  holdLive,
  nowMs,
  locked,
  pending,
  onRaceReturned,
}: {
  track: string;
  color: string;
  lane: PitLaneFeed | null;
  liveClock: LiveSessionClock | null;
  launched: { heatNumber: number } | null;
  holdLive: boolean;
  nowMs: number;
  locked: boolean;
  pending: string | null;
  onRaceReturned: () => void;
}) {
  const racing = lane?.racing ?? null;

  // WHO IS OUT. The green-flag verdict is the fresher of the two — the lane's
  // own racing half does not move until a finish marker or the next send, so
  // during a race it still names the PREVIOUS group.
  const outHeat = launched?.heatNumber ?? racing?.heatNumber ?? null;

  // Does the live clock belong to the group we are naming? On a shared circuit
  // it might be someone else's heat, and a clock against the wrong session is
  // worse than no clock.
  const liveHeat = liveClock ? liveHeatNumber(liveClock.heatName) : null;
  const clockIsOurs = !!liveClock && liveHeat != null && outHeat != null && liveHeat === outHeat;

  const sinceFinishMs = racing?.finishedAtMs != null ? Math.max(0, nowMs - racing.finishedAtMs) : 0;
  // The group whose karts are coming in, named separately — see the header.
  const returningHeat = holdLive ? (racing?.heatNumber ?? null) : null;
  const overlap = returningHeat != null && outHeat != null && returningHeat !== outHeat;

  const badge = holdLive
    ? { label: "KARTS COMING IN", tone: DANGER }
    : clockIsOurs && liveClock?.state === "paused"
      ? { label: "PAUSED", tone: AMBER }
      : outHeat != null
        ? { label: "RACING", tone: GREEN }
        : { label: "TRACK CLEAR", tone: PORTAL_DARK.muted };

  return (
    <Panel
      label="On track"
      alert={holdLive ? "warn" : "none"}
      accent={holdLive ? DANGER : outHeat != null ? color : undefined}
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
            color: badge.tone,
          }}
        >
          <span
            aria-hidden
            style={{ width: 7, height: 7, borderRadius: "50%", background: badge.tone }}
          />
          {badge.label}
        </span>
      }
    >
      {outHeat == null && !holdLive ? (
        <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: 0 }}>
          Nothing out on {cap(track)}.
        </p>
      ) : (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          {outHeat != null && (
            <div style={{ minWidth: 130 }}>
              <div className="rc-num" style={{ fontSize: 20, fontWeight: 800, color: INK }}>
                Session {outHeat}
              </div>
              <div style={{ fontSize: 11, color: PORTAL_DARK.muted }}>on {cap(track)} Track</div>
            </div>
          )}

          {/* The race clock, only when it is demonstrably this group's. */}
          {clockIsOurs && liveClock && (
            <Stat
              label={liveClock.state === "paused" ? "Paused at" : "Time left"}
              value={formatRemaining(liveClock.remainingMs)}
              unit={liveClock.counting ? "of the race" : "not counting yet"}
              tone={liveClock.state === "paused" ? AMBER : color}
              big
            />
          )}

          {/* THE LANE. Named separately when the group coming in is not the group
              out — see the header. */}
          {holdLive && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 200 }}>
              <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
                {overlap
                  ? `Session ${returningHeat} finished ${formatClock(sinceFinishMs)} ago and its karts are still coming in.`
                  : `Finished ${formatClock(sinceFinishMs)} ago — the pit board is holding until the karts are in.`}
              </p>
              <ActionButton
                tone={AMBER}
                textColor="#1a1205"
                size="md"
                pendingKey={`pitted:${track}`}
                pending={pending}
                disabled={locked}
                pendingLabel="Marking…"
                title="The finished race's karts are fully back in the lane — releases the pit board's hold"
                onClick={onRaceReturned}
              >
                ⏎ Race returned
              </ActionButton>
            </div>
          )}

          {!holdLive && racing?.pittedAtMs != null && outHeat == null && (
            <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
              Lane clear — the karts are back in.
            </p>
          )}
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
  returning,
  alert,
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
  /** Whether the room's last group is still out — only consulted while idle. */
  returning: RoomReturnState;
  /** How overdue the wait for Start is — the box is already flashing, so the
   *  number itself follows rather than staying a calm amber under a red border. */
  alert: AlertLevel;
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
            <IdleBody returning={returning} color={color} />
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
                  {(holdMs > 0 || !state?.videoUrl) && (
                    <p style={{ fontSize: 11, color: PORTAL_DARK.muted, margin: 0 }}>
                      {holdMs > 0 && "Go and walk them over — Start unlocks in a moment."}
                      {!state?.videoUrl && " No film for this tier — Start skips to helmet sizes."}
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
                      <Stat
                        label="Left"
                        value={timeline.nextInMs != null ? formatClock(timeline.nextInMs) : "—"}
                        unit="until the room is free"
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
                      {phase === "video" && timeline.videoMs > 0 && (
                        <span className="rc-num" style={{ fontSize: 10, color: PORTAL_DARK.muted }}>
                          {Math.round(pct)}% · then helmet sizes, then free
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
                            without un-briefing the session the way Undo does. */}
                        <ActionButton
                          size="sm"
                          tone={GREEN}
                          textColor="#052e14"
                          pendingKey={`holding:${room}`}
                          pending={pending}
                          disabled={locked || !state?.sessionId}
                          pendingLabel="Sending…"
                          onClick={onSendHolding}
                          title="The group is leaving for the pit seats — frees this room and tells the pit board to seat them"
                        >
                          ➜ Send to holding
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

/* ── an empty room, and whether it is really empty ────────────────────── */

/**
 * The idle badge — the one that used to just say FREE.
 *
 * FREE IS NOW A CLAIM THE BOARD HAS TO EARN (owner 2026-08-12: "Free might not be
 * the right word here… it can say free about 1 minute after the race has
 * finished"). A room whose group is out on track has that group's return time on
 * it instead, counted off the live on-track clock; the words only fall back to
 * FREE once room-return.ts can say nobody is outstanding.
 */
function idleBadgeFor(
  returning: RoomReturnState,
  color: string,
): { label: string; tone: string; accent?: string } {
  switch (returning.kind) {
    case "racing":
      return { label: `BACK IN ${formatClock(returning.remainingMs)}`, tone: AMBER, accent: AMBER };
    case "on-grid":
      return { label: "OUT ON TRACK", tone: AMBER, accent: AMBER };
    case "returning":
      return { label: "RETURNING NOW", tone: color, accent: color };
    default:
      return { label: "FREE", tone: PORTAL_DARK.muted };
  }
}

/**
 * What an idle room's left column says. Three of the four states are "this room is
 * spoken for", and each one names the session — a bare "out on track" would leave
 * staff checking the send log to find out whose kit is about to arrive.
 */
function IdleBody({ returning, color }: { returning: RoomReturnState; color: string }) {
  const session = (heat: number | null) => (heat != null ? `Session ${heat}` : "The last group");

  if (returning.kind === "racing") {
    return (
      <>
        <Stat
          label="Back in"
          value={formatClock(returning.remainingMs)}
          unit={`${session(returning.heatNumber).toLowerCase()} on track`}
          tone={AMBER}
          big
        />
        <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
          Helmet sizes are up, but this room is spoken for — they come back here to hand kit in.
        </p>
      </>
    );
  }

  if (returning.kind === "on-grid") {
    return (
      <>
        <div style={{ fontSize: 15, fontWeight: 800, color: AMBER }}>
          {session(returning.heatNumber)} is out on track
        </div>
        <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
          Waiting on the flag — no clock on this track yet. They return here afterwards.
        </p>
      </>
    );
  }

  if (returning.kind === "returning") {
    return (
      <>
        <Stat
          label="Returning"
          value="Now"
          unit={`${session(returning.heatNumber).toLowerCase()} · kit return`}
          tone={color}
          big
        />
        <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
          Race finished {formatClock(returning.sinceEndMs)} ago — the TV is on the welcome-back
          board.
        </p>
      </>
    );
  }

  return (
    <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: 0 }}>
      Empty — the TV is showing helmet sizes.
    </p>
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
