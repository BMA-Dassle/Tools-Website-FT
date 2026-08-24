"use client";

/**
 * A live CCTV monitor board for a briefing room — camera on the left, the big
 * clocks on the right and bottom, matching the original design.
 *
 *   ┌──────────────────────┬──────────────────────┐
 *   │  camera (this room)   │   ON-TRACK session   │
 *   │   + which session is  │   clock, HUGE, on     │
 *   │   briefing + video    │   the track's colour  │
 *   │   time remaining      ├──────────────────────┤
 *   │                       │ CHECKING IN  6 / 14   │
 *   ├──────────────────────┴──────────────────────┤
 *   │   Blue Track — On Time   (track delay, big)   │
 *   └──────────────────────────────────────────────┘
 *
 * WHY STILLS, NOT A STREAM. The app is serverless: a proxy that pipes MJPEG for
 * hours is a function killed at its duration cap. So the board pulls ONE frame at
 * a time from /api/tv/camera and asks again a second later — plenty for a monitor,
 * and it holds no connection open.
 *
 * EVERY CLOCK COMES FROM THE SAME SOURCE THE REST OF THE ESTATE USES: the on-track
 * session from the leaderboards websocket, the delay from /api/track-status, the
 * briefing video countdown from the same Redis room-state the briefing TVs read
 * (briefingTimelineAt), the check-in counts from the same heats and the same
 * roster the check-in station itself counts. So a monitor never disagrees with
 * the walls beside it, or with the station down the corridor.
 *
 * NO FLICKER: each frame is decoded off-screen and swapped in only when ready. A
 * board never goes black or lies — stale frames grey out and say "Reconnecting",
 * and a board with no camera shows a calm setup notice.
 */
import { useMemo } from "react";
import { IconVideoOff, IconAlertTriangleFilled, IconPointFilled } from "@tabler/icons-react";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import { trackDisplay, verdictLabel } from "~/features/racing/on-time-display";
import { withAlpha } from "../color";
import { useCameraStill } from "../useCameraStill";
import { formatRemaining, useLiveSessionClock, type LiveSessionClock } from "../live-session";
import {
  TRACK_ACCENTS,
  TRACK_LABELS,
  effectiveTrack,
  trackFromName,
  type TrackKey,
} from "../track";
import {
  checkinRailState,
  readyToSend,
  roomCheckinProgress,
  sessionLabel,
  waitingMs,
  type CheckinProgressSession,
} from "../checkin-progress";
import { briefingTimelineAt } from "../briefing/phase";
import { buildStageRail, type StageRow } from "../briefing/stage-rail";
import { sendWindow } from "../briefing/pull-to-room";
import { liveHeatNumber } from "../briefing/room-return";
import { resolveFilmTier, tierForRaceType, type BriefingRoomState } from "../briefing/types";
import type { SceneProps } from "../director/types";
import type { TvFeed } from "../types";

const PAD = 56;
/** New frame roughly once a second (owner: ~1 fps). */
const REFRESH_MS = 1000;
/** How long frames may fail before the board admits it is reconnecting. */
const STALE_AFTER_MS = 8000;

/** Track names as they fit on a chip — the label without the word "Track",
 *  which every chip on this board would otherwise repeat. */
const TRACK_SHORT: Record<TrackKey, string> = { blue: "Blue", red: "Red", mega: "Mega" };

const ON_TIME_GREEN = "#22c55e";
const BEHIND_AMBER = "#f0b341";

