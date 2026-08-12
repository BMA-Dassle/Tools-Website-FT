"use client";

/**
 * A live CCTV monitor board for a briefing room — camera on the left, the big
 * clocks on the right and bottom, matching the original design.
 *
 *   ┌──────────────────────┬──────────────────────┐
 *   │  camera (this room)   │   ON-TRACK session   │
 *   │   + which session is  │   clock, HUGE, on     │
 *   │   briefing + video    │   the track's colour  │
 *   │   time remaining      │                       │
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
 * (briefingTimelineAt). So a monitor never disagrees with the walls beside it.
 *
 * NO FLICKER: each frame is decoded off-screen and swapped in only when ready. A
 * board never goes black or lies — stale frames grey out and say "Reconnecting",
 * and a board with no camera shows a calm setup notice.
 */
import { useEffect, useRef, useState } from "react";
import { IconVideoOff, IconAlertTriangleFilled, IconPointFilled } from "@tabler/icons-react";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { withAlpha } from "../color";
import { formatRemaining, useLiveSessionClock, type LiveSessionClock } from "../live-session";
import {
  TRACK_ACCENTS,
  TRACK_LABELS,
  effectiveTrack,
  trackFromName,
  type TrackKey,
} from "../track";
import { briefingTimelineAt } from "../briefing/phase";
import type { BriefingRoomState } from "../briefing/types";
import type { SceneProps } from "../director/types";

const PAD = 56;
/** New frame roughly once a second (owner: ~1 fps). */
const REFRESH_MS = 1000;
/** How long frames may fail before the board admits it is reconnecting. */
const STALE_AFTER_MS = 8000;

const ON_TIME_GREEN = "#22c55e";
const BEHIND_AMBER = "#f0b341";

interface DelayInfo {
  delayMinutes: number;
  delayFormatted: string;
}

/**
 * The track's row in the status feed, matched by NAME ("Blue Track" → blue).
 * Uses trackFromName — a real `\b(red|blue|mega)\b` regex — rather than building
 * the pattern in a template string, where `\b` is a backspace char and never
 * matches. Null when the track is not reporting.
 */
function findDelay(
  tracks: { trackName: string; delayMinutes: number; delayFormatted: string }[] | undefined,
  track: TrackKey,
): DelayInfo | null {
  if (!tracks) return null;
  const hit = tracks.find((t) => trackFromName(t.trackName) === track);
  if (!hit) return null;
  return { delayMinutes: hit.delayMinutes ?? 0, delayFormatted: hit.delayFormatted ?? "" };
}

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
  const delay = track ? findDelay(status?.trackStatus.tracks, track) : null;

  // Which session is in THIS briefing room, and where the safety video is up to.
  // The room is the board's own track (a Blue camera watches the Blue room); Mega
  // has no single room, so it carries no briefing line.
  const room = cam?.track === "blue" || cam?.track === "red" ? cam.track : null;
  const briefState: BriefingRoomState | null = room ? (feed?.briefingRooms?.[room] ?? null) : null;

  const [src, setSrc] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const lastOkRef = useRef(0);

  useEffect(() => {
    if (!cam?.deviceId || !screenId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      // Cache-bust every pull; the proxy sends no-store and dedupes upstream.
      const url = `/api/tv/camera?screen=${encodeURIComponent(screenId)}&w=1920&t=${Date.now()}`;
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        lastOkRef.current = Date.now();
        setSrc(url); // already decoded in cache — the visible swap is instant
        setOffline(false);
        timer = setTimeout(tick, REFRESH_MS);
      };
      img.onerror = () => {
        if (cancelled) return;
        if (Date.now() - lastOkRef.current > STALE_AFTER_MS) setOffline(true);
        timer = setTimeout(tick, REFRESH_MS);
      };
      img.src = url;
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cam?.deviceId, screenId]);

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
        {/* The on-track session clock, HUGE, on the track's colour. */}
        <ClockPane clock={sessionClock} accent={accent} />
      </div>
      <StatusBar trackLabel={TRACK_LABELS[track]} delay={delay} />
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
function ClockPane({ clock, accent }: { clock: LiveSessionClock | null; accent: string }) {
  const live = !!clock;
  const paused = clock?.state === "paused";
  const value = live ? formatRemaining(clock.remainingMs) : null;
  const eyebrow = paused ? "Paused" : live ? "On track" : "No session";
  // A shorter string (MM:SS while racing) can be even bigger than H:MM:SS.
  const fontSize = value && value.length <= 5 ? 300 : 230;

  return (
    <div
      style={{
        flex: 1,
        background: accent,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        color: "#fff",
      }}
    >
      <span
        className="tv-eyebrow"
        style={{
          fontSize: 56,
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
          style={{ fontSize: 120, fontWeight: 800, color: "rgba(255,255,255,0.5)" }}
        >
          Standby
        </span>
      )}
    </div>
  );
}

/**
 * The track-status bar across the bottom — big. Green and "On Time" when on
 * schedule, amber and "N min behind" when late. Neutral with just the track name
 * when the track is not reporting, rather than a status it cannot stand behind.
 */
function StatusBar({ trackLabel, delay }: { trackLabel: string; delay: DelayInfo | null }) {
  const unknown = delay === null;
  const late = !unknown && delay.delayMinutes > 0;
  const bg = unknown ? "#26324a" : late ? BEHIND_AMBER : ON_TIME_GREEN;
  const dark = "#0a1005";
  const fg = unknown ? "rgba(245,236,238,0.9)" : dark;
  const behindText = !unknown && late ? delay.delayFormatted || `${delay.delayMinutes} min` : "";
  const headline = unknown
    ? trackLabel
    : `${trackLabel} — ${late ? `${behindText} behind` : "On Time"}`;
  const sub = unknown
    ? "Track status unavailable"
    : late
      ? `Running ${behindText} behind`
      : "Running on schedule";

  return (
    <div
      style={{
        height: 210,
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
          fontSize: 118,
          fontWeight: 800,
          lineHeight: 0.95,
          color: fg,
          textAlign: "center",
          whiteSpace: "nowrap",
        }}
      >
        {headline}
      </span>
      <span
        style={{
          fontSize: 46,
          fontWeight: 600,
          color: withAlpha(unknown ? "#f5ecee" : dark, 0.8),
        }}
      >
        {sub}
      </span>
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
