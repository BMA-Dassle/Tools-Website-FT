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
import { useCallback, useEffect, useRef, useState } from "react";
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
import type { BriefingControl, RoomStatus } from "./useBriefingControl";
import { formatRemaining, useLiveSessionClock } from "~/features/signage/live-session";
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
/* A staff alert must not be motion-only anyway: reduced motion keeps the colour
   and drops the pulse, so the box still reads as overdue. */
@media (prefers-reduced-motion: reduce) {
  .rc-flash-warn, .rc-flash-late { animation: none; }
  .rc-flash-warn { border-color: ${AMBER}; background-color: ${withAlpha(AMBER, 0.18)}; }
  .rc-flash-late { border-color: ${DANGER}; background-color: ${withAlpha(DANGER, 0.22)}; }
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

export default function RaceControlPanels({ control }: { control: BriefingControl }) {
  const status = useTrackStatus();
  const nowMs = useNowMs();
  const { board, note, pending } = control;

  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;
  const rooms: BriefingRoom[] = ["red", "blue"];
  const noVideos = !!board && !board.videos.starter && !board.videos.intermediate;

  // ONE viewer for both rooms, owned here rather than inside a room's panel — two
  // independent overlays could both be open, stacked on each other, each pulling
  // its own 1600px frame every second.
  const expanded = control.expandedRoom;
  const expandedStatus = expanded ? (board?.rooms.find((r) => r.room === expanded) ?? null) : null;

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
              sentTo={
                board?.assignments.find(
                  (a) => a.mode === "timeline" && !!race && a.sessionId === String(race.sessionId),
                )?.room ?? null
              }
              nowMs={nowMs}
              // 0 until the first poll lands — checkinAlert reads that as "no
              // deadline known", so a board still connecting never flashes at a
              // window it is guessing at.
              checkinWindowMins={board?.checkinWindowMins?.[track] ?? 0}
              tierOverride={control.tierOverride[room] ?? null}
              onTierOverride={(tier) => control.setTierOverride(room, tier)}
              locked={board?.enabled === false}
              pending={pending}
              cameraExpanded={expanded === room}
              onExpandCamera={() => control.setExpandedRoom(room)}
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
            />
          );
        })}
      </div>

      {/* TODAY'S BRIEFING LOG — the durable record, on screen.
          Was "Sent today", a list of send times read from the assignment rows.
          It now reads the Neon event log (owner 2026-08-12: "for insurance
          purposes, record when each session is briefed and the time they're in
          the room"), so each line carries what was actually recorded: in at, the
          film, whether it finished, and how long the room was theirs. Shown
          because a record nobody can see is a record nobody notices has stopped
          being written — this strip is the daily proof it is landing. */}
      {(board?.briefings.length ?? 0) > 0 && (
        <details style={{ marginTop: 10, flexShrink: 0 }}>
          <summary style={{ cursor: "pointer", fontSize: 11, color: PORTAL_DARK.muted }}>
            Briefing log — today ({board?.briefings.length})
          </summary>
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
              <span style={{ minWidth: 104 }}>Room photo</span>
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
                      title="Room photo saved for insurance — opens the still"
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
        </details>
      )}

      {expanded && (
        <CameraLightbox
          room={expanded}
          track={megaEnabled ? "mega" : expanded}
          state={expandedStatus?.state ?? null}
          nowMs={nowMs}
          locked={board?.enabled === false}
          pending={pending}
          onStart={(restart) => control.start(expanded, { restart })}
          onSwitch={(next) => control.setExpandedRoom(next)}
          onClose={() => control.setExpandedRoom(null)}
          getLiveUrl={control.liveCameraUrl}
        />
      )}
    </section>
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
  tierOverride,
  onTierOverride,
  locked,
  pending,
  cameraExpanded,
  onExpandCamera,
  onSend,
  onStart,
  onUndo,
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
  tierOverride: BriefingTier | null;
  onTierOverride: (tier: BriefingTier | null) => void;
  locked: boolean;
  pending: string | null;
  /** This room's camera is open in the full-screen viewer — the small preview
   *  stops pulling frames while it is. */
  cameraExpanded: boolean;
  onExpandCamera: () => void;
  onSend: () => void;
  onStart: (restart: boolean) => void;
  onUndo: () => void;
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

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 0,
        borderLeft: `3px solid ${color}`,
        paddingLeft: 12,
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
      <Panel label="Called" flat alert={calledAlert}>
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
      <Panel
        label="In the room"
        grow
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
          cameraExpanded={cameraExpanded}
          onExpandCamera={onExpandCamera}
          returning={returning}
          alert={roomAlert}
          onStart={onStart}
          onUndo={onUndo}
        />
      </Panel>
    </div>
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
    // THE ROW IS AS TALL AS THE PICTURE, NOT AS TALL AS THE PANEL. The panel grows
    // to fill the board's height, so a row that grew with it stretched the left
    // column past the camera and left the bottom rail aligned to a panel edge
    // instead of the video (owner 2026-08-12: "so it looks even"). This wrapper
    // takes the growth; the row inside keeps its content height, and stretch then
    // means "as tall as the taller column" — the camera, normally.
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
            flex: "1 1 280px",
            minWidth: 240,
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
                  <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
                    {holdMs > 0
                      ? "Go and walk them over — Start unlocks in a moment."
                      : "TV is holding a “take a seat” board."}
                    {!state?.videoUrl && " No film for this tier — Start skips to helmet sizes."}
                  </p>
                  <div style={{ display: "flex", gap: 8, marginTop: "auto", alignItems: "center" }}>
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
                      <span style={{ marginLeft: "auto" }}>
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
        <div style={{ flex: "1 1 300px", minWidth: 200 }}>
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
            marginTop: "auto",
            paddingTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: "0.01em",
            color: alert === "late" ? DANGER : AMBER,
          }}
        >
          <IconAlertTriangleFilled size={16} aria-hidden />
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
function useCameraFrame(room: BriefingRoom, width: number, enabled: boolean, cadenceMs = 1_000) {
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

function useLiveCamera(room: BriefingRoom, getUrl: (room: BriefingRoom) => Promise<string | null>) {
  // Both pieces of state CARRY THE ROOM they describe, for the same reason the
  // still hook does: switching rooms must not leave the blue room's stream playing
  // under a red heading for the second it takes to mint a new ticket. Derived, so
  // there is no stale frame to blank and no reset effect to run.
  const [stream, setStream] = useState<{ room: BriefingRoom; url: string } | null>(null);
  const [playingRoom, setPlayingRoom] = useState<BriefingRoom | null>(null);
  const retriesRef = useRef(0);

  // The parent's callback, kept current in a ref so re-creating it cannot restart
  // a healthy stream. Only the room should do that.
  const getUrlRef = useRef(getUrl);
  useEffect(() => {
    getUrlRef.current = getUrl;
  });

  const load = useCallback(async (target: BriefingRoom) => {
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
      <span className="rc-cam-shot">
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
  room,
  track,
  state,
  nowMs,
  locked,
  pending,
  onStart,
  onSwitch,
  onClose,
  getLiveUrl,
}: {
  room: BriefingRoom;
  track: string;
  state: BriefingRoomState | null;
  nowMs: number;
  locked: boolean;
  pending: string | null;
  onStart: (restart: boolean) => void;
  onSwitch: (room: BriefingRoom) => void;
  onClose: () => void;
  getLiveUrl: (room: BriefingRoom) => Promise<string | null>;
}) {
  const live = useLiveCamera(room, getLiveUrl);
  // STILLS ARE THE BRIDGE, NOT THE FALLBACK ONLY. They paint in ~200ms while the
  // ticket is minted and the video buffers, then stand down the moment live is
  // actually playing — so the viewer is never blank waiting for video, and never
  // pays for two pictures of the same room at once.
  const { src, offline } = useCameraFrame(room, 1600, !live.playing);
  const closeRef = useRef<HTMLButtonElement>(null);
  const color = ROOM_COLOR[room];
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
      aria-label={`${cap(room)} room camera`}
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
          {cap(room).toUpperCase()} ROOM
        </strong>
        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{cap(track)} Track</span>
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

        {/* Either room, without reopening. */}
        <span style={{ display: "inline-flex", gap: 6, marginLeft: 6 }}>
          {(["red", "blue"] as BriefingRoom[]).map((r) => (
            <button
              key={r}
              type="button"
              className="rcb"
              onClick={() => onSwitch(r)}
              aria-pressed={r === room}
              style={{
                padding: "5px 12px",
                borderRadius: 5,
                fontSize: 11,
                borderColor: r === room ? withAlpha(ROOM_COLOR[r], 0.85) : PORTAL_DARK.border,
                background: r === room ? withAlpha(ROOM_COLOR[r], 0.18) : "transparent",
                color: r === room ? INK : PORTAL_DARK.muted,
              }}
            >
              {cap(r)}
            </button>
          ))}
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
            alt={`${room} briefing room, enlarged`}
            connectingSize={18}
            connectingLabel={`Loading the ${room} room…`}
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
        {phase === "idle" ? (
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
  children,
}: {
  label: string;
  badge?: React.ReactNode;
  accent?: string;
  grow?: boolean;
  flat?: boolean;
  /** Overdue — the whole box flashes amber, then red. See the .rc-flash rules. */
  alert?: AlertLevel;
  children: React.ReactNode;
}) {
  const flash = alert === "late" ? "rc-flash-late" : alert === "warn" ? "rc-flash-warn" : undefined;
  return (
    <div
      className={flash}
      style={{
        border: `1px solid ${accent ? withAlpha(accent, 0.35) : PORTAL_DARK.border}`,
        background: flat ? "transparent" : PORTAL_DARK.card,
        borderRadius: 8,
        padding: "10px 12px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
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