export function SceneCameraMonitor({ feed, config, nowMs }: SceneProps) {
  const cam = config.cameraMonitor;
  // The proxy is addressed by SCREEN, not by camera id — the server maps the
  // screen to its one allowlisted camera, so the client never names a device.
  const screenId = feed?.screen?.screenId ?? null;

  // Track clocks. On a Mega day a Blue/Red board follows the combined circuit,
  // the same rule every racing board uses. Both hooks are safe with a null track.
  const status = useTrackStatus();
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;
  const track = cam?.track ? effectiveTrack(cam.track, megaEnabled) : null;
  const sessionClock = useLiveSessionClock(track);

  // Which session is in THIS briefing room, and where the safety video is up to.
  // The room is the board's own track (a Blue camera watches the Blue room); Mega
  // has no single room, so it carries no briefing line.
  const room = cam?.track === "blue" || cam?.track === "red" ? cam.track : null;
  const briefState: BriefingRoomState | null = room ? (feed?.briefingRooms?.[room] ?? null) : null;

  // The shared still-poller: double-buffered decode, one live blob at a time,
  // and a hang watchdog — a frame that never answers can no longer freeze the
  // board on its last picture (see useCameraStill).
  const { src, offline } = useCameraStill(
    cam?.deviceId && screenId
      ? `/api/tv/camera?screen=${encodeURIComponent(screenId)}&w=1920`
      : null,
    REFRESH_MS,
    true,
    STALE_AFTER_MS,
  );

  // A camera board with no camera chosen cannot know what to show. Say so calmly.
  /**
   * THE RAIL THIS BOARD NOW SHOWS — the same builder the pit signs and the
   * briefing rooms run (owner 2026-08-24), so three surfaces cannot describe
   * one night differently. Above BOTH early returns — hooks run in the same order every render.
   */
  const railRows = useMemo(() => {
    const railTrack = track ?? "mega";
    const called = status?.currentRaces?.[railTrack] ?? null;
    const vids = feed?.briefing?.videos ?? null;
    const filmTier = resolveFilmTier(
      tierForRaceType(called?.raceType ?? null),
      (t) => !!vids?.[t]?.url,
    );
    const count = feed?.raceCheckin;
    return buildStageRail({
      called,
      // On a Mega night the one circuit is fed by both rooms.
      rooms: (railTrack === "mega" ? (["red", "blue"] as const) : ([railTrack] as const)).map(
        (r) => feed?.briefingRooms?.[r as "red" | "blue"] ?? null,
      ),
      lane: feed?.pitLanes?.[railTrack] ?? null,
      // THE TICKING CLOCK, NOT THE FEED'S STAMP (owner 2026-08-24: "why don't we
      // show real timer there?"). `feed.now` is the server clock as of the last
      // 15-second poll, so every countdown built from it sat frozen and then
      // jumped a quarter-minute — which is exactly why this rail used to round
      // the film to whole minutes. The director's `nowMs` is `Date.now()` plus
      // the shared server offset, reticked every 250ms: same authority, live.
      nowMs,
      liveHeatNumber: sessionClock ? liveHeatNumber(sessionClock.heatName) : null,
      liveCounting: sessionClock?.counting === true,
      liveRemainingMs: sessionClock?.remainingMs ?? null,
      formatClock: fmtRailClock,
      checkedIn:
        count && count.checkedIn != null && count.total != null
          ? { checkedIn: count.checkedIn, total: count.total }
          : null,
      brief: sendWindow({
        remainingMs: sessionClock?.remainingMs ?? null,
        onTrack: !!sessionClock || !!feed?.pitLanes?.[railTrack]?.racing,
        onTrackHeatNumber: sessionClock ? liveHeatNumber(sessionClock.heatName) : null,
        filmMs: vids?.[filmTier]?.durationMs ?? null,
        pitPost: null,
        attribution: "this-room",
      }),
    });
  }, [track, status?.currentRaces, feed, nowMs, sessionClock]);

  if (!cam?.deviceId) return <Unconfigured />;

  const label = cam.label || "Live camera";
  const accent = track ? TRACK_ACCENTS[track] : "#2b8fff";
  const camera = (
    <CameraImage
      src={src}
      label={label}
      offline={offline}
      fit={track ? "contain" : "cover"}
      briefing={<BriefingStrip state={briefState} nowMs={nowMs} accent={accent} />}
    />
  );

  // No track ⇒ a plain full-bleed camera (a lobby cam). The clocks only make

  // sense for a board tied to a track.
  if (!track) {
    return (
      <div style={{ position: "absolute", inset: 0, background: "#000", overflow: "hidden" }}>
        {camera}
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#000",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/*
          Camera, left. Contained (not cropped) so the whole fisheye reads —
          and NARROWER THAN HALF (owner 2026-08-24: "taking up a bit more of
          the camera side"). The camera answers one question, is anybody in
          that room, and it answers it fine at 42%; the rail beside it is six
          rows of text read from across a corridor, so the width goes where
          the reading is.
        */}
        <div style={{ position: "relative", width: "42%", background: "#000", overflow: "hidden" }}>
          {camera}
        </div>
        {/*
          WHERE EVERY SESSION IS, replacing the flat field of accent colour
          that used to carry one clock (owner 2026-08-24). The clock survives
          in the corner — it was the one number on that panel worth a glance —
          and is now also a row, so the two cannot disagree. Everything else
          the panel showed was already a row here, and the four stages it never
          showed come for free.
        */}
        <RailPane
          accent={accent}
          trackLabel={TRACK_LABELS[track]}
          clock={sessionClock}
          rows={railRows}
          returning={feed?.checkinReturning ?? null}
          nowMs={nowMs}
        />
      </div>
      {/* The status bar gives ground back when a returning panel is up — it is
          the one block on this board whose whole message survives at half the
          size (owner 2026-08-14: "you could also make the on-time block smaller
          if needed for more space"). */}
      <StatusBar
        trackLabel={TRACK_LABELS[track]}
        onTime={status?.onTime ?? null}
        track={track}
        compact={!!feed?.checkinReturning}
      />
    </div>
  );
}

/* ── camera ───────────────────────────────────────────────────────────── */

function CameraImage({
  src,
  label,
  offline,
  fit,
  briefing,
}: {
  src: string | null;
  label: string;
  offline: boolean;
  fit: "cover" | "contain";
  briefing: React.ReactNode;
}) {
  return (
    <>
      {src ? (
        // A live proxied camera frame with a cache-busting query, not a static
        // asset next/image can optimize — same reason the kiosk's own media
        // bypasses the optimizer (features/kiosk/assets.ts).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={label}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: fit,
            filter: offline ? "grayscale(0.7) brightness(0.55)" : "none",
            transition: "filter 400ms ease",
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span style={{ fontSize: 44, color: "rgba(245,236,238,0.6)" }}>
            Connecting to camera…
          </span>
        </div>
      )}

      {/* Caption + liveness, top-left over the picture. */}
      <div
        style={{
          position: "absolute",
          top: 28,
          left: 28,
          display: "inline-flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 20px",
          borderRadius: 999,
          background: "rgba(0, 0, 0, 0.62)",
          zIndex: 3,
        }}
      >
        {offline ? (
          <IconAlertTriangleFilled size={26} color={BEHIND_AMBER} />
        ) : (
          <IconPointFilled size={26} color={ON_TIME_GREEN} className="tv-blink" />
        )}
        <span className="tv-eyebrow" style={{ fontSize: 28, color: "#fff", letterSpacing: 1 }}>
          {label}
        </span>
        {offline && (
          <span style={{ fontSize: 24, color: BEHIND_AMBER, fontWeight: 600 }}>Reconnecting…</span>
        )}
      </div>

      {briefing}
    </>
  );
}

/* ── briefing (this room's session + video countdown) ─────────────────── */

/**
 * Which session is briefing in this room right now, and — while the safety film
 * plays — how long is left on it (owner: "the session that is currently briefing
 * and time remaining on video"). Derived from the same Redis room state and the
 * same pure timeline the briefing-room TVs use, so the two never disagree.
 *
 * Renders nothing when the room is idle: a briefing camera between groups should
 * not claim a session that has left.
 */
function BriefingStrip({
  state,
  nowMs,
  accent,
}: {
  state: BriefingRoomState | null;
  nowMs: number;
  accent: string;
}) {
  const tl = briefingTimelineAt(state, nowMs);
  if (!state || tl.phase === "idle") return null;

  const heat = state.heatNumber != null ? `Session ${state.heatNumber}` : "In briefing";
  const type = state.raceType ? ` · ${state.raceType}` : "";
  const playingVideo = tl.phase === "video";
  const statusText =
    tl.phase === "video" ? "Video" : tl.phase === "waiting" ? "Starting shortly" : "Helmet sizing";

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "18px 26px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        // WRAPS AND CLIPS RATHER THAN SPILLING. The camera pane went from half
        // the wall to 42% (owner 2026-08-24) and this strip, sized for the old
        // width, ran straight out of the picture and across the rail beside it.
        // Every size below is now relative to the screen, and the row may take
        // a second line rather than overflow.
        flexWrap: "wrap",
        gap: "8px 20px",
        minWidth: 0,
        overflow: "hidden",
        background: "linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0))",
        zIndex: 3,
      }}
    >
      <span
        className="tv-display"
        style={{
          fontSize: "clamp(22px, 2.4vw, 46px)",
          fontWeight: 700,
          color: "#fff",
          textShadow: "0 2px 20px #000",
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {heat}
        <span style={{ color: "rgba(245,236,238,0.75)" }}>{type}</span>
      </span>
      <div style={{ display: "inline-flex", alignItems: "baseline", gap: 16 }}>
        <span
          className="tv-eyebrow"
          style={{ fontSize: "clamp(15px, 1.6vw, 30px)", color: withAlpha(accent, 0.95) }}
        >
          {statusText}
        </span>
        {playingVideo && (
          <span
            className="tv-display tv-num"
            style={{
              fontSize: "clamp(30px, 4vw, 78px)",
              fontWeight: 800,
              color: "#fff",
              textShadow: "0 2px 20px #000",
            }}
          >
            {formatRemaining(tl.nextInMs ?? 0)}
          </span>
        )}
      </div>
    </div>
  );
}

