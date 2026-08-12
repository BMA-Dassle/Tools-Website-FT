"use client";

/**
 * Live session clock — the time remaining in the heat ON TRACK, right now.
 *
 * SAME SOURCE AS /leaderboards, deliberately (owner 2026-08-11: "on this page we
 * get live session remaining time — I'd like this on the briefing room screens at
 * all times, also the sign-in board for each track"). The leaderboard connects
 * the BROWSER straight to the SMS-Timing websocket, sends `START {serverKey}`,
 * and gets pushed heat frames; the `C` field is the remaining milliseconds, which
 * a local ticker interpolates between pushes. The socket handling below mirrors
 * app/leaderboards/page.tsx `LiveTimingPanel` — reconnect after 3s, a 45s stale
 * watchdog, reconnect on tab-visible — but reads ONLY the clock fields. The TVs
 * have no use for the driver array, and skipping it keeps the per-frame work on a
 * mini PC to a JSON.parse and three field reads.
 *
 * The CSP already allowlists the host on every page
 * (`wss://webserver22.sms-timing.com:10015` in both connect-src blocks).
 *
 * FAILS TO NOTHING. No socket, no race, a parse error — the chip simply does not
 * render. A wall must never show a broken clock.
 */
import { useEffect, useRef, useState } from "react";
import { withAlpha } from "./color";
import type { TrackKey } from "./track";

const WS_HOST = "webserver22.sms-timing.com";
const WS_PORT = 10015;

/** Track → SMS-Timing server key. Mirrors LIVE_TRACKS in app/leaderboards —
 *  resource id @ BMI client key (FastTrax rides the shared headpinzftmyers key,
 *  see signage/constants.ts CENTER NAMESPACE TRAP). */
const SERVER_KEYS: Record<TrackKey, string> = {
  blue: "11208654@headpinzftmyers",
  red: "11208660@headpinzftmyers",
  mega: "-1@headpinzftmyers",
};

export type LiveHeatState = "idle" | "running" | "paused" | "finished";

export interface LiveClockFrame {
  hasRace: boolean;
  heatName: string;
  state: LiveHeatState;
  remainingMs: number;
}

/**
 * One pushed frame → the clock fields. PURE, so the only part of this file with
 * decisions in it is testable without a socket.
 *
 * The wire shape (from the leaderboard's production use): `"{}"` means no race on
 * this track; otherwise `{ N: heat name, S: 1 running | 2 paused | >=3 finished,
 * C: remaining ms, D: [...drivers] }`.
 */
export function parseLiveFrame(raw: unknown): LiveClockFrame | null {
  if (typeof raw !== "string") return null;
  if (raw === "{}") return { hasRace: false, heatName: "", state: "idle", remainingMs: 0 };
  try {
    const data = JSON.parse(raw) as { N?: unknown; S?: unknown; C?: unknown };
    const s = typeof data.S === "number" ? data.S : 0;
    return {
      hasRace: true,
      heatName: typeof data.N === "string" ? data.N.replace("[HEAT]", "Heat") : "",
      state: s === 1 ? "running" : s === 2 ? "paused" : s >= 3 ? "finished" : "idle",
      remainingMs: typeof data.C === "number" && Number.isFinite(data.C) ? Math.max(0, data.C) : 0,
    };
  } catch {
    return null;
  }
}

/** "04:32", or "1:04:32" past the hour — same shape the leaderboard shows. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export interface LiveSessionClock {
  state: LiveHeatState;
  heatName: string;
  /** Interpolated between pushes by a local ticker. */
  remainingMs: number;
}

