"use client";

/**
 * ONE ROOM, ON THE WALL OF THAT ROOM.
 *
 * THE SCREEN IS A SENTENCE: *this group, this state, this one thing to do next.*
 * The desk board answers "where has the whole night got to"; this answers "what
 * do I press now", for somebody standing in front of twelve people who are
 * waiting on them. Everything here follows from that:
 *
 *  • ONE ACTION IS PRIMARY AT A TIME. With the room empty, PULL is the screen.
 *    Before the film, START is. Once the helmets board is up, SEND TO HOLDING is.
 *    The other controls never disappear — a briefing that has to be replayed is a
 *    real thing — they just stop competing, because a tablet with two equally
 *    loud buttons is a tablet somebody presses the wrong one on.
 *  • BUTTONS ARE 64px TALL. They were 96px, which was right when the screen was
 *    a pair of controls and nothing else; with a session rail down the side it
 *    was simply spending height it no longer had (owner 2026-08-16: "buttons are
 *    huge right now we have room"). Still a wall-tablet target for someone
 *    half-turned away — desk-sized controls remain the wrong tool.
 *  • THE ROOM FETCHES ITS OWN GROUP (owner 2026-08-16). The screen already knew
 *    when the next heat was fully through the desk and could only ask the staff
 *    member to walk over and press somebody else's button. The rule on it is the
 *    owner's: every racer checked in, or nothing. See pull-to-room.ts — the
 *    verdict is pure and its refusals are the sentences printed on the button.
 *  • EVERY FACT APPEARS ONCE. The film's clock lives in the room panel; the
 *    Holding panel used to repeat it with a progress bar of its own, which was
 *    defensible when those were the only two panels and stopped being so the
 *    moment the rail arrived (owner 2026-08-16: "why show safety video playing
 *    twice"). Its exact number moved into the refusal line under the button it
 *    governs, which is where the finger already is.
 *  • A REFUSAL IS EXPLAINED BEFORE IT HAPPENS. "Send to holding" goes inert with
 *    the REASON on it — "Session 27 is still in holding" — rather than failing on
 *    press. The verdict comes from the same pure rule the server guard uses
 *    (pit/holding-availability.ts), so the two can never disagree.
 *  • HOLDING IS NAMED, NOT PHOTOGRAPHED. The first cut put the holding camera on
 *    this panel and the owner cut it on sight (2026-08-15: "remove camera for
 *    now it looks like crap… show who is in holding if anyone"). They were
 *    right twice over: a fisheye thumbnail on a wall tablet is a smear, and the
 *    question the button asks is not "are there shapes in the seats" but WHICH
 *    GROUP is in the way — which a heat number answers exactly. The whole camera
 *    stack (still poller, lightbox, Nx proxy calls) went with it; the desk board
 *    keeps its viewer for the people who actually watch rooms fill.
 *
 * IT OWNS NO RULES. State, polling and every action come from useBriefingControl,
 * the desk board's hook, imported rather than copied: the send/start/holding
 * semantics are subtle and hard-won, and a second implementation of them would
 * drift within a week. Phase comes from briefingTimelineAt and the Start hold
 * from startHoldRemainingMs — the same pure functions the TV and the desk run, so
 * all three surfaces agree about what this room is doing.
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  IconAlertTriangleFilled,
  IconArrowRight,
  IconBackspace,
  IconPlayerPlayFilled,
  IconRefresh,
} from "@tabler/icons-react";
import { ADMIN_SANS, PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { useBuildUpdate } from "~/hooks/useBuildUpdate";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { useCameraStill } from "~/features/signage/useCameraStill";
import {
  MOTION_RESOLUTION,
  parseCameraPreviewMode,
  type LiveResolution,
} from "~/features/signage/nx/camera-preview";
import {
  LIVE_RECYCLE_MS,
  teardownLiveVideoRef,
  useLiveCamera,
} from "~/features/signage/nx/useLiveCamera";
import { checkinAlert } from "~/features/signage/briefing/desk-alerts";
import { briefingReadyForHolding, briefingTimelineAt } from "~/features/signage/briefing/phase";
import {
  pullIsLate,
  pullVerdict,
  type PullRefusal,
} from "~/features/signage/briefing/pull-to-room";
import {
  buildStageRail,
  heatIsPastTheDesk,
  type StageRow,
} from "~/features/signage/briefing/stage-rail";
import { startHoldRemainingMs, startHoldSeconds } from "~/features/signage/briefing/start-hold";
import {
  BRIEFING_ROOMS,
  resolveFilmTier,
  tierForRaceType,
  type BriefingRoom,
} from "~/features/signage/briefing/types";
import { holdingAvailability } from "~/features/signage/pit/holding-availability";
import { useRaceClockForTrack } from "~/features/racing/use-race-clocks";
import { liveHeatNumber } from "~/features/signage/briefing/room-return";
import { useBriefingControl, type CameraTarget } from "../checkin/useBriefingControl";

const ROOM_COLOR: Record<BriefingRoom, string> = { red: "#ff5a52", blue: "#4a9bff" };
const TRACK_COLOR: Record<string, string> = { red: "#ff5a52", blue: "#4a9bff", mega: "#a06bff" };
const GREEN = "#4ade80";
const AMBER = "#f0b341";
/** The desk board's own red (RaceControlPanels), so the two admin surfaces speak
 *  one language — staff who learn it at the desk read it here without being told. */
const DANGER = "#ff4d4f";
const INK = "#e8eef7";

/** Where this tablet's room choice is remembered, so the bare URL is bookmarkable
 *  and a reload (including the self-update below) comes back to the same room. */
const ROOM_STORAGE_KEY = "ft-briefing-room";

/** Which holding camera belongs to a room. Keyed off the PHYSICAL room, never
 *  the track: on a Mega day the track is "mega" and there is no such camera,
 *  but the room a tablet is bolted to never changes. */
function holdingCameraFor(room: BriefingRoom): CameraTarget {
  return room === "red" ? "holding-red" : "holding-blue";
}

/** "red" → "Red", for a button that names a room in a sentence. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** mm:ss from ms. Tabular figures do the rest — see .brc-num. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
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

const STYLES = `
.brc-btn {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  width: 100%; min-height: 64px; padding: 0 20px;
  border: 1px solid transparent; border-radius: 13px;
  font-size: 20px; font-weight: 800; letter-spacing: 0.01em; line-height: 1.15;
  cursor: pointer; text-align: center;
  transition: filter 120ms ease, transform 60ms ease, background 140ms ease;
}
.brc-btn:hover:not(:disabled) { filter: brightness(1.12); }
.brc-btn:active:not(:disabled) { transform: translateY(2px); filter: brightness(0.94); }
.brc-btn:focus-visible { outline: 3px solid ${INK}; outline-offset: 3px; }
.brc-btn:disabled { opacity: 0.32; cursor: not-allowed; filter: none; }
.brc-btn[aria-busy="true"] { cursor: progress; }
/* The secondary action. Present, reachable, and audibly quieter than the one the
   screen is actually asking for. */
.brc-btn-ghost {
  min-height: 46px; font-size: 15px; font-weight: 700; border-radius: 11px;
  background: transparent; color: ${PORTAL_DARK.muted};
  border-color: ${PORTAL_DARK.border};
}
.brc-btn-ghost:hover:not(:disabled) { background: ${PORTAL_DARK.hover}; color: ${INK}; }
/* A HELD BUTTON IS NOT AN UNAVAILABLE ONE — it is yours to press, in six seconds,
   and the number on its face is the point. Same rule as the desk board's .rcb-hold. */
.brc-btn-hold:disabled { opacity: 1; filter: saturate(0.45) brightness(0.85); cursor: wait; }
.brc-spin {
  width: 20px; height: 20px; border-radius: 50%;
  border: 3px solid currentColor; border-top-color: transparent;
  animation: brc-spin 650ms linear infinite;
}
@keyframes brc-spin { to { transform: rotate(360deg); } }
.brc-num { font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }

/* ONE HEADER RULE ACROSS EVERY PANEL. The hairline spans the full card, so the
   three headings sit on one line and everything under them starts at the same
   height — the alignment the screen was missing when the panels each began
   wherever their own content did (owner 2026-08-16: "keep things aligned"). */
.brc-head {
  font-size: 11px; font-weight: 800; letter-spacing: 0.12em;
  color: ${PORTAL_DARK.muted};
  margin: 0 -20px; padding: 0 20px 11px;
  border-bottom: 1px solid ${PORTAL_DARK.border};
}
/* THE CAPTION UNDER A BUTTON IS ALWAYS RENDERED, invisible when it has nothing
   to say, so two panels keep a shared footer baseline and no control hops when a
   reason appears. Same trick as the keypad's error line below. */
.brc-why { font-size: 13px; font-weight: 700; text-align: center; min-height: 18px; }

/* THE SESSION RAIL — six equal rows, so the eye runs straight down the stage
   names and straight down the sessions, and an empty stage takes exactly as much
   room as a full one. A column that reshuffled between polls would read as
   groups moving. */
.brc-stage {
  display: grid; grid-template-columns: 64px 1fr; align-items: center;
  gap: 0 10px; min-height: 52px; padding: 6px 0;
  border-bottom: 1px solid ${withAlpha(PORTAL_DARK.border, 0.55)};
}
.brc-stage:last-child { border-bottom: 0; }

/* THE MOMENT THE ROOM IS DONE. The film has ended, the group is getting kitted,
   and the only remaining job is to walk them to the seats — so the button that
   does that asks for a hand. Slow (1.5s): an invitation, never an alarm. */