/* ── the clocks ───────────────────────────────────────────────────────── */

/**
 * The big clock panel: the heat's remaining time ON TRACK while a heat runs.
 *
 * Between heats it says "No session · Standby" rather than a time of day — a big
 * wall clock there read as a mystery race timer, and it showed the player PC's
 * local time (wrong tz) rather than venue time anyway (owner 2026-08-12: "what's
 * this clock mean… no races running… it's 5am"). A clock only appears when it is
 * counting something real.
 */
/** M:SS for the rail, the same shape the pit sign's tracker uses. */
function fmtRailClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const RAIL_TONE: Record<StageRow["tone"], string> = {
  none: "rgba(245,236,238,0.62)",
  good: "#46d68c",
  warn: "#f0b341",
  alert: "#ff4d4d",
};

/**
 * WHERE EVERY SESSION IS — this board's right-hand half (owner 2026-08-24:
 * "I'd like to see a mock up of replacing the blue and red boxes with the where
 * sessions are board", then "option one").
 *
 * WHAT IT REPLACED, and why. The old pane was a flat field of the track's
 * colour carrying one enormous clock and, when there was one, a white
 * checking-in card. It answered "how long has the race got" beautifully and
 * nothing else: a staff member who walked over to ask whether a group was in
 * the room, in the seats, or still owed a post got no answer, and between heats
 * the brightest half of the wall said "No session · Standby".
 *
 * THE CLOCK SURVIVES, in the corner and smaller. It is the one number worth a
 * glance from a distance — and it is now ALSO the On-track row, both read off
 * `sessionClock`, so the corner and the row cannot disagree.
 *
 * IDENTITY WITHOUT THE FLOOD. Blue is still obviously blue: the accent moves to
 * the left edge, the eyebrow and the live clock. A field of pure colour was
 * spending half the wall on something a 6px edge carries.
 *
 * THE RETURNING LINE STAYS a line, not a card — it is the one fact the rail's
 * Pit-in row cannot express on its own (how long the group has been waiting on
 * their post), and it only appears while somebody is actually waiting.
 */
