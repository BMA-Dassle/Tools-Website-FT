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
import type { BriefingRoomState } from "../briefing/types";
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
        {/* Camera, left. Contained (not cropped) so the whole fisheye reads. */}
        <div style={{ position: "relative", width: "50%", background: "#000" }}>{camera}</div>
        {/* The on-track session clock, HUGE, on the track's colour — with the
            desk's check-in progress underneath it. */}
        <ClockPane
          clock={sessionClock}
          accent={accent}
          checkin={roomCheckinProgress(feed?.checkinProgress ?? [], track)}
          returning={feed?.checkinReturning ?? null}
          nowMs={nowMs}
          // The SAME window the track boards count down for guests, so the
          // rail cannot escalate on a deadline the wall opposite disagrees with.
          windowMins={config.checkinWindowMins}
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
        padding: "22px 32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        background: "linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0))",
        zIndex: 3,
      }}
    >
      <span
        className="tv-display"
        style={{ fontSize: 52, fontWeight: 700, color: "#fff", textShadow: "0 2px 20px #000" }}
      >
        {heat}
        <span style={{ color: "rgba(245,236,238,0.75)" }}>{type}</span>
      </span>
      <div style={{ display: "inline-flex", alignItems: "baseline", gap: 16 }}>
        <span className="tv-eyebrow" style={{ fontSize: 34, color: withAlpha(accent, 0.95) }}>
          {statusText}
        </span>
        {playingVideo && (
          <span
            className="tv-display tv-num"
            style={{ fontSize: 92, fontWeight: 800, color: "#fff", textShadow: "0 2px 20px #000" }}
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
  const verdict = verdictLabel(d);
  const worst = d.lateCalls[0] ?? null;
  const unknown = verdict === null;
  const late = d.lateByMin !== null;

  const bg = unknown ? "#26324a" : late ? BEHIND_AMBER : ON_TIME_GREEN;
  const dark = "#0a1005";
  const fg = unknown ? "rgba(245,236,238,0.9)" : dark;

  // The headline is the same verdict every other wall shows (owner 2026-08-17:
  // "on TV it should show late + or on time").
  const headline = unknown ? trackLabel : `${trackLabel} — ${verdict}`;

  // The sub-line is where this board earns its keep over the guest walls: it is
  // the marshal's, so it names the EXCEPTION. The median can sit at "On Time"
  // while a single call went out 14 minutes late, and that call is the only
  // thing here anyone can act on.
  const sub = unknown
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
            color: withAlpha(unknown ? "#f5ecee" : dark, 0.8),
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