.brc-ready { animation: brc-ready 1.5s ease-in-out infinite; }
@keyframes brc-ready {
  0%, 100% { box-shadow: 0 0 0 0 ${withAlpha(GREEN, 0)}; }
  50%      { box-shadow: 0 0 0 7px ${withAlpha(GREEN, 0.22)}; }
}

/* THE HEAT IS COMPLETE — GO AND GET THEM. The one signal on this screen that is
   about a group who are NOT in the room yet, so it has to carry across a room
   nobody is looking at the tablet in. Same 1.4s beat as the desk board's
   .rc-flash-ready, deliberately: staff who learn it at the desk read it here
   without being told. */
.brc-band-ready { animation: brc-band-ready 1.4s ease-in-out infinite; }
@keyframes brc-band-ready {
  0%, 100% { border-color: ${withAlpha(GREEN, 0.4)}; background-color: ${withAlpha(GREEN, 0.06)}; }
  50%      { border-color: ${GREEN};                 background-color: ${withAlpha(GREEN, 0.2)}; }
}
/* Out of time. Never red — red on these boards means a missed deadline that
   costs a race, and the check-in window closing is a nudge, not an incident. */
.brc-band-late { animation: brc-band-late 1.1s ease-in-out infinite; }
@keyframes brc-band-late {
  0%, 100% { border-color: ${withAlpha(AMBER, 0.4)}; background-color: ${withAlpha(AMBER, 0.06)}; }
  50%      { border-color: ${AMBER};                 background-color: ${withAlpha(AMBER, 0.22)}; }
}
/* HOLDING IS FULL — THE ONE REFUSAL ON THIS SCREEN THAT COSTS A GROUP.
   Red, and blinking, at the owner's call (2026-08-15). This is the exception the
   .brc-band-late note carves out: red here is not a nudge, it is the missed
   deadline itself. Sending anyway is what put Blue 66 on a track it had never
   been on and wiped it off every board that night — the seats were occupied and
   the screen said so only in small amber text under a dead button.
   Same 1.4s beat as .brc-band-ready — one beat per canvas. */
.brc-holding-full { animation: brc-holding-full 1.4s ease-in-out infinite; }
@keyframes brc-holding-full {
  0%, 100% { border-color: ${withAlpha(DANGER, 0.45)}; background-color: ${PORTAL_DARK.card}; }
  50%      { border-color: ${DANGER};                  background-color: ${withAlpha(DANGER, 0.14)}; }
}
/* A staff alert must never be motion-only: reduced motion keeps the colour and
   drops the pulse, so the band still reads. */
@media (prefers-reduced-motion: reduce) {
  .brc-ready, .brc-band-ready, .brc-band-late, .brc-holding-full { animation: none; }
  .brc-band-ready { border-color: ${GREEN}; background-color: ${withAlpha(GREEN, 0.16)}; }
  .brc-band-late { border-color: ${AMBER}; background-color: ${withAlpha(AMBER, 0.18)}; }
  .brc-holding-full { border-color: ${DANGER}; background-color: ${withAlpha(DANGER, 0.12)}; }
}

/* THE KEYPAD. 76px keys in the 3x4 arrangement of every phone and door lock in
   the building — a staff member should not have to look at their hand. */
.brc-key {
  display: flex; align-items: center; justify-content: center;
  min-height: 76px; border-radius: 13px;
  border: 1px solid ${PORTAL_DARK.inputBorder}; background: ${PORTAL_DARK.inputBg};
  color: ${INK}; font-size: 27px; font-weight: 700; cursor: pointer;
  transition: filter 100ms ease, transform 50ms ease;
}
.brc-key:hover { filter: brightness(1.18); }
.brc-key:active { transform: translateY(1px); filter: brightness(0.9); }
.brc-key:focus-visible { outline: 3px solid ${INK}; outline-offset: 2px; }
.brc-key-quiet {
  background: transparent; color: ${PORTAL_DARK.muted};
  font-size: 15px; font-weight: 700;
}
/* A wrong code is felt before it is read — the shake lands while the eye is
   still on the keypad. Paired with the amber text, never motion alone. */
.brc-shake { animation: brc-shake 260ms ease-in-out; }
@keyframes brc-shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-7px); }
  75%      { transform: translateX(7px); }
}
@media (prefers-reduced-motion: reduce) { .brc-shake { animation: none; } }