function RailPane({
  accent,
  trackLabel,
  clock,
  rows,
  returning,
  nowMs,
}: {
  accent: string;
  trackLabel: string;
  clock: LiveSessionClock | null;
  rows: StageRow[];
  returning: TvFeed["checkinReturning"];
  nowMs: number;
}) {
  const paused = clock?.state === "paused";
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: "#0a0e14",
        borderLeft: `6px solid ${accent}`,
        // USES THE WHOLE HEIGHT (owner 2026-08-24: "the right side board not
        // really utilising the height at all, text is small"). The first cut
        // centred six rows in the middle of a tall pane and left thirds of it
        // black at top and bottom. The rows now spread across the full column
        // and every size is relative to the screen, so this reads from across
        // a corridor on a 1080p wall and still fits a windowed preview.
        padding: "2.6vh 2vw",
        display: "flex",
        flexDirection: "column",
        gap: "2vh",
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
        <span
          className="tv-eyebrow"
          style={{ fontSize: "clamp(18px, 2vw, 40px)", letterSpacing: "0.14em", color: accent }}
        >
          {trackLabel}
        </span>
        {clock && (
          <span style={{ marginLeft: "auto", textAlign: "right" }}>
            <span
              className="tv-display"
              style={{
                display: "block",
                fontSize: "clamp(38px, 5.2vw, 104px)",
                lineHeight: 0.95,
                color: paused ? "#f0b341" : "#fff",
              }}
            >
              {formatRemaining(clock.remainingMs)}
            </span>
            <span
              className="tv-eyebrow"
              style={{
                fontSize: "clamp(13px, 1.3vw, 26px)",
                letterSpacing: "0.12em",
                color: "rgba(245,236,238,0.55)",
              }}
            >
              {paused ? "Paused" : "On track"}
            </span>
          </span>
        )}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-evenly",
        }}
      >
        {rows.map((r) => {
          const empty = r.value === "—";
          return (
            <div
              key={r.label}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "0.8vw",
                flexWrap: "wrap",
                minWidth: 0,
              }}
            >
              <span
                className="tv-eyebrow"
                style={{
                  flex: "0 0 9.5vw",
                  fontSize: "clamp(15px, 1.55vw, 31px)",
                  letterSpacing: "0.08em",
                  color: "rgba(245,236,238,0.45)",
                }}
              >
                {r.label}
              </span>
              <span
                className="tv-display"
                style={{
                  fontSize: "clamp(22px, 2.5vw, 50px)",
                  lineHeight: 1,
                  color: empty ? "rgba(245,236,238,0.28)" : "#fff",
                }}
              >
                {r.value}
              </span>
              {r.type && (
                <span
                  className="tv-eyebrow"
                  style={{ fontSize: "clamp(13px, 1.4vw, 28px)", color: "rgba(245,236,238,0.55)" }}
                >
                  {r.type}
                </span>
              )}
              {r.detail && (
                <span
                  className="tv-eyebrow"
                  style={{
                    fontSize: "clamp(14px, 1.55vw, 31px)",
                    color: RAIL_TONE[r.tone],
                    letterSpacing: "0.05em",
                  }}
                >
                  {r.detail}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {returning && <ReturningLine returning={returning} />}
    </div>
  );
}

/**
 * RACERS GOING STRAIGHT BACK OUT — the one fact on the old pane that the rail
 * cannot express, because it is not about a stage at all: these people have
 * just raced and are booked into a LATER heat, so they skip check-in and go to
 * holding. Kept as a line rather than the old white card; the rail above it is
 * the board's subject now.
 */
function ReturningLine({ returning }: { returning: NonNullable<TvFeed["checkinReturning"]> }) {
  if (returning.groups.length === 0) return null;
  const total = returning.groups.reduce((n, g) => n + g.names.length, 0);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 16,
        flexWrap: "wrap",
        borderTop: "1px solid rgba(245,236,238,0.14)",
        paddingTop: 14,
      }}
    >
      <span
        className="tv-eyebrow"
        style={{ fontSize: "clamp(14px, 1.5vw, 30px)", color: "#f0b341" }}
      >
        Racing again
      </span>
      {returning.fromSession != null && (
        <span className="tv-display" style={{ fontSize: "clamp(18px, 2vw, 40px)", color: "#fff" }}>
          Session {returning.fromSession}
        </span>
      )}
      <span
        className="tv-eyebrow"
        style={{ fontSize: "clamp(14px, 1.5vw, 30px)", color: "rgba(245,236,238,0.7)" }}
      >
        {returning.groups
          .map((g) => {
            const key = trackFromName(g.track);
            return `→ ${g.session ?? "—"} ${key ? TRACK_SHORT[key] : g.track}`;
          })
          .join("   ")}
      </span>
      <span
        className="tv-eyebrow"
        style={{ fontSize: "clamp(14px, 1.5vw, 30px)", color: "#f0b341" }}
      >
        {total} straight to holding
      </span>
    </div>
  );
}

