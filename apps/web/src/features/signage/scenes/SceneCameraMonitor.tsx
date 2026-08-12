"use client";

/**
 * A live CCTV monitor board — one camera, full-bleed, with the track clocks big
 * across the bottom.
 *
 * WHY STILLS, NOT A STREAM. The app is serverless: a proxy that pipes MJPEG for
 * hours is a function killed at its duration cap. So the board pulls ONE frame at
 * a time from /api/tv/camera and asks again a second later. For a monitor — "is
 * the briefing room filling, has the group sat down" — a frame a second is plenty,
 * and this path holds no connection open and cannot time a function out.
 *
 * THE TWO CLOCKS, BIG (owner: "needs the session clock but big… also the track
 * delayed clock also big"). When the board is tied to a track it carries, along
 * the bottom, the same two live readings the check-in walls show — the heat's
 * remaining time on track and how far behind the track is running — sized to be
 * read across the room. Both come from the SAME sources the website uses
 * (leaderboards websocket + /api/track-status), so a monitor never disagrees with
 * the boards next to it. A camera with no track (a lobby cam) just shows picture.
 *
 * NO FLICKER. Each next frame is loaded off-screen first and only swapped in once
 * it has fully decoded, so the visible picture never blanks between frames.
 *
 * A BOARD NEVER GOES BLACK OR LIES. While frames arrive it shows them; when they
 * stop it holds the last frame but greys it and says "Reconnecting", because a
 * frozen picture reads as "the room is empty". No camera picked ⇒ a calm setup
 * notice, never a broken image.
 */
import { useEffect, useRef, useState } from "react";
import { IconVideoOff, IconAlertTriangleFilled, IconPointFilled } from "@tabler/icons-react";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { withAlpha } from "../color";
import { formatRemaining, useLiveSessionClock, type LiveSessionClock } from "../live-session";
import { TRACK_ACCENTS, effectiveTrack, trackFromName, type TrackKey } from "../track";
import type { SceneProps } from "../director/types";

const PAD = 64;
/** New frame roughly once a second (owner: ~1 fps). */
const REFRESH_MS = 1000;
/** How long frames may fail before the board admits it is reconnecting, rather
 *  than holding a still that looks live. */
const STALE_AFTER_MS = 8000;

interface DelayInfo {
  delayMinutes: number;
  delayFormatted: string;
}

/**
 * The track's row in the status feed, matched by NAME ("Blue Track" → blue).
 *
 * Uses trackFromName — a real `\b(red|blue|mega)\b` regex literal — rather than
 * building the pattern in a template string, where `\b` is a backspace character
 * and never matches. Null when the track is not reporting.
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

export function SceneCameraMonitor({ feed, config }: SceneProps) {
  const cam = config.cameraMonitor;
  // The proxy is addressed by SCREEN, not by camera id — the server maps the
  // screen to its one allowlisted camera, so the client never names a device.
  const screenId = feed?.screen?.screenId ?? null;

  // Track clocks. On a Mega day a Blue/Red board follows the combined circuit,
  // the same rule every racing board uses. Both hooks are safe with a null track
  // (the live clock returns null; the status poll simply drives megaEnabled).
  const status = useTrackStatus();
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;
  const track = cam?.track ? effectiveTrack(cam.track, megaEnabled) : null;
  const sessionClock = useLiveSessionClock(track);
  const delay = track ? findDelay(status?.trackStatus.tracks, track) : null;

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

  // A camera board with no camera chosen cannot know what to show. Say so calmly
  // — this is a setup mistake staff need to see, not a black rectangle.
  if (!cam?.deviceId) return <Unconfigured />;

  const label = cam.label || "Live camera";
  const accent = track ? TRACK_ACCENTS[track] : "#2b8fff";

  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418", overflow: "hidden" }}>
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
            objectFit: "cover",
            // Dim the moment the feed goes stale, so a held frame does not read
            // as a live empty room.
            filter: offline ? "grayscale(0.7) brightness(0.55)" : "none",
            transition: "filter 400ms ease",
          }}
        />
      ) : (
        <Connecting label={label} />
      )}

      {/* Caption + liveness, top-left. Solid dark chip rather than blur — these
          boards run on mini PCs and a full-screen backdrop-blur is compositor
          work they can feel (same call as the briefing boards). */}
      <div
        style={{
          position: "absolute",
          top: PAD,
          left: PAD,
          display: "inline-flex",
          alignItems: "center",
          gap: 14,
          padding: "12px 24px",
          borderRadius: 999,
          background: "rgba(0, 4, 24, 0.82)",
          border: `2px solid ${withAlpha(accent, 0.5)}`,
          zIndex: 3,
        }}
      >
        {offline ? (
          <IconAlertTriangleFilled size={30} color="#f0b341" />
        ) : (
          // Pulses only while live — the one moving thing on an otherwise still
          // board, so a glance tells you the feed is current.
          <IconPointFilled size={30} color="#46d68c" className="tv-blink" />
        )}
        <span className="tv-eyebrow" style={{ fontSize: 34, color: "#fff", letterSpacing: 1 }}>
          {label}
        </span>
        {offline && (
          <span style={{ fontSize: 26, color: "#f0b341", fontWeight: 600 }}>Reconnecting…</span>
        )}
      </div>

      {/* THE CLOCKS. Only on a track board, and only takes the bottom strip so the
          camera still owns most of the wall. Gradient rather than a hard bar so
          the picture bleeds into it. */}
      {track && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: `40px ${PAD}px 44px`,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 40,
            background:
              "linear-gradient(to top, rgba(0,4,24,0.94) 30%, rgba(0,4,24,0.72) 68%, rgba(0,4,24,0))",
            zIndex: 2,
          }}
        >
          <SessionClock clock={sessionClock} accent={accent} />
          <DelayClock delay={delay} />
        </div>
      )}
    </div>
  );
}