.brc-lb { animation: brc-fade 130ms ease-out; }
@keyframes brc-fade { from { opacity: 0; } to { opacity: 1; } }
`;

/**
 * HOW MANY OF THE CALLED HEAT ARE THROUGH THE DESK.
 *
 * The same endpoint and the same 15-second cadence the check-in station itself
 * polls (`action=session-stats`), because it is the same question — and the route
 * holds a shared 10s cache with a single-flight lock in front of Pandora, so a
 * room tablet joining in costs a cache read rather than another fan-out.
 *
 * FIFTEEN SECONDS IS NOT A COMPROMISE HERE. A racer scanning in moves this by
 * one, and the decision it feeds — walk over and fetch the group — is taken on a
 * scale of minutes. Polling it at the board's 5s would triple the traffic to
 * watch a number that changes when a person physically reaches the desk.
 */
interface SessionStat {
  sessionId: number | string;
  checkedIn: number;
  total: number;
  /** Square location id — stats rows now include HP arena sessions (FM +
   *  Naples). Naples runs a separate BMI server whose sessionIds can
   *  numerically collide with FastTrax heats, so racing matches must
   *  exclude Naples rows. */
  locationId?: string;
}

/** HeadPinz Naples — the one stats location whose sessionId namespace is
 *  NOT shared with the FastTrax racing feed this board matches against. */
const HP_NAPLES_LOCATION_ID = "PPTR5G2N0QXF7";

function useSessionStats(token: string, enabled: boolean): SessionStat[] {
  const [stats, setStats] = useState<SessionStat[]>([]);
  useVisibleInterval(
    async (signal) => {
      try {
        const res = await fetch(
          `/api/admin/checkin?token=${encodeURIComponent(token)}&action=session-stats`,
          { cache: "no-store", signal },
        );
        if (!res.ok || signal.aborted) return;
        const data = (await res.json()) as { sessions?: unknown };
        // A dropped poll keeps the last good counts rather than blanking the
        // band — the same posture as every other poller on these boards.
        if (Array.isArray(data.sessions)) setStats(data.sessions as SessionStat[]);
      } catch {
        /* silent — the band simply holds its last numbers */
      }
    },
    15_000,
    enabled,
  );
  return stats;
}

/**
 * WHICH ROOM THIS DEVICE LAST CHOSE, read from localStorage.
 *
 * useSyncExternalStore rather than a read-in-an-effect, because the server has no
 * localStorage: it renders the server snapshot (null — the picker), then React
 * re-renders with the device's own answer, with no hydration mismatch and no
 * cascading setState. The subscribe callback is a no-op on purpose — the value is
 * written once during setup and only ever re-read on a fresh load.
 */
const NO_STORE_SUBSCRIBE = () => () => {};

function useStoredRoom(): BriefingRoom | null {
  return useSyncExternalStore(
    NO_STORE_SUBSCRIBE,
    () => {
      try {
        const saved = window.localStorage.getItem(ROOM_STORAGE_KEY);
        return saved === "red" || saved === "blue" ? saved : null;
      } catch {
        // No storage (private mode, locked-down kiosk browser) — the picker is
        // the fallback, which is a perfectly good outcome.
        return null;
      }
    },
    () => null,
  );
}

/** A local 1-second clock, so the readouts tick between the board's 5s polls. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(iv);
  }, []);
  return now;
}

/**
 * WHO IS CHECKING IN, AND ARE THEY ALL HERE YET (owner 2026-08-15: "it should
 * have the status of the race checking in so they know when to pull").
 *
 * THIS IS THE ONLY THING ON THE SCREEN ABOUT PEOPLE WHO ARE NOT IN THE ROOM, and
 * it is what turns the tablet from a pair of buttons into something worth
 * glancing at between briefings. Whoever runs this room has to walk to the desk
 * and fetch the next group; until now the only way to know they were all through
 * was to go and look.
 *
 * SO THE BAND'S JOB IS ONE VERDICT — go now, or not yet — and everything on it
 * serves that:
 *   • the FRACTION, not a percentage: "9 of 12" is a number of humans still
 *     walking towards the desk, which is what the decision is actually about;
 *   • GREEN AND PULSING the moment the heat is complete, because that is the
 *     instant the walk should start and nobody is staring at the tablet waiting
 *     for it;
 *   • THE WINDOW'S OWN COUNTDOWN, read from the same per-track signage config the
 *     track TV in front of the racers is counting down (checkinWindowMins), so
 *     the room and the wall never disagree about how long is left;
 *   • and it stands down entirely once the heat has been sent to a room — a
 *     group already in a briefing room is not a group to pull, and a band still
 *     shouting about them would send somebody to fetch people who had arrived.
 */
function CheckInBand({
  trackKey,
  race,
  stat,
  windowMins,
  sentToRoom,
  nowMs,
  trailing,
  late,
}: {
  trackKey: string;
  race: { heatNumber: number; raceType: string; calledAt: string; sessionId: number } | null;
  stat: SessionStat | null;
  windowMins: number | undefined;
  /** Which room this heat has already gone to, if any. */
  sentToRoom: BriefingRoom | null;
  nowMs: number;
  /**
   * WHY THE PULL IS NOT ON OFFER, when the heat is otherwise ready — in practice
   * always "this room still has somebody in it". It rides here rather than in
   * the room panel because that panel is busy saying what the CURRENT group is
   * doing, and this is about the next one.
   */
  trailing?: ReactNode;
  /** The pull would go in late — see pullIsLate. Amber, never red: it is a
   *  nudge about the clock, not a refusal. */
  late?: boolean;
}) {
  const accent = TRACK_COLOR[trackKey] ?? INK;

  const shell = (children: ReactNode, flash?: string) => (
    <div
      className={flash}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        margin: "18px 22px 0",
        padding: "14px 20px",
        borderRadius: 14,
        border: `1px solid ${PORTAL_DARK.border}`,
        background: PORTAL_DARK.card,
      }}
      aria-label="Checking in"
    >
      {children}
    </div>
  );

  const label = (
    <span
      style={{
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.12em",
        color: accent,
        flexShrink: 0,
      }}
    >
      CHECKING IN · {trackKey.toUpperCase()}
    </span>
  );

  // Nothing called. Said plainly rather than hidden: an empty band is a band
  // staff can trust, whereas one that disappears is one they wonder about.
  if (!race) {
    return shell(
      <>
        {label}
        <span style={{ fontSize: 17, fontWeight: 700, color: PORTAL_DARK.muted }}>
          No heat is checking in right now.
        </span>
      </>,
    );
  }

  const heat = `Session ${race.heatNumber}${race.raceType ? ` · ${race.raceType}` : ""}`;

  // Already sent — there is nobody to fetch, so the band goes quiet.
  if (sentToRoom) {
    return shell(
      <>
        {label}
        <span style={{ fontSize: 19, fontWeight: 800 }}>{heat}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 16, fontWeight: 700, color: PORTAL_DARK.muted }}>
          Already in the {sentToRoom} room
        </span>
      </>,
    );
  }

  const calledAtMs = Date.parse(race.calledAt);
  const sinceCalledMs = Number.isFinite(calledAtMs) ? nowMs - calledAtMs : NaN;
  const alert = checkinAlert(sinceCalledMs, windowMins ?? 0);
  const remainingMs =
    Number.isFinite(sinceCalledMs) && windowMins ? windowMins * 60_000 - sinceCalledMs : null;

  // A total of zero is a roster we could not read, NOT an empty heat — so it
  // must never be allowed to read as "everybody is here".
  const total = stat?.total ?? 0;
  const checkedIn = stat?.checkedIn ?? 0;
  const ready = total > 0 && checkedIn >= total;

  const pill =
    ready && late
      ? // Complete, and going in late — the pill says which of the two matters,
        // because "READY" beside a race with two minutes left reads as reassurance.
        { text: "PULL NOW — RUNNING LATE", color: "#1c1204", bg: AMBER }
      : ready
        ? { text: "READY TO PULL", color: "#062012", bg: GREEN }
        : alert === "late"
          ? { text: "WINDOW CLOSED", color: "#1c1204", bg: AMBER }
          : alert === "warn"
            ? { text: "LAST MINUTE", color: "#1c1204", bg: AMBER }
            : { text: "CHECKING IN", color: PORTAL_DARK.fg, bg: PORTAL_DARK.muted2 };

  return shell(
    <>
      {label}
      <span style={{ fontSize: 19, fontWeight: 800 }}>{heat}</span>

      <div style={{ flex: 1 }} />

      {/* THE FRACTION — the number of people, not a progress bar. */}
      <span
        className="brc-num"
        style={{ fontSize: 30, fontWeight: 800, color: ready ? GREEN : PORTAL_DARK.fg }}
      >
        {total > 0 ? `${checkedIn}/${total}` : "—"}
        <span style={{ fontSize: 12, fontWeight: 700, color: PORTAL_DARK.muted }}> CHECKED IN</span>
      </span>

      {remainingMs != null && (
        <span
          className="brc-num"
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: alert === "none" ? PORTAL_DARK.muted : AMBER,
          }}
        >
          {remainingMs > 0 ? clock(remainingMs) : "0:00"}
          <span style={{ fontSize: 11, fontWeight: 700, color: PORTAL_DARK.muted }}> LEFT</span>
        </span>
      )}

      <span
        style={{
          padding: "7px 15px",
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: "0.06em",
          background: pill.bg,
          color: pill.color,
        }}
      >
        {pill.text}
      </span>

      {trailing}
    </>,
    ready && late
      ? "brc-band-late"
      : ready
        ? "brc-band-ready"
        : alert === "late"
          ? "brc-band-late"
          : undefined,
  );
}

/**
 * WHERE EVERY SESSION ON THIS TRACK IS — the rail down the side (owner
 * 2026-08-16: "on the side of the tablet can we also show where each group is
 * for that track… sort of like the nothing to seat screens have the sessions and
 * where").
 *
 * IT IS THE PIT BOARD'S OWN IDLE SCREEN, and deliberately not a second take on
 * it: both call buildStageRail, so the wall the racers are reading and the
 * tablet the staff member is holding cannot describe the same night in different
 * words. Everything it needs was already being polled here for the Holding panel
 * and the band — no new request.
 *
 * THE ROW THE BUTTON ACTS ON IS MARKED. Called is where the pull lands, so it
 * wears the room's colour; the five rows under it are context — how far the
 * group ahead has got — and stay quiet.
 */
function StageRail({
  rows,
  accent,
  markHeat,
}: {
  rows: StageRow[];
  accent: string;
  /** The heat this screen's button is about, highlighted wherever it sits. */
  markHeat: number | null;
}) {
  const toneColor = (tone: StageRow["tone"]): string =>
    tone === "good"
      ? GREEN
      : tone === "warn"
        ? AMBER
        : tone === "alert"
          ? DANGER
          : PORTAL_DARK.muted;

  return (
    <section
      style={{
        flex: "0 0 250px",
        display: "flex",
        flexDirection: "column",
        padding: "20px",
        borderRadius: 18,
        background: PORTAL_DARK.card,
        border: `1px solid ${PORTAL_DARK.border}`,
      }}
      aria-label="Where each session is"
    >
      <p className="brc-head">WHERE EACH SESSION IS</p>
      {rows.map((row) => {
        const here = markHeat != null && row.heatNumber === markHeat;
        return (
          <div
            key={row.label}
            className="brc-stage"
            style={
              here
                ? {
                    margin: "0 -20px",
                    paddingLeft: 17,
                    paddingRight: 20,
                    background: withAlpha(accent, 0.08),
                    borderLeft: `3px solid ${accent}`,
                  }
                : undefined
            }
          >
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: here ? accent : PORTAL_DARK.muted,
              }}
            >
              {row.label}
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                className="brc-num"
                style={{
                  display: "block",
                  fontSize: 16,
                  fontWeight: 800,
                  color: row.heatNumber == null ? withAlpha(INK, 0.3) : INK,
                }}
              >
                {row.value}
                {row.type && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: PORTAL_DARK.muted,
                      marginLeft: 6,
                    }}
                  >
                    {row.type}
                  </span>
                )}
              </span>
              {row.detail && (
                <span style={{ display: "block", fontSize: 11, color: toneColor(row.tone) }}>
                  {row.detail}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/**
 * THE HEAT NUMBER IS THE CODE (owner 2026-08-15: "use session number as the
 * pass… lets do the heat number in the room").
 *
 * The ask began as a fixed staff PIN and the owner replaced it with something
 * better on both counts. A shared 14501 is a number that gets written on the wall
 * beside the tablet within a fortnight, is the same in both rooms, is the same
 * next season, and is one more thing to remember at 9pm. The heat number is none
 * of those: it is DIFFERENT FOR EVERY GROUP, it expires the moment they leave,
 * and there is nothing to memorise because it is printed on this very screen in
 * 46px type.
 *
 * IT IS NOT A SECRET AND MUST NOT BE TREATED AS ONE — the number is displayed
 * deliberately (owner: "show the heat number on the screen"). This is the
 * type-the-name-to-delete gesture: it costs nothing if you are the person running
 * this room and looking at it, and it is not something a hand brushing past or a
 * child playing with a wall tablet produces. Actual authentication is the admin
 * token in the URL, gated by middleware.
 *
 * AND IT MAKES THE STAFF MEMBER READ THE ROOM BEFORE ACTING, which is the quiet
 * second benefit: you cannot send Session 60 to holding while thinking about
 * Session 59, because the digits you type have to match the group in front of you.
 *
 * THE ACTION IS HELD, NOT RE-DERIVED. The caller hands over a closure that runs
 * only on a match, so there is no path where the prompt is dismissed and
 * something fires anyway.
 *
 * NO HEAT NUMBER, NO PUZZLE. A session that arrived without one (it is nullable
 * all the way from Pandora) falls back to a plain confirm — a control that cannot
 * be operated is worse than one that merely asks twice.
 */
function HeatPrompt({
  label,
  heatNumber,
  onPass,
  onCancel,
}: {
  /** What is about to happen — "Start video". Named so the prompt can never be
   *  mistaken for a generic unlock of the whole screen. */
  label: string;
  /** The group in the room. Null ⇒ confirm-only, see the header. */
  heatNumber: number | null;
  onPass: () => void;
  onCancel: () => void;
}) {
  const [entry, setEntry] = useState("");
  const [wrong, setWrong] = useState(false);
  const code = heatNumber != null ? String(heatNumber) : "";

  const press = (digit: string) => {
    if (!code || entry.length >= code.length) return;
    const next = entry + digit;
    setWrong(false);
    if (next.length < code.length) {
      setEntry(next);
      return;
    }
    // The last digit decides — no Enter key to find with a group waiting.
    // Nothing is remembered on success: the next press asks again.
    if (next === code) {
      setEntry("");
      onPass();
    } else {
      setEntry("");
      setWrong(true);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="brc-lb"
      role="dialog"
      aria-modal="true"
      aria-label={`Enter the staff code to ${label.toLowerCase()}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        // Deliberately NOT opaque: the heat number is on the screen behind this,
        // and the prompt asking for it must not be the thing that hides it.
        background: "rgba(4,7,13,0.86)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          padding: 26,
          borderRadius: 20,
          background: PORTAL_DARK.card,
          border: `1px solid ${PORTAL_DARK.border}`,
        }}
      >
        {/* THE PROMPT NEVER NAMES ITS OWN ANSWER (owner 2026-08-15: "don't say
            enter the heat number"). Staff know what the code is; a caption
            spelling it out would hand it to every guest who glanced at the
            tablet, and the number is on the wall behind it. So this asks for "the
            code" and says no more. */}
        <div style={{ textAlign: "center" }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.12em",
              color: PORTAL_DARK.muted,
            }}
          >
            STAFF CODE
          </p>
          <p style={{ fontSize: 24, fontWeight: 800, marginTop: 4 }}>{label}</p>
        </div>

        {/* NO HEAT NUMBER ⇒ NO PUZZLE. A confirm button, not a locked screen —
            see the header. */}
        {!code ? (
          <button
            type="button"
            className="brc-btn"
            style={{ background: GREEN, borderColor: GREEN, color: "#062012", minHeight: 82 }}
            onClick={onPass}
          >
            Confirm
          </button>
        ) : (
          <>
            {/* DOTS, NOT DIGITS. Echoing what is typed would print the answer
                directly beneath the number it was copied from, which is the one
                thing that would teach a watching guest the trick. The dots still
                say how many digits are expected — the only thing the keypad
                cannot say for itself. */}
            <div
              className={wrong ? "brc-shake" : undefined}
              style={{ display: "flex", justifyContent: "center", gap: 13, minHeight: 22 }}
              aria-live="polite"
              aria-label={`${entry.length} of ${code.length} digits entered`}
            >
              {Array.from({ length: code.length }, (_, i) => (
                <span
                  key={i}
                  style={{
                    width: 17,
                    height: 17,
                    borderRadius: "50%",
                    background: i < entry.length ? INK : "transparent",
                    border: `2px solid ${wrong ? AMBER : i < entry.length ? INK : PORTAL_DARK.border}`,
                  }}
                />
              ))}
            </div>

            <p
              style={{
                textAlign: "center",
                minHeight: 20,
                fontSize: 14,
                fontWeight: 700,
                color: wrong ? AMBER : "transparent",
              }}
              role="status"
            >
              {wrong ? "Wrong code — try again" : "."}
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 11 }}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} type="button" className="brc-key" onClick={() => press(d)}>
                  {d}
                </button>
              ))}
              <button
                type="button"
                className="brc-key brc-key-quiet"
                onClick={onCancel}
                aria-label="Cancel"
              >
                Cancel
              </button>
              <button type="button" className="brc-key" onClick={() => press("0")}>
                0
              </button>
              <button
                type="button"
                className="brc-key brc-key-quiet"
                onClick={() => {
                  setEntry("");
                  setWrong(false);
                }}
                aria-label="Clear what I typed"
              >
                <IconBackspace size={24} stroke={2.2} aria-hidden />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── the screen ───────────────────────────────────────────────────────── */