function ClockPane({
  clock,
  accent,
  checkin,
  returning,
  nowMs,
  windowMins,
}: {
  clock: LiveSessionClock | null;
  accent: string;
  checkin: CheckinProgressSession | null;
  returning: TvFeed["checkinReturning"];
  nowMs: number;
  windowMins: number;
}) {
  const live = !!clock;
  const paused = clock?.state === "paused";
  const value = live ? formatRemaining(clock.remainingMs) : null;
  const eyebrow = paused ? "Paused" : live ? "On track" : "No session";
  // A shorter string (MM:SS while racing) can be even bigger than H:MM:SS. The
  // clock gives ground back to each panel that appears under it, so the pane's
  // contents never fight; it takes it all back the moment they clear.
  const panels = (checkin !== null ? 1 : 0) + (returning ? 1 : 0);
  // 78 rather than 60 per panel: the boxes were sized to leave the clock as
  // large as possible, and on the wall that made them the small print on a
  // board read from across a room (owner 2026-08-14: "the now checking in on
  // camera boards can be bigger and easier to read, that whole box is little
  // small text wise"). The clock is still by far the biggest thing on the pane
  // when it is alone, which is when it is the only thing to read.
  const fontSize = (value && value.length <= 5 ? 300 : 230) - panels * 78;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: accent,
        display: "flex",
        flexDirection: "column",
        color: "#fff",
        /*
          ALWAYS CENTRED (owner 2026-08-14: "I like the middle spacing").
          The rail used to be pinned to the bottom of the pane, so the moment a
          second panel appeared the composition changed shape — a dead third of
          accent under the clock with everything else crowded below it. Centred,
          the leftover accent always sits evenly above and below, and the group
          grows from the middle as rows are added instead of the layout
          re-flowing around them.
        */
        alignItems: "center",
        justifyContent: "center",
        padding: "30px 40px",
        gap: panels > 0 ? 20 : 26,
      }}
    >
      <span
        className="tv-eyebrow"
        style={{
          fontSize: panels > 0 ? 30 : 56,
          letterSpacing: "0.1em",
          color: paused ? "#111" : "rgba(255,255,255,0.82)",
        }}
      >
        {eyebrow}
      </span>
      {value ? (
        <span
          className="tv-display tv-num"
          style={{
            fontSize,
            lineHeight: 0.9,
            fontWeight: 800,
            textShadow: "0 4px 40px rgba(0,0,0,0.35)",
          }}
        >
          {value}
        </span>
      ) : (
        <span
          className="tv-display"
          style={{
            fontSize: panels > 0 ? 96 : 120,
            fontWeight: 800,
            color: "rgba(255,255,255,0.5)",
          }}
        >
          Standby
        </span>
      )}
      <CheckinPanel session={checkin} nowMs={nowMs} windowMins={windowMins} />
      <ReturningPanel returning={returning} />
    </div>
  );
}