/* ── the clocks ───────────────────────────────────────────────────────── */

/**
 * Remaining time in the heat on track — big. The same reading /leaderboards and
 * the check-in walls show. Between heats it says so rather than hiding, so the
 * corner of the wall is never just empty on a board whose job includes the clock.
 */
function SessionClock({ clock, accent }: { clock: LiveSessionClock | null; accent: string }) {
  const paused = clock?.state === "paused";
  const live = !!clock;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span
        className="tv-eyebrow"
        style={{
          fontSize: 40,
          letterSpacing: "0.06em",
          color: paused ? "#f0b341" : live ? accent : "rgba(245,236,238,0.55)",
        }}
      >
        {paused ? "Paused" : "On track"}
      </span>
      {live ? (
        <span
          className="tv-display tv-num"
          style={{
            fontSize: 170,
            lineHeight: 0.9,
            color: "#fff",
            textShadow: `0 0 60px ${withAlpha(accent, 0.55)}`,
          }}
        >
          {formatRemaining(clock.remainingMs)}
        </span>
      ) : (
        <span
          className="tv-display"
          style={{ fontSize: 84, lineHeight: 0.95, color: "rgba(245,236,238,0.6)" }}
        >
          No session
        </span>
      )}
    </div>
  );
}

/**
 * How far the track is running behind — big, amber when late, green when on time.
 * Nothing when the track is not reporting a delay at all (overnight, or a feed
 * hiccup) rather than a confident "on time" we cannot stand behind.
 */
function DelayClock({ delay }: { delay: DelayInfo | null }) {
  if (!delay) return null;
  const late = delay.delayMinutes > 0;
  const color = late ? "#f0b341" : "#46d68c";
  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "end", textAlign: "right" }}>
      <span
        className={late ? "tv-eyebrow tv-blink" : "tv-eyebrow"}
        style={{ fontSize: 40, letterSpacing: "0.06em", color }}
      >
        {late ? "Running behind" : "On time"}
      </span>
      {late ? (
        <span
          className="tv-display tv-num"
          style={{
            fontSize: 170,
            lineHeight: 0.9,
            color,
            textShadow: `0 0 60px ${withAlpha(color, 0.4)}`,
          }}
        >
          {delay.delayFormatted || `${delay.delayMinutes} min`}
        </span>
      ) : (
        <span className="tv-display" style={{ fontSize: 96, lineHeight: 0.92, color }}>
          On schedule
        </span>
      )}
    </div>
  );
}

/* ── states ───────────────────────────────────────────────────────────── */

function Connecting({ label }: { label: string }) {
  return (
    <Centered>
      <div style={{ textAlign: "center", display: "grid", gap: 16, justifyItems: "center" }}>
        <span className="tv-display" style={{ fontSize: 76, color: "#fff" }}>
          {label}
        </span>
        <span style={{ fontSize: 38, color: "rgba(245,236,238,0.6)" }}>Connecting to camera…</span>
      </div>
    </Centered>
  );
}

function Unconfigured() {
  return (
    <Centered>
      <div style={{ textAlign: "center", display: "grid", gap: 18, justifyItems: "center" }}>
        <IconVideoOff size={96} color="#f0b341" />
        <span className="tv-display" style={{ fontSize: 84, color: "#fff" }}>
          Camera monitor
        </span>
        <span style={{ fontSize: 40, color: "rgba(245,236,238,0.66)" }}>
          Pick a camera for this screen on the Lobby TVs admin page.
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
        padding: PAD,
      }}
    >
      {children}
    </div>
  );
}