export default function BriefingRoomClient({
  token,
  version,
  room: roomFromUrl,
}: {
  token: string;
  version: string;
  /** Null until this tablet has been told which room it is. */
  room: BriefingRoom | null;
}) {
  /**
   * THE ROOM THIS TABLET IS, remembered locally.
   *
   * A wall screen is set up once and then reloads on its own (see the build
   * check below), so the choice has to survive a reload without the URL carrying
   * it. The URL still WINS when present — that is what makes the two bookmarks
   * work — and a bare visit falls back to what this device last chose.
   */
  const storedRoom = useStoredRoom();
  // Writing it back is a pure "update an external system" effect — no state, so
  // no cascading render. Reading is the other direction, and lives in the store
  // hook above rather than in an effect, so hydration matches on the server.
  useEffect(() => {
    if (!roomFromUrl) return;
    try {
      window.localStorage.setItem(ROOM_STORAGE_KEY, roomFromUrl);
    } catch {
      /* private mode — the URL is carrying it anyway */
    }
  }, [roomFromUrl]);

  const room = roomFromUrl ?? storedRoom;

  // The board hook is the same one the desk runs. Enabled only once a room is
  // known, so the picker makes no admin requests at all.
  const control = useBriefingControl(token, !!room);
  const nowMs = useNowMs();
  // A MINUTE, not the two-minute default: this is a wall fixture whose whole
  // update path is this poll, and /api/kiosk/version is a single cached string.
  const build = useBuildUpdate(version, 60_000);
  // 2s cadence reads the warm Redis carry (cacheOnly), never live Pandora — see
  // useTrackStatus. This is what names the heat currently checking in.
  const status = useTrackStatus(2_000);
  const sessionStats = useSessionStats(token, !!room);

  /**
   * SELF-UPDATE, BUT NEVER MID-BRIEFING.
   *
   * The same problem the desk board has — a tablet opened in April is still
   * running April's code — with a stricter safety rule, because this screen is
   * a wall fixture nobody is watching between presses. It reloads only when the
   * room is genuinely idle: no session in it, nothing in flight, no code prompt
   * open. A reload while a group is mid-film costs nothing on the wall (the TV
   * derives its own timeline) but would blank the control in the hand of whoever
   * is about to press Send to holding.
   */
  const roomStatus = room ? (control.board?.rooms.find((r) => r.room === room) ?? null) : null;
  const state = roomStatus?.state ?? null;

  /**
   * THE ACTION WAITING ON A CODE. One at a time — there is one person holding
   * this tablet — and it holds the closure rather than a description of what to
   * do, so the prompt cannot fire a stale version of an action whose arguments
   * moved on underneath it (see HeatPrompt).
   */
  const [challenge, setChallenge] = useState<{
    label: string;
    run: () => void;
    /**
     * WHICH HEAT NUMBER UNLOCKS IT. Carried per action rather than read off the
     * room, because the pull is about a group who are NOT in the room yet: its
     * code is the incoming heat, and the room's own number is either absent (it
     * is empty) or belongs to somebody else entirely.
     */
    code: number | null;
  } | null>(null);
  // Plain, not useCallback: the React Compiler memoizes it correctly on its own,
  // and a hand-written [] dep list here is one it refuses to preserve.
  const ask = (label: string, code: number | null, run: () => void) =>
    setChallenge({ label, code, run });

  /**
   * WHICH TRACK THIS ROOM IS WATCHING FOR ITS NEXT GROUP.
   *
   * The room's own session decides it while one is in here. With the room empty
   * it falls to the track of the same name — EXCEPT on a Mega night, when the two
   * circuits run as one and both rooms serve it, so there is no red or blue heat
   * to watch and the band would sit empty all evening.
   *
   * UP HERE, ABOVE THE ROOM PICKER'S EARLY RETURN, because the race clock below
   * is a hook and hooks cannot be called after one. A tablet that has not been
   * told which room it is passes null and gets no clock.
   */
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;
  const incomingTrack: "red" | "blue" | "mega" =
    state?.track ?? (megaEnabled ? "mega" : (room ?? "red"));

  /**
   * THE RACE ON TRACK — the same clock the desk board and the leaderboards run,
   * derived from the venue broadcast rather than the cloud socket's countdown.
   *
   * It costs this screen almost nothing: use-race-clocks is a module-level store
   * with one fetch loop shared by every subscriber on the page, ticked locally
   * and corrected for this tablet's own clock skew. A wall device left running
   * for weeks keeps bad time, and a countdown ninety seconds out is worse than
   * none at all.
   */
  const raceClock = useRaceClockForTrack(room ? incomingTrack : null);

  /**
   * SAFE TO RELOAD RIGHT NOW? (owner 2026-08-15: "make this screen live update on
   * new pushes".)
   *
   * DELIBERATELY NOT "IS THE ROOM EMPTY". The first cut required an idle room,
   * copying the desk board's caution — and the caution does not transfer. That
   * board carries a serial scanner, a scan flash and a settings sheet, so a
   * reload there is disruptive; this screen has none of those, and the room's TV
   * derives its whole timeline from Redis, so reloading a tablet mid-film changes
   * nothing a guest can see. Requiring an empty room on a busy Saturday means a
   * fix pushed at 7pm reaches these tablets some time after closing.
   *
   * So the only things that hold a reload are things a PERSON is in the middle
   * of: an action in flight, and the code prompt (reloading under a half-typed
   * code would look like the tablet rejecting them). Both clear in seconds.
   */
  const safeToReload = !control.busy && !challenge;
  // PRIMITIVES in the dependency list, never the `build` object — useBuildUpdate
  // returns a fresh literal every render and this page re-renders at least once
  // a second (useNowMs), so depending on the object re-armed the 4s timer every
  // tick and the reload NEVER fired: these tablets ran whatever build was live
  // the day someone opened them. Same shape as PitClient / CheckInClient.
  const buildReady = build.ready;
  const buildStale = build.staleUptime;
  const buildReloadNow = build.reloadNow;
  useEffect(() => {
    // A stale tab reloads the same way a new build does — the reload is this
    // tablet's only memory amnesty, and a quiet week must not mean never.
    if ((!buildReady && !buildStale) || !safeToReload) return;
    // Long enough for the pill in the header to be read as an explanation for
    // the screen blinking, short enough that the new build is genuinely live.
    const t = setTimeout(buildReloadNow, 4_000);
    return () => clearTimeout(t);
  }, [buildReady, buildStale, buildReloadNow, safeToReload]);

  const startCb = control.start;
  const sendToHoldingCb = control.sendToHolding;
  const onStart = useCallback(
    (restart: boolean) => {
      if (room) startCb(room, { restart });
    },
    [startCb, room],
  );

  /* ── the room picker, for a tablet nobody has set up yet ──────────── */

  if (!room) {
    return (
      <main
        style={{
          minHeight: "100dvh",
          background: PORTAL_DARK.bodyGradient,
          color: PORTAL_DARK.fg,
          fontFamily: ADMIN_SANS,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
          padding: 32,
        }}
      >
        <style>{STYLES}</style>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.01em" }}>
            Which room is this screen in?
          </h1>
          <p style={{ marginTop: 8, fontSize: 15, color: PORTAL_DARK.muted }}>
            Tap once. This tablet will remember it.
          </p>
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
          {BRIEFING_ROOMS.map((r) => (
            <a
              key={r}
              href={`/admin/${encodeURIComponent(token)}/briefing?room=${r}`}
              className="brc-btn"
              style={{
                width: 260,
                minHeight: 150,
                textDecoration: "none",
                background: withAlpha(ROOM_COLOR[r], 0.16),
                borderColor: ROOM_COLOR[r],
                color: INK,
                fontSize: 30,
              }}
            >
              {r.toUpperCase()} ROOM
            </a>
          ))}
        </div>
      </main>
    );
  }

  /* ── the room itself ──────────────────────────────────────────────── */

  const board = control.board;
  const accent = ROOM_COLOR[room];
  // Derived locally at 1s rather than read off the 5s poll, so the clocks tick
  // smoothly — and from the SAME pure function the TV in this room is running.
  const timeline = briefingTimelineAt(state, nowMs);
  const phase = timeline.phase;
  const holdMs = startHoldRemainingMs(state, nowMs);
  const holdSec = startHoldSeconds(holdMs);

  const track = state?.track ?? room;
  const lane = board?.lanes?.[track] ?? null;
  const occupant = lane?.holding ?? null;
  const occupantIsOurs = !!occupant && !!state && occupant.sessionId === state.sessionId;
  // How long they have been sitting there. Null unless the stamp is real and
  // sane — a clock that counts up from a garbage number is worse than no clock.
  const occupantSinceMs =
    occupant && Number.isFinite(occupant.atMs) && nowMs > occupant.atMs
      ? nowMs - occupant.atMs
      : null;

  /**
   * MAY THIS GROUP GO TO THE SEATS? The server's own rule, run here so the button
   * can explain itself instead of failing on press. `lane` is the RESOLVED lane
   * off the board poll, which is what the rule needs — see holding-availability.
   */
  const verdict = state
    ? holdingAvailability({
        holding: lane?.holding,
        racing: lane?.racing,
        pitIn: lane?.pitIn,
        sessionId: state.sessionId,
      })
    : null;
  /**
   * THE FILM IS A GATE, NOT A SUGGESTION (owner 2026-08-15). Sending mid-video
   * walks a group out of the safety briefing they are required to have seen.
   * The rule is pure and lives with the timeline, so the server can grow the
   * same refusal without a second copy of it.
   */
  const briefingReady = briefingReadyForHolding(timeline);
  const canSendToHolding = !!state && verdict?.ok === true && briefingReady.ok;
  /**
   * HOLDING IS FULL — say it loudly, not in footnote amber.
   *
   * Same verdict the button already reads, so the box and the button can never
   * disagree; this only changes how hard it is to miss. `holdingAvailability`
   * refuses on exactly one condition — somebody is in the seats who has not gone
   * out — so a false verdict IS "full", and the occupant is non-null whenever
   * this is true.
   *
   * DELIBERATELY THE SEATS ALONE, not `!canSendToHolding` — the film still
   * running is a different refusal with its own words, and blinking HOLDING FULL
   * at a room whose seats are empty would be a lie.
   */
  const holdingFull = !!state && verdict?.ok === false;
  const occupantAccent = holdingFull ? DANGER : occupantIsOurs ? GREEN : AMBER;
  // The film is over and they are getting kitted — the one moment this screen
  // exists to catch.
  const readyToMove = phase === "helmet" && canSendToHolding;

  const pending = control.pending;
  const startKey = state?.kind === "timeline" ? `restart:${room}` : `start:${room}`;
  const sessionLabel = state?.heatNumber != null ? `Session ${state.heatNumber}` : "This group";

  const incomingLane = board?.lanes?.[incomingTrack] ?? null;
  const trackHeatNumber = raceClock ? liveHeatNumber(raceClock.heatName) : null;

  /**
   * THE HEAT CHECKING IN FOR THIS ROOM'S TRACK — once, and only while it really
   * is checking in (owner 2026-08-16: "why is this briefing board still showing
   * 37 in room, it has moved on").
   *
   * THE CALLED RECORD OUTLIVES THE RACE. Pandora keeps its entry ~20 minutes
   * after the call and our own Redis carry holds it for up to six hours, or
   * until the NEXT heat on that track is called — whichever is longer
   * (races-current.server). That is right for the check-in boards a guest reads
   * and wrong here: on a quiet track, Session 37 went to the room, to the seats,
   * to the karts and out onto the tarmac while this screen still called it the
   * incoming group and printed "Already in the red room" over a dead button. The
   * rail beside it had 37 correctly on ON TRACK the whole time, because
   * buildStageRail already refuses to leave a moved-on heat in Called — the band
   * and the pull panel simply never asked the same question.
   *
   * So they ask it here, ONCE, at the top: a heat the lane can see in the seats,
   * the karts, on track or in the pit is not the heat checking in, and every
   * consumer below inherits that. The band falls to "No heat is checking in
   * right now", the pull refuses with `no-heat`, and the rail is unchanged.
   *
   * DELIBERATELY THE LANE, NOT THE BRIEFING ROOMS. A heat sitting in a room IS
   * still this band's business — "Already in the blue room" is exactly what the
   * red room's staff member needs to know — and only stops being so once the
   * group has physically left it.
   */
  const incomingRace = heatIsPastTheDesk(
    status?.currentRaces?.[incomingTrack]?.heatNumber,
    incomingLane,
  )
    ? null
    : (status?.currentRaces?.[incomingTrack] ?? null);
  // Matched on SESSION, never on the track label: the two feeds word tracks
  // differently and a mismatched string would silently show no count at all.
  const incomingStat =
    (incomingRace &&
      sessionStats.find(
        (s) =>
          String(s.sessionId) === String(incomingRace.sessionId) &&
          // incomingRace is a FastTrax heat — never match a Naples arena
          // row whose separate BMI server minted the same numeric id.
          s.locationId !== HP_NAPLES_LOCATION_ID,
      )) ||
    null;
  const incomingSentTo = incomingRace
    ? (control.board?.briefedSessions?.[String(incomingRace.sessionId)]?.room ?? null)
    : null;

  /**
   * WHERE EVERY SESSION ON THIS TRACK IS. Built by the pit board's own builder —
   * see StageRail. Both briefing rooms are handed in on a Mega night, when the
   * two of them serve the single circuit.
   */
  const railRooms = megaEnabled
    ? BRIEFING_ROOMS.map((r) => board?.rooms.find((x) => x.room === r)?.state ?? null)
    : [state];
  const railRows = buildStageRail({
    called: incomingRace
      ? { heatNumber: incomingRace.heatNumber, raceType: incomingRace.raceType }
      : null,
    rooms: railRooms,
    lane: incomingLane,
    nowMs,
    liveHeatNumber: trackHeatNumber,
    liveCounting: raceClock?.phase === "running",
    liveRemainingMs: raceClock?.liveRemainingMs ?? null,
    formatClock: clock,
    checkedIn: incomingStat
      ? { checkedIn: incomingStat.checkedIn, total: incomingStat.total }
      : null,
  });

  /**
   * IS A PULL GOING IN LATE — under five minutes of race left, so the film will
   * still be running when the seats are wanted (owner 2026-08-16). A warning, and
   * only ever a warning: with the group standing in front of you, pulling late
   * usually still beats not pulling.
   */
  const pullLate = pullIsLate({
    remainingMs: raceClock?.liveRemainingMs ?? null,
    pitInOccupied: !!incomingLane?.pitIn,
    onTrack: trackHeatNumber != null || !!incomingLane?.racing,
  });

  /**
   * THE WARNING'S TWO NUMBERS. "2:40 left" is only a clock; it becomes a
   * decision beside "the film runs 4:30".
   *
   * The film is the one this heat will ACTUALLY get — tier from the race type,
   * then the Pro→Intermediate fallback — read from the same manifest the send
   * resolves against, so the warning cannot quote a film the room will not play.
   * With no length recorded the headline still fires and the tail simply stops.
   */
  const incomingTier = resolveFilmTier(
    tierForRaceType(incomingRace?.raceType),
    (t) => !!board?.videos?.[t]?.url,
  );
  const incomingFilmMs = board?.videos?.[incomingTier]?.durationMs ?? null;
  const raceLeftMs = raceClock?.liveRemainingMs ?? null;
  const lateHeadline =
    raceLeftMs != null && raceLeftMs > 0 && trackHeatNumber != null
      ? `Session ${trackHeatNumber} ends in ${clock(raceLeftMs)}.`
      : raceLeftMs != null && raceLeftMs > 0
        ? `The race ends in ${clock(raceLeftMs)}.`
        : "The track is waiting.";
  const lateTail = incomingFilmMs
    ? `The ${incomingTier} film runs ${clock(incomingFilmMs)} — pull now and the track waits on this room.`
    : "Pull now and the film will still be running when the seats are wanted.";

  /** THE ONE RULE, and its sentences. Pure, shared, tested — pull-to-room.ts. */
  const pull = pullVerdict({
    enabled: board?.enabled,
    incoming: incomingRace
      ? { sessionId: String(incomingRace.sessionId), heatNumber: incomingRace.heatNumber }
      : null,
    sentToRoom: incomingSentTo,
    inRoomHeatNumber: state?.heatNumber ?? null,
    roomOccupied: !!state,
    checkedIn: incomingStat
      ? { checkedIn: incomingStat.checkedIn, total: incomingStat.total }
      : null,
    late: pullLate,
  });

  const sendCb = control.send;
  const onPull = () => {
    if (!incomingRace) return;
    sendCb({
      room,
      // The track the HEAT belongs to, which on a Mega night is the shared
      // circuit rather than this room's name.
      track: incomingTrack,
      sessionId: String(incomingRace.sessionId),
      heatNumber: incomingRace.heatNumber,
      raceType: incomingRace.raceType,
    });
  };

  /** Why the pull is not on offer, in the words the room would use. Null when
   *  there is nothing worth saying — an empty track needs no explanation. */
  const pullRefusal = (reason: PullRefusal): string | null => {
    const short = incomingStat ? Math.max(0, incomingStat.total - incomingStat.checkedIn) : 0;
    switch (reason) {
      case "not-all-checked-in":
        return `${incomingStat?.checkedIn ?? 0} of ${incomingStat?.total ?? 0} checked in — ${short} still to scan.`;
      case "no-roster":
        return "Waiting on the roster — the desk has no count for this heat yet.";
      case "room-occupied":
        return state?.heatNumber != null
          ? `Session ${state.heatNumber} is still in this room — send them to holding first.`
          : "This room still has a group in it — send them to holding first.";
      case "already-sent":
        return `Already in the ${incomingSentTo} room.`;
      case "disabled":
        return "Briefing rooms are switched off.";
      case "no-heat":
        return null;
    }
  };


/**
 * THE HOLDING SEATS, ON THE ROOM'S OWN TABLET (owner 2026-08-17: "add holding
 * area to the tablets in briefing rooms").
 *
 * A CAMERA WAS HERE ONCE AND WAS CUT ON SIGHT — 2026-08-15, "remove camera for
 * now it looks like crap". That verdict was about a picture, not the idea: the
 * old one was a 208px still box borrowed from the desk board, dropped into a
 * panel built for large type at arm's length, refreshing once a second so it
 * read as a broken image rather than a view. So this is not that camera back.
 *
 * What is different, and why it is worth a second try:
 *  - IT MOVES. 480p h264 video, the same rail the desk board now plays, rather
 *    than a still that changes when you are not looking at it.
 *  - IT IS SIZED FOR THE ROOM. Full panel width, 16:9, on a tablet a marshal
 *    reads from across a briefing room — not a thumbnail.
 *  - IT ANSWERS THIS PANEL'S QUESTION. The panel already says WHO is in the
 *    seats; the picture says whether they are actually sitting in them, which
 *    is the thing the marshal is about to walk out and check.
 *
 * It stays under the desk-wide Stills setting, and falls back to the same
 * still refresh as everything else if live cannot start — a tablet must never
 * show a black rectangle where the seats were.
 */
function HoldingView({
  target,
  label,
  accent,
  getLiveUrl,
  liveCameras,
}: {
  target: CameraTarget;
  label: string;
  accent: string;
  getLiveUrl: (target: CameraTarget, res?: LiveResolution) => Promise<string | null>;
  liveCameras: boolean;
}) {
  const live = useLiveCamera(target, getLiveUrl, {
    enabled: liveCameras,
    resolution: MOTION_RESOLUTION,
    recycleMs: LIVE_RECYCLE_MS,
  });
  // 640 wide is plenty for the fallback: it is a bridge to video, not the view.
  const { src, offline } = useCameraStill(
    `/api/tv/camera?room=${target}&w=640`,
    2_000,
    !live.playing,
    6_000,
  );

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          borderRadius: 10,
          overflow: "hidden",
          background: "#05070d",
          border: `1px solid ${withAlpha(accent, 0.3)}`,
        }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={label}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: live.playing ? 0 : 1,
              filter: offline ? "grayscale(0.6) brightness(0.6)" : "none",
            }}
          />
        ) : (
          !live.playing && (
            <span
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                color: PORTAL_DARK.muted,
              }}
            >
              Connecting to the camera…
            </span>
          )
        )}
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
            onError={live.retry}
            onEnded={live.retry}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: live.playing ? 1 : 0,
            }}
          />
        )}
        <span
          aria-hidden
          style={{
            position: "absolute",
            bottom: 8,
            left: 9,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 9px",
            borderRadius: 999,
            background: "rgba(8,12,20,0.78)",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.06em",
            color: offline ? "#ffb020" : PORTAL_DARK.muted,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: offline ? "#ffb020" : accent,
            }}
          />
          {offline ? "RECONNECTING…" : `${live.playing ? "LIVE · " : ""}${label.toUpperCase()}`}
        </span>
      </div>
    </div>
  );
}

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
        fontFamily: ADMIN_SANS,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{STYLES}</style>

      {/* ── header ───────────────────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
          padding: "14px 24px",
          borderBottom: `1px solid ${PORTAL_DARK.border}`,
          background: withAlpha(accent, 0.07),
        }}
      >
        <span
          aria-hidden
          style={{ width: 14, height: 14, borderRadius: "50%", background: accent, flexShrink: 0 }}
        />
        <h1 style={{ fontSize: 23, fontWeight: 800, letterSpacing: "0.01em" }}>
          {room.toUpperCase()} ROOM
        </h1>
        {state && (
          <span
            style={{
              padding: "5px 13px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: "0.05em",
              background: withAlpha(TRACK_COLOR[track] ?? accent, 0.18),
              color: TRACK_COLOR[track] ?? accent,
              border: `1px solid ${withAlpha(TRACK_COLOR[track] ?? accent, 0.5)}`,
            }}
          >
            {track.toUpperCase()} TRACK
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Says the screen is ABOUT to blink, so a reload that lands while
            somebody is looking at it reads as an update rather than a fault. */}
        {build.ready && (
          <span style={{ fontSize: 12, fontWeight: 700, color: AMBER }}>
            {safeToReload ? "Updating…" : "Update ready — finishing up"}
          </span>
        )}
        {/* The escape hatch for a tablet set to the wrong room. Small on purpose:
            it is a setup control, pressed once in the life of the screen. */}
        <a
          href={`/admin/${encodeURIComponent(token)}/briefing?room=${room === "red" ? "blue" : "red"}`}
          style={{ fontSize: 12, color: PORTAL_DARK.muted, textDecoration: "underline" }}
        >
          switch to {room === "red" ? "blue" : "red"}
        </a>
        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>v{version}</span>
      </header>

      {/* The briefing kill switch is thrown — say so plainly rather than letting
          staff press controls that will 503. */}
      {board?.enabled === false && (
        <div
          style={{
            padding: "12px 24px",
            background: withAlpha(AMBER, 0.16),
            borderBottom: `1px solid ${AMBER}`,
            fontSize: 15,
            fontWeight: 700,
            color: AMBER,
          }}
        >
          Briefing rooms are switched off — nothing on this screen will send.
        </div>
      )}

      {/* WHO IS AT THE DESK — the only thing here about people not yet in the
          room, and the reason to glance at this screen between briefings. */}
      <CheckInBand
        trackKey={incomingTrack}
        race={incomingRace}
        stat={incomingStat}
        windowMins={board?.checkinWindowMins?.[incomingTrack]}
        sentToRoom={incomingSentTo}
        nowMs={nowMs}
        late={pullLate}
        trailing={
          /* THE ROOM IS BUSY AND THE NEXT HEAT IS READY. Said here, quietly,
             rather than as a second big button: while a group is in the room the
             screen has one thing to ask for, and it is not this. */
          !pull.ok && pull.reason === "room-occupied" ? (
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: PORTAL_DARK.muted,
                border: `1px solid ${PORTAL_DARK.border}`,
                borderRadius: 999,
                padding: "6px 13px",
              }}
            >
              {pullRefusal("room-occupied")}
            </span>
          ) : undefined
        }
      />

      {/* ── body: the room on the left, holding on the right ─────────── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          gap: 20,
          padding: 22,
          flexWrap: "wrap",
          alignItems: "stretch",
        }}
      >
        {/* ── IN THE ROOM ──────────────────────────────────────────── */}
        <section
          style={{
            flex: "3 1 460px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
            padding: 24,
            borderRadius: 18,
            background: PORTAL_DARK.card,
            border: `1px solid ${state ? withAlpha(accent, 0.55) : PORTAL_DARK.border}`,
          }}
          aria-label="In the room"
        >
          {!state ? (
            /**
             * AN EMPTY ROOM IS WHERE THE PULL LIVES (owner 2026-08-16).
             *
             * This panel used to be a grey "No group in this room" and a
             * sentence explaining that the front desk would send one — a whole
             * half of the screen spent saying that nothing was happening, to the
             * person best placed to make something happen. Now it is the press,
             * and the sentence is only what remains when the press is not
             * available.
             */
            <>
              <p className="brc-head">NEXT IN THIS ROOM</p>

              {incomingRace ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: 9,
                        padding: "5px 16px",
                        borderRadius: 13,
                        background: withAlpha(pull.ok && !pullLate ? GREEN : accent, 0.15),
                        border: `2px solid ${pull.ok ? (pullLate ? AMBER : GREEN) : accent}`,
                        color: INK,
                        fontSize: 38,
                        fontWeight: 800,
                        letterSpacing: "-0.02em",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.1em" }}>
                        HEAT
                      </span>
                      <span className="brc-num">{incomingRace.heatNumber}</span>
                    </span>
                    {incomingRace.raceType && (
                      <span
                        style={{
                          fontSize: 24,
                          fontWeight: 700,
                          color: pull.ok ? (pullLate ? AMBER : GREEN) : accent,
                        }}
                      >
                        {incomingRace.raceType}
                      </span>
                    )}
                  </div>

                  {/* THE COUNT, in its own strip — a fact about the group, not a
                      heading, and the one the button turns on. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 12,
                      flexWrap: "wrap",
                      padding: "10px 14px",
                      borderRadius: 12,
                      background: "rgba(0,0,0,0.18)",
                      border: `1px solid ${PORTAL_DARK.border}`,
                    }}
                  >
                    <span
                      className="brc-num"
                      style={{
                        fontSize: 27,
                        fontWeight: 800,
                        color: pull.ok ? GREEN : INK,
                      }}
                    >
                      {incomingStat && incomingStat.total > 0
                        ? `${incomingStat.checkedIn} of ${incomingStat.total}`
                        : "—"}
                    </span>
                    <span
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: pull.ok ? GREEN : PORTAL_DARK.muted,
                      }}
                    >
                      {pull.ok
                        ? "everyone is through the desk"
                        : (pullRefusal(pull.reason) ?? "waiting on the desk")}
                    </span>
                  </div>

                  {/* THE LATE WARNING — two numbers or it is just a clock. The
                      film's length comes from the manifest for the tier this
                      heat will actually get, so it is the real film and not an
                      average. */}
                  {pull.ok && pull.late && (
                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                        padding: "11px 13px",
                        borderRadius: 11,
                        background: withAlpha(AMBER, 0.12),
                        border: `1px solid ${withAlpha(AMBER, 0.55)}`,
                      }}
                      role="status"
                    >
                      <IconAlertTriangleFilled
                        size={17}
                        style={{ flexShrink: 0, color: AMBER, marginTop: 2 }}
                        aria-hidden
                      />
                      <span style={{ fontSize: 14, lineHeight: 1.4 }}>
                        <b style={{ color: AMBER }}>{lateHeadline}</b> {lateTail}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    gap: 12,
                  }}
                >
                  <p style={{ fontSize: 30, fontWeight: 800, color: PORTAL_DARK.muted }}>
                    No group in this room
                  </p>
                  <p style={{ fontSize: 15, color: PORTAL_DARK.muted, maxWidth: 420 }}>
                    {board
                      ? "Nothing is checking in for this track yet. The next heat will appear here."
                      : "Connecting to the board…"}
                  </p>
                  {/* Who is still out and due back — an idle room is not a free
                      room if its last group is mid-race with the kit. */}
                  {roomStatus?.groupOut?.heatNumber != null && !roomStatus.groupOut.endedAtMs && (
                    <p style={{ fontSize: 14, color: AMBER, fontWeight: 700 }}>
                      Session {roomStatus.groupOut.heatNumber} is still out on track.
                    </p>
                  )}
                </div>
              )}

              <div style={{ flex: 1 }} />

              {incomingRace && (
                <>
                  <button
                    type="button"
                    className={`brc-btn${pull.ok && !pullLate ? " brc-ready" : ""}`}
                    style={{
                      background: pull.ok ? (pullLate ? AMBER : GREEN) : PORTAL_DARK.muted2,
                      borderColor: pull.ok ? (pullLate ? AMBER : GREEN) : PORTAL_DARK.border,
                      color: pull.ok ? (pullLate ? "#1c1204" : "#062012") : PORTAL_DARK.fg,
                    }}
                    disabled={!pull.ok || control.busy}
                    aria-busy={pending === `send:${room}`}
                    onClick={() =>
                      ask(
                        `Pull to the ${room} room`,
                        // THE CODE IS THE INCOMING HEAT, not the room's own — the
                        // room is empty, so there is no other number it could
                        // mean, and this one is printed above the overlay.
                        incomingRace.heatNumber,
                        onPull,
                      )
                    }
                  >
                    {pending === `send:${room}` ? (
                      <span className="brc-spin" aria-hidden />
                    ) : (
                      <IconArrowRight size={24} stroke={2.6} aria-hidden />
                    )}
                    {pull.ok && pullLate
                      ? `Pull Session ${incomingRace.heatNumber} anyway`
                      : `Pull Session ${incomingRace.heatNumber} to the ${cap(room)} Room`}
                  </button>
                  {/* Always rendered, invisible when empty, so this panel's
                      footer and Holding's stay on one baseline. */}
                  <p
                    className="brc-why"
                    style={{ color: pull.ok ? "transparent" : AMBER }}
                    role={pull.ok ? undefined : "status"}
                  >
                    {pull.ok ? "·" : (pullRefusal(pull.reason) ?? "·")}
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              <p className="brc-head">IN THE ROOM</p>
              <div>
                {/* THE HEAT NUMBER, BIG (owner 2026-08-15: "show the heat number
                    on the screen"). It is the room's identity at a glance AND the
                    code the prompt asks for, so it has to be readable from
                    wherever in the room the tablet is mounted — never a detail
                    somebody has to walk over and squint at. */}
                <p
                  style={{
                    fontSize: 42,
                    fontWeight: 800,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.1,
                    marginTop: 4,
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    flexWrap: "wrap",
                  }}
                >
                  {state.heatNumber != null && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: 9,
                        padding: "6px 18px",
                        borderRadius: 14,
                        background: withAlpha(accent, 0.18),
                        border: `2px solid ${accent}`,
                        color: INK,
                      }}
                    >
                      <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.1em" }}>
                        HEAT
                      </span>
                      <span className="brc-num">{state.heatNumber}</span>
                    </span>
                  )}
                  {state.heatNumber == null && sessionLabel}
                  {state.raceType && (
                    <span style={{ color: accent, fontWeight: 700, fontSize: 34 }}>
                      {state.raceType}
                    </span>
                  )}
                </p>
              </div>

              {/* THE STATE, IN ONE LINE plus its clock. */}
              {phase === "waiting" && (
                <p style={{ fontSize: 21, fontWeight: 700, color: AMBER }}>
                  {/* NOBODY SITS IN A BRIEFING ROOM (owner 2026-08-15: "they
                      don't sit"). The line told staff to do something the room
                      has no furniture for, which makes the rest of the sentence
                      easy to distrust. The real wait is for the group to finish
                      arriving. */}
                  Waiting to start — once everyone is in, roll the film.
                </p>
              )}
              {phase === "video" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span style={{ fontSize: 21, fontWeight: 700, color: GREEN }}>
                      Safety video playing
                    </span>
                    <span className="brc-num" style={{ fontSize: 34, fontWeight: 800 }}>
                      {clock(timeline.nextInMs ?? 0)}
                      <span style={{ fontSize: 14, fontWeight: 700, color: PORTAL_DARK.muted }}>
                        {" "}
                        LEFT
                      </span>
                    </span>
                  </div>
                  {/* Progress is derived from the same arithmetic as the wall, so
                      the bar and the film cannot disagree. */}
                  <div
                    style={{
                      height: 12,
                      borderRadius: 999,
                      background: PORTAL_DARK.muted2,
                      overflow: "hidden",
                    }}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                      timeline.videoMs > 0
                        ? Math.round((timeline.videoOffsetMs / timeline.videoMs) * 100)
                        : 0
                    }
                    aria-label="Safety video progress"
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${timeline.videoMs > 0 ? Math.min(100, (timeline.videoOffsetMs / timeline.videoMs) * 100) : 0}%`,
                        background: GREEN,
                        transition: "width 1s linear",
                      }}
                    />
                  </div>
                </div>
              )}
              {phase === "helmet" && (
                <p style={{ fontSize: 21, fontWeight: 700, color: GREEN }}>
                  Briefing complete — helmet sizes are on the screen.
                </p>
              )}
              {phase === "idle" && (
                <p style={{ fontSize: 19, fontWeight: 700, color: PORTAL_DARK.muted }}>
                  This assignment has timed out. Ask the desk to send them again.
                </p>
              )}

              <div style={{ flex: 1 }} />

              {/* THE PRIMARY ACTION, or the quiet one, depending on the phase. */}
              {state.kind === "assigned" ? (
                <button
                  type="button"
                  className={`brc-btn${holdMs > 0 ? " brc-btn-hold" : ""}`}
                  style={{ background: GREEN, borderColor: GREEN, color: "#062012" }}
                  disabled={control.busy || holdMs > 0}
                  aria-busy={pending === startKey}
                  onClick={() => ask("Start video", state.heatNumber, () => onStart(false))}
                >
                  {pending === startKey ? (
                    <span className="brc-spin" aria-hidden />
                  ) : (
                    <IconPlayerPlayFilled size={28} aria-hidden />
                  )}
                  {holdMs > 0 ? `Start video in ${holdSec}s` : "Start video"}
                </button>
              ) : (
                <button
                  type="button"
                  className="brc-btn brc-btn-ghost"
                  disabled={control.busy}
                  aria-busy={pending === startKey}
                  onClick={() => ask("Play the video again", state.heatNumber, () => onStart(true))}
                >
                  {pending === startKey ? (
                    <span className="brc-spin" aria-hidden />
                  ) : (
                    <IconRefresh size={20} aria-hidden />
                  )}
                  Play the video again
                </button>
              )}
              {/* Keeps this panel's footer on the same baseline as Holding's,
                  whose button carries a reason line. */}
              <p className="brc-why" style={{ color: "transparent" }}>
                ·
              </p>
            </>
          )}
        </section>

        {/* ── HOLDING ──────────────────────────────────────────────── */}
        <section
          className={holdingFull ? "brc-holding-full" : undefined}
          style={{
            flex: "2 1 380px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            padding: 24,
            borderRadius: 18,
            background: PORTAL_DARK.card,
            border: `1px solid ${readyToMove ? withAlpha(GREEN, 0.55) : PORTAL_DARK.border}`,
          }}
          aria-label="Holding"
        >
          <p className="brc-head" style={holdingFull ? { color: DANGER } : undefined}>
            HOLDING · {room.toUpperCase()}
          </p>

          {/* THE HEADLINE, not a footnote. `role="alert"` so the words reach a
              screen reader the moment the seats fill — the blink cannot. */}
          {holdingFull && (
            <p
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 27,
                fontWeight: 800,
                letterSpacing: "0.02em",
                color: DANGER,
              }}
            >
              <IconAlertTriangleFilled size={25} style={{ flexShrink: 0 }} aria-hidden />
              HOLDING FULL
            </p>
          )}

          {/**
           * WHO IS IN THE SEATS (owner 2026-08-15: "show who is in holding if
           * anyone"). This REPLACED a camera preview, which the owner cut on
           * sight — and the name is the better answer anyway. A fisheye
           * thumbnail could only ever show that shapes were sitting there; the
           * question the button actually asks is WHICH GROUP is in the way, and
           * a heat number answers it exactly, at a glance, in a room where the
           * tablet is on a wall several feet from the reader.
           *
           * OUR OWN GROUP READS GREEN, ANYONE ELSE AMBER. The same panel is both
           * the confirmation that a send landed ("Session 59 — this room's
           * group") and the explanation of why the button is dead ("Session 27",
           * still sitting there). One control, two meanings, told apart by
           * colour rather than by reading.
           */}
          {occupant ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "16px 18px",
                borderRadius: 14,
                background: withAlpha(occupantAccent, 0.1),
                border: `1px solid ${withAlpha(occupantAccent, 0.5)}`,
              }}
            >
              <p
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  letterSpacing: "-0.01em",
                  color: occupantAccent,
                }}
              >
                {occupant.heatNumber != null ? `Session ${occupant.heatNumber}` : "A group"}
                {occupant.raceType && (
                  <span style={{ fontSize: 20, fontWeight: 700 }}> · {occupant.raceType}</span>
                )}
              </p>
              <p style={{ fontSize: 14, color: PORTAL_DARK.muted }}>
                {occupantIsOurs ? "This room's group — in the seats" : "In the seats"}
                {/* Only ever counted from a stamp we actually have; a missing
                    atMs prints nothing rather than "in the seats 0:00". */}
                {occupantSinceMs != null && (
                  <span className="brc-num"> · {clock(occupantSinceMs)}</span>
                )}
                {occupant.room && !occupantIsOurs && ` · from the ${occupant.room} room`}
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 21, fontWeight: 700, color: PORTAL_DARK.muted }}>
              Nobody is in the holding seats.
            </p>
          )}

          {/* WHERE THE LAST GROUP GOT TO — the quiet line that explains when the
              seats will free up, and nothing more. The desk board is the place
              to see the whole lane; this room only needs to know whether the
              blocker is about to move. */}
          {(lane?.karts || lane?.racing) && (
            <p style={{ fontSize: 13, color: PORTAL_DARK.muted }}>
              {lane.racing?.heatNumber != null
                ? `Session ${lane.racing.heatNumber} is on track.`
                : lane.karts?.heatNumber != null
                  ? `Session ${lane.karts.heatNumber} is in the karts.`
                  : ""}
            </p>
          )}

          {/* THE SEATS THEMSELVES. Above the spacer, so it sits with the words
              about holding rather than floating over the button. */}
          <HoldingView
            target={holdingCameraFor(room)}
            label={`${room} holding`}
            accent={accent}
            getLiveUrl={control.liveCameraUrl}
            liveCameras={parseCameraPreviewMode(control.board?.cameraPreview?.mode) === "live"}
          />

          <div style={{ flex: 1 }} />

          {/**
           * THE FILM USED TO BE RESTATED HERE — a status line, a countdown and a
           * progress bar of its own (owner 2026-08-15: "Also show video status in
           * there please"). That was right at the time: the room panel's clock is
           * on the far side of the screen, and "can I move them yet" is asked with
           * a finger over THIS button.
           *
           * It is not right any more. With the session rail added down the side
           * the film was being told three times at once (owner 2026-08-16: "why
           * show safety video playing twice"), and the third telling was the one
           * that had another copy two inches away. So the box is gone and its one
           * irreplaceable part — the exact time left, where the hand is — moved
           * into the refusal line under the button, which had to say something
           * anyway. Same `timeline` arithmetic, still never a second derivation.
           */}

          {/* THE SECOND PRESS. Inert with its reason on it rather than failing
              on push — see the header. */}
          <button
            type="button"
            className={`brc-btn${readyToMove ? " brc-ready" : ""}`}
            style={{
              background: canSendToHolding ? GREEN : PORTAL_DARK.muted2,
              borderColor: canSendToHolding ? GREEN : PORTAL_DARK.border,
              color: canSendToHolding ? "#062012" : PORTAL_DARK.fg,
            }}
            disabled={!canSendToHolding || control.busy || board?.enabled === false}
            aria-busy={pending === `holding:${room}`}
            onClick={() => {
              if (!state) return;
              ask("Send to holding", state.heatNumber, () =>
                sendToHoldingCb({
                  room,
                  track: state.track,
                  sessionId: state.sessionId,
                  heatNumber: state.heatNumber,
                  raceType: state.raceType,
                }),
              );
            }}
          >
            {pending === `holding:${room}` ? (
              <span className="brc-spin" aria-hidden />
            ) : (
              <IconArrowRight size={26} stroke={2.6} aria-hidden />
            )}
            Send to holding
          </button>

          {/**
           * WHY IT IS INERT — one line, always rendered, so the footer never
           * shifts and the panel opposite keeps its baseline. Never a silent dead
           * button: either there is nobody to send, or somebody is in the way and
           * this says who.
           *
           * ONE SENTENCE, NOT TWO. The seats and the film are both refusals and
           * both used to print; two coloured sentences under one dead button is a
           * puzzle rather than an explanation, so the seats win — they are the
           * one a staff member has to do something about — and the film's line
           * appears only when the seats are clear.
           *
           * THE FILM'S LINE CARRIES THE CLOCK now that the box above it is gone:
           * the exact time left, in the panel the button lives in.
           */}
          <p
            className="brc-why"
            style={{
              color: !state
                ? PORTAL_DARK.muted
                : verdict && !verdict.ok
                  ? DANGER
                  : !briefingReady.ok
                    ? AMBER
                    : "transparent",
            }}
            role="status"
          >
            {!state
              ? "Nobody is in this room to send."
              : verdict && !verdict.ok
                ? verdict.error
                : !briefingReady.ok
                  ? briefingReady.reason === "video-playing"
                    ? `${clock(timeline.nextInMs ?? 0)} of the safety video left — they cannot go to the seats until it finishes.`
                    : "Roll the film first. This group has not had the safety briefing yet."
                  : "·"}
          </p>
        </section>

        {/* ── WHERE EACH SESSION IS ────────────────────────────────── */}
        <StageRail
          rows={railRows}
          accent={accent}
          // The heat this screen's button is about — the one being pulled while
          // the room is empty, otherwise the group in the room.
          markHeat={state?.heatNumber ?? incomingRace?.heatNumber ?? null}
        />
      </div>

      {/* The action receipt — the hook's own note, which is also where a server
          refusal lands if two screens race each other. */}
      {control.note && (
        <div
          style={{
            padding: "12px 24px",
            borderTop: `1px solid ${PORTAL_DARK.border}`,
            fontSize: 16,
            fontWeight: 700,
            color: control.note.startsWith("✕") ? AMBER : GREEN,
          }}
          role="status"
        >
          {control.note}
        </div>
      )}

      {challenge && (
        <HeatPrompt
          label={challenge.label}
          heatNumber={challenge.code}
          onPass={() => {
            // Closed BEFORE the action runs, so the screen is already back on the
            // room when the button's own spinner appears.
            setChallenge(null);
            challenge.run();
          }}
          onCancel={() => setChallenge(null)}
        />
      )}
    </main>
  );
}