/**
 * TWO BOXES, ONE LANGUAGE (owner 2026-08-14: "the ready to send block and the
 * return racers block should be like two boxes unified somehow").
 *
 * They started out as a flat coloured band and a loose stack of white cards —
 * the same SHAPE of fact drawn two different ways, on one screen, a hand's width
 * apart. Both are now sibling panels: same ground, same radius, same header, and
 * the same session-chip · content · count row inside. A marshal learns the
 * grammar once.
 */
const PANEL_INK = "#0a1424";
/**
 * THE SECOND-RANK TEXT ON A WHITE PANEL — and it is INK, not grey (owner
 * 2026-08-14: "grey on white is a bad choice for that block").
 *
 * These panels used half-strength ink for the waiting clock and the "/ 14"
 * denominator, which lands around #848a93 on white: roughly 3.4:1, under the
 * threshold for body text on a screen you hold, never mind a board read from
 * the far side of a briefing room. Softer than the headline, still solidly
 * readable — around 9:1, which is what "secondary" should cost.
 */
const PANEL_MUTED = "#3b414c";
const PANEL_GROUND = "rgba(255,255,255,0.95)";
const PANEL_READY = "#17913f";
const PANEL_WAIT = "#b8730a";

function Panel({
  heading,
  headingColor,
  sub,
  flash,
  children,
}: {
  heading: string;
  headingColor: string;
  sub: string | null;
  /** Which attention flash the panel wears, if any — see the ladder below. */
  flash?: "ready" | "overdue";
  children: React.ReactNode;
}) {
  return (
    <div
      // A flashing panel's ground AND heading colour come from the keyframes, so
      // neither is set inline — an inline background outranks the animation and
      // the panel would sit there quietly instead of calling for someone.
      className={
        flash === "ready"
          ? "tv-panel-flash-ready"
          : flash === "overdue"
            ? "tv-panel-flash-overdue"
            : undefined
      }
      style={{
        width: "100%",
        background: flash ? undefined : PANEL_GROUND,
        borderRadius: 22,
        padding: "20px 26px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, padding: "0 2px" }}>
        <span
          className="tv-display tv-panel-head"
          style={{
            fontSize: 34,
            letterSpacing: "0.1em",
            color: flash ? undefined : headingColor,
          }}
        >
          {heading}
        </span>
        {sub && (
          <span
            className="tv-eyebrow"
            style={{
              marginLeft: "auto",
              fontSize: 26,
              letterSpacing: "0.12em",
              // See PANEL_MUTED: half-strength ink on a white panel is a grey
              // nobody can read from across a room.
              color: PANEL_MUTED,
            }}
          >
            {sub}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** One row of a panel: a track-coloured chip, the content, and a count on the
 *  right. Identical in both panels — that sameness IS the design. */
function PanelRow({
  chip,
  chipColor,
  content,
  count,
  countColor,
  countOf,
}: {
  chip: React.ReactNode;
  chipColor: string;
  content: React.ReactNode;
  count: number;
  countColor?: string;
  countOf?: number;
}) {
  return (
    <div
      className="tv-panel-row"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 20,
        background: withAlpha(PANEL_INK, 0.07),
        borderRadius: 14,
        padding: "15px 18px",
      }}
    >
      <span
        className="tv-display"
        style={{
          flexShrink: 0,
          marginTop: 2,
          fontSize: 29,
          color: "#fff",
          background: chipColor,
          padding: "7px 17px",
          borderRadius: 999,
          whiteSpace: "nowrap",
        }}
      >
        {chip}
      </span>
      <span
        style={{ fontSize: 38, fontWeight: 700, color: PANEL_INK, lineHeight: 1.25, minWidth: 0 }}
      >
        {content}
      </span>
      <span
        className="tv-display tv-num tv-panel-count"
        style={{
          marginLeft: "auto",
          flexShrink: 0,
          display: "flex",
          alignItems: "baseline",
          gap: 7,
        }}
      >
        <b style={{ fontSize: 48, color: countColor ?? PANEL_INK, fontWeight: "inherit" }}>
          {count}
        </b>
        {countOf != null && (
          <span style={{ fontSize: 30, color: PANEL_MUTED }}>{`/ ${countOf}`}</span>
        )}
      </span>
    </div>
  );
}

/* ── who is still at the desk ─────────────────────────────────────────── */

/**
 * "Session 31 · Pro — 6 / 14": THIS ROOM'S heat, and only this room's.
 *
 * WHY IT BELONGS ON THIS BOARD. The camera above already answers "is the room
 * filling"; what it cannot answer is "is anyone still coming". A marshal
 * watching four people in a room has no way to tell a group that is nearly all
 * in from one that is half stuck at the desk, and that difference decides
 * whether they start the film or wait.
 *
 * ONE HEAT, NOT A LIST (owner 2026-08-12: "only show checking in status for that
 * room, don't show both tracks"). The other track's progress is not an answer to
 * the question this room is asking, and on a wall read from across a room a
 * second number is one to mistake for the first.
 *
 * FOUR STATES, and no fifth:
 *   counting  — quiet, "Now checking in", N / M ticking up beside a clock
 *               counting UP from the call
 *   closing   — amber heading, "Window closing": the desk board's `warn`, the
 *               last minute before the check-in window is up
 *   ready     — FLASHES GREEN, "Ready to send", because everyone is in and
 *               nobody has sent them yet; that is a thing for staff to DO
 *   overdue   — FLASHES AMBER, past the window: they have been standing at the
 *               desk too long to still be there
 *   sent/idle — nothing at all. Check-in is over; the board goes quiet and waits
 *               for the next heat to be called. A rail still counting a group
 *               already walking to the room is describing the past.
 *
 * The escalation is the DESK BOARD'S, not this board's — see checkinRailState.
 *
 * A heat whose roster could not be read never gets here — it is dropped
 * server-side, because a fabricated "0 / 0" reads as a group that never came.
 */
function CheckinPanel({
  session,
  nowMs,
  windowMins,
}: {
  session: CheckinProgressSession | null;
  nowMs: number;
  windowMins: number;
}) {
  if (!session) return null;

  const state = checkinRailState(session, nowMs, windowMins);
  const waiting = waitingMs(session, nowMs);
  const heading =
    state === "overdue"
      ? readyToSend(session)
        ? "All in — send them now"
        : "Overdue at check-in"
      : state === "ready"
        ? "Ready to send"
        : state === "closing"
          ? "Window closing"
          : "Now checking in";
  const headingColor =
    state === "ready" ? PANEL_READY : state === "closing" ? PANEL_WAIT : PANEL_INK;
  /**
   * NO INLINE COLOUR ON A FLASHING PANEL (owner 2026-08-15: "i don't like this
   * becoming green on green").
   *
   * Ready and overdue hand the count's colour to the stylesheet, exactly as the
   * heading already does, because only the keyframes know which half of the
   * flash we are in. Setting it here put a green count on a panel that was
   * turning green underneath it — and inline style outranks the class, so the
   * CSS could not rescue it.
   */
  const countColor = state === "closing" ? PANEL_WAIT : undefined;
  // Already a TrackKey — CheckinProgressSession is built server-side from the
  // track keys, not from display names.
  const track = session.track;

  return (
    <Panel
      heading={heading}
      headingColor={headingColor}
      sub={waiting != null ? `Waiting ${formatRemaining(waiting)}` : null}
      flash={state === "ready" ? "ready" : state === "overdue" ? "overdue" : undefined}
    >
      <PanelRow
        chip={
          session.heatNumber != null
            ? `Session ${session.heatNumber} · ${TRACK_SHORT[track]}`
            : "This heat"
        }
        chipColor={TRACK_ACCENTS[track]}
        content={session.raceType ?? "Race"}
        count={session.checkedIn}
        countOf={session.total}
        countColor={countColor}
      />
    </Panel>
  );
}

/**
 * WHO IS WALKING BACK IN, AND WHERE THEY GO NEXT — the staff half of the same
 * fact the room's own wall is showing the guests (owner 2026-08-14: "utilize
 * some of the blue area here above the who checked in for returning racers as
 * well… similar to what you have on welcome screen but for staff").
 *
 * ONE RETURNING RACE, N DESTINATIONS. The header names the race that just
 * FINISHED — only one group ever walks back into a room at a time — and each row
 * names a session those racers are JOINING, colour-coded to its track, so an
 * attendant reads "two joining Red 36, one joining Blue 37" from the pit door.
 *
 * "JOINING" IS ON THE CHIP, word for word the same as the welcome-back wall
 * (SceneBriefing's RacingAgainPanel). A first cut put a bare session chip on
 * every row and it read as though three different heats were coming back.
 *
 * NO FLASH, deliberately. The flash on this board means "somebody has to act
 * now"; a returning group is information for the next thirty seconds, and a
 * second animation beside the check-in panel would spend the one signal staff
 * are meant to look up for.
 */
function ReturningPanel({ returning }: { returning: TvFeed["checkinReturning"] }) {
  if (!returning || returning.groups.length === 0) return null;
  const total = returning.groups.reduce((n, g) => n + g.names.length, 0);
  return (
    <Panel
      heading={
        returning.fromSession != null ? `Returning — Session ${returning.fromSession}` : "Returning"
      }
      headingColor={PANEL_INK}
      sub={`${total} racing again`}
    >
      {returning.groups.map((g) => {
        // `track` crosses the wire as a plain string (the feed type keeps it
        // loose), but it is written from a TrackKey — trackFromName is the
        // honest narrowing rather than a bare cast.
        const key = trackFromName(g.track);
        return (
          <PanelRow
            key={`${g.session ?? "?"}-${g.track}`}
            chip={
              <>
                <em style={{ fontStyle: "normal", fontWeight: 700, opacity: 0.78 }}>Joining </em>
                {g.session ?? "—"} · {key ? TRACK_SHORT[key] : g.track}
              </>
            }
            chipColor={key ? TRACK_ACCENTS[key] : BEHIND_AMBER}
            content={g.names.join("  ·  ")}
            count={g.names.length}
          />
        );
      })}
    </Panel>
  );
}

/**
 * The track-status bar across the bottom — big.
 *
 * STAFF READ THIS, so it shows an EXCEPTION, not an average (2026-08-17). The
 * median call delay is ~0 essentially always — it was +0.2 min on both tracks
 * across 99 heats on 2026-08-16 — so a bar showing the average would be green
 * every night of its life, which is exactly the failure of the outside service
 * this replaced. The signal is the outliers: 8 of those 99 calls went out after
 * the slot, and those are the ones a marshal can do something about.
 *
 * Amber therefore means OUR CALLS ARE LATE. It deliberately does NOT fire on the
 * ordinary ~17-minute briefing pipeline, which is not a fault and would paint
 * every board on the property amber every night.
 */
function StatusBar({
  trackLabel,
  onTime,
  track,
  compact,
}: {
  trackLabel: string;
  onTime: OnTimeSnapshot | null;
  track: TrackKey;
  /** Half height, headline only — when the pane above needs the room. */
  compact?: boolean;
}) {
  const d = trackDisplay(onTime, track, null);
  const worst = d.lateCalls[0] ?? null;
  const late = d.lateByMin !== null;

  // Green unless we are actually late. No grey state: a board with nothing to
  // say says "On Time" (owner 2026-08-17), because a neutral slab reads as a
  // broken screen to the marshal standing in front of it.
  const bg = late ? BEHIND_AMBER : ON_TIME_GREEN;
  const dark = "#0a1005";
  const fg = dark;

  // The headline is the same verdict every other wall shows (owner 2026-08-17:
  // "on TV it should show late + or on time").
  const headline = `${trackLabel} — ${verdictLabel(d)}`;

  // The sub-line is where this board earns its keep over the guest walls: it is
  // the marshal's, so it names the EXCEPTION, and it is the one place allowed to
  // admit we are green because we know nothing rather than because all is well.
  const sub = d.feedStale
    ? // THE ONE HOLE IN DEFAULT-GREEN, named. Heats ran tonight and then the feed
      // went silent, so this slab is green because we stopped hearing anything —
      // not because the track is fine. Only this board says so: a guest cannot act
      // on our data pipe, and the owner's call was that guest walls stay green.
      "No timing data for 40+ min — status may be stale"
    : d.insufficientData
      ? "Not enough of tonight measured yet"
      : worst !== null
        ? `Heat ${worst.heatNumber ?? "?"} called ${Math.round(worst.delayMin)} min late` +
          (d.lateCalls.length > 1 ? ` · ${d.lateCalls.length} late this hour` : "")
        : // Carry the sample size: a median over one heat must not read with the
          // same confidence as one over three.
          `Median ${d.callDelayMin !== null && d.callDelayMin >= 0 ? "+" : ""}${
            d.callDelayMin ?? "—"
          } min over ${d.callDelayN} heat${d.callDelayN === 1 ? "" : "s"}`;

  return (
    <div
      style={{
        height: compact ? 110 : 210,
        background: bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: `0 ${PAD}px`,
      }}
    >
      <span
        className="tv-display"
        style={{
          fontSize: compact ? 64 : 118,
          fontWeight: 800,
          lineHeight: 0.95,
          color: fg,
          textAlign: "center",
          whiteSpace: "nowrap",
        }}
      >
        {headline}
      </span>
      {/* The sub-line is the first thing to go: it restates the headline in
          other words, so a compact bar loses nothing a marshal needs. */}
      {!compact && (
        <span
          style={{
            fontSize: 46,
            fontWeight: 600,
            // Always on a coloured slab now, so always the dark ink.
            color: withAlpha(dark, 0.8),
          }}
        >
          {sub}
        </span>
      )}
    </div>
  );
}

/* ── states ───────────────────────────────────────────────────────────── */

function Unconfigured() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000418",
        padding: PAD,
      }}
    >
      <div style={{ textAlign: "center", display: "grid", gap: 18, justifyItems: "center" }}>
        <IconVideoOff size={96} color={BEHIND_AMBER} />
        <span className="tv-display" style={{ fontSize: 84, color: "#fff" }}>
          Camera monitor
        </span>
        <span style={{ fontSize: 40, color: "rgba(245,236,238,0.66)" }}>
          Pick a camera for this screen on the Lobby TVs admin page.
        </span>
      </div>
    </div>
  );
}