/** Null until a race is actually live on the track — the designed empty state. */
export function useLiveSessionClock(track: TrackKey | null): LiveSessionClock | null {
  /**
   * RENDER READS STATE, NOTHING ELSE. The interpolation (synced clock minus time
   * since the sync) needs Date.now() and the sync ref — both impure in render —
   * so it happens inside the ticker and the message handler, which publish a
   * finished LiveSessionClock into state. The first cut computed it in render
   * and the purity lint rightly objected.
   */
  const [clock, setClock] = useState<LiveSessionClock | null>(null);
  const frameRef = useRef<LiveClockFrame | null>(null);
  const syncedAt = useRef(0);

  // Shared by the socket handler and the ticker, so a pause lands instantly
  // rather than on the next tick.
  const publish = () => {
    const frame = frameRef.current;
    if (!frame?.hasRace || (frame.state !== "running" && frame.state !== "paused")) {
      setClock((prev) => (prev === null ? prev : null));
      return;
    }
    const elapsed = frame.state === "running" ? Date.now() - syncedAt.current : 0;
    setClock({
      state: frame.state,
      heatName: frame.heatName,
      remainingMs: Math.max(0, frame.remainingMs - elapsed),
    });
  };

  useEffect(() => {
    if (!track || typeof window === "undefined") return;
    const serverKey = SERVER_KEYS[track];
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let staleTimer: ReturnType<typeof setTimeout>;
    let ws: WebSocket | null = null;
    let closed = false;

    const resetStale = () => {
      clearTimeout(staleTimer);
      // No frame for 45s means the socket died quietly — force the reconnect
      // path rather than showing a clock frozen at its last sync.
      staleTimer = setTimeout(() => ws?.close(), 45_000);
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(`wss://${WS_HOST}:${WS_PORT}/`);
        ws.onopen = () => {
          ws?.send(`START ${serverKey}`);
          resetStale();
        };
        ws.onmessage = (evt) => {
          resetStale();
          const parsed = parseLiveFrame(evt.data);
          if (!parsed) return;
          syncedAt.current = Date.now();
          frameRef.current = parsed;
          publish();
        };
        ws.onclose = () => {
          clearTimeout(staleTimer);
          if (!closed) {
            frameRef.current = null; // never a stale clock while disconnected
            publish();
            reconnectTimer = setTimeout(connect, 3_000);
          }
        };
        ws.onerror = () => ws?.close();
      } catch {
        if (!closed) reconnectTimer = setTimeout(connect, 3_000);
      }
    };

    connect();

    // The TVs never hide their tab, but the check-in PC's browser can — same
    // reconnect-on-visible discipline as the leaderboard.
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || closed) return;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        clearTimeout(reconnectTimer);
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(staleTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      ws?.close();
    };
  }, [track]);

  // Local 500ms ticker so the countdown moves between pushes. Publishing while
  // nothing is live is a no-op (publish keeps null stable), so an idle track
  // costs no renders.
  useEffect(() => {
    const iv = setInterval(publish, 500);
    return () => clearInterval(iv);
  }, []);

  return track ? clock : null;
}

/**
 * The corner chip both screen types wear: a live dot, the track's session clock,
 * and PAUSED when the timing system pauses a heat. Renders NOTHING when no heat
 * is live — an empty corner beats a dead clock.
 */
export function LiveSessionChip({
  track,
  accent,
  label = "On track",
}: {
  track: TrackKey | null;
  accent: string;
  label?: string;
}) {
  const clock = useLiveSessionClock(track);
  if (!clock) return null;

  const paused = clock.state === "paused";
  return (
    <div
      className="tv-display"
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 16,
        padding: "10px 26px",
        borderRadius: 999,
        background: "rgba(0, 4, 24, 0.82)",
        border: `2px solid ${withAlpha(paused ? "#f0b341" : accent, 0.8)}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          borderRadius: "50%",
          alignSelf: "center",
          background: paused ? "#f0b341" : "#46d68c",
          boxShadow: `0 0 10px ${paused ? "#f0b341" : "#46d68c"}`,
        }}
      />
      <span style={{ fontSize: 26, color: "rgba(245,236,238,0.75)", letterSpacing: "0.04em" }}>
        {paused ? "Paused" : label}
      </span>
      <span className="tv-num" style={{ fontSize: 40, color: "#fff" }}>
        {formatRemaining(clock.remainingMs)}
      </span>
    </div>
  );
}
