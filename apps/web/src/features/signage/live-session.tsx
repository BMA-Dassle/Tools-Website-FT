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

/**
 * THE NUMBER THE WALL SHOWS, in whole seconds, interpolated between frames.
 *
 * PURE so the two-phase rule can be tested without a socket — it is the rule
 * that was wrong, and it was wrong in a way only a live start revealed.
 *
 * The socket sends a frame every second or two; the ticker runs at 200ms and
 * smooths between them by subtracting the time since the last sync. That is
 * only correct once the race clock is genuinely moving. The two-phase start
 * reports `running` from the green flag while the clock sits STATIC at the full
 * race length, so interpolating there ran our countdown against a clock that had
 * not started (owner 2026-08-14: "it seems like clock is starting on first start
 * when it actually starts on second").
 */
export function displayRemainingMs(args: {
  state: "running" | "paused";
  /** The wire's own remaining time, from the last frame. */
  remainingMs: number;
  /** The raw-frame verdict — only true once a frame was seen to DECREASE. */
  counting: boolean;
  /** When that frame landed. */
  syncedAtMs: number;
  nowMs: number;
}): number {
  // A paused clock does not advance, and neither does an armed-but-not-counting
  // one. Both hold the last value the wire gave us.
  const live = args.state === "running" && args.counting;
  const elapsed = live ? Math.max(0, args.nowMs - args.syncedAtMs) : 0;
  return Math.max(0, Math.floor((args.remainingMs - elapsed) / 1000)) * 1000;
}

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

/**
 * IS THE CLOCK ACTUALLY RUNNING? The venue uses a TWO-PHASE start (owner
 * 2026-08-13): the green flag arms the heat with the clock sitting at a
 * static number while karts roll out, and the race truly begins when the
 * timer starts counting. On the wire the difference is plain: phase one
 * repeats the same `C` across pushes, racing strictly decreases it.
 *
 * PURE, and STICKY per heat: once a heat's clock has been seen to decrease it
 * stays "counting" for that heat (a mid-race pause or a repeated value must
 * not flap it), and a new heat name re-arms it false.
 */
export interface CountingTracker {
  heatName: string;
  lastRemainingMs: number;
  counting: boolean;
}

export function nextCountingState(
  prev: CountingTracker | null,
  frame: LiveClockFrame,
): CountingTracker | null {
  if (!frame.hasRace) return null;
  if (!prev || prev.heatName !== frame.heatName) {
    return { heatName: frame.heatName, lastRemainingMs: frame.remainingMs, counting: false };
  }
  return {
    heatName: frame.heatName,
    lastRemainingMs: frame.remainingMs,
    counting:
      prev.counting || (frame.state === "running" && frame.remainingMs < prev.lastRemainingMs),
  };
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
  /** The clock has been SEEN to decrease on the wire for this heat — false
   *  through the two-phase start's armed-but-static window. Raw frames only:
   *  the local interpolation above must never count as evidence. */
  counting: boolean;
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
  /** Raw-frame counting tracker — see nextCountingState. Survives a socket
   *  drop on purpose: the same heat re-arriving keeps its counting verdict. */
  const countingRef = useRef<CountingTracker | null>(null);

  /**
   * THE TICKER IS THE ONLY WRITER, and the display is quantised to whole
   * seconds — the two halves of "stop the timer jumping around" (owner
   * 2026-08-11), and the same discipline the leaderboard landed on. Every
   * pushed frame arrives with its own network jitter; publishing the display
   * straight from onmessage made each resync visibly hop the clock back or
   * forward a beat. Messages now only update the refs; this function runs on
   * the 200ms ticker, interpolates, and — the second half — only calls
   * setState when the SECOND (or state) actually changed, so between second
   * boundaries the shown value cannot move at all and re-renders on a mini PC
   * happen once a second, not five times.
   */
  const publish = () => {
    const frame = frameRef.current;
    if (!frame?.hasRace || (frame.state !== "running" && frame.state !== "paused")) {
      setClock((prev) => (prev === null ? prev : null));
      return;
    }
    const counting =
      countingRef.current?.heatName === frame.heatName && countingRef.current.counting;
    // The two-phase rule lives in displayRemainingMs, pure and tested.
    const shownMs = displayRemainingMs({
      state: frame.state,
      remainingMs: frame.remainingMs,
      counting,
      syncedAtMs: syncedAt.current,
      nowMs: Date.now(),
    });
    setClock((prev) =>
      prev &&
      prev.state === frame.state &&
      prev.heatName === frame.heatName &&
      prev.counting === counting &&
      prev.remainingMs === shownMs
        ? prev
        : {
            state: frame.state,
            heatName: frame.heatName,
            remainingMs: shownMs,
            counting,
          },
    );
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
          // Refs ONLY — the ticker is the single writer of the display, which
          // is what keeps resync jitter from hopping the clock. The one
          // exception below: a frame that CHANGES whether anything shows
          // (race appears/ends, pause) publishes immediately, because waiting
          // out a tick on a state change reads as lag, not smoothness.
          const before = frameRef.current;
          syncedAt.current = Date.now();
          frameRef.current = parsed;
          // RAW frames only feed the counting verdict — the interpolated
          // display always moves while "running", which is exactly the
          // false-positive the two-phase start needs excluded.
          const countedBefore = countingRef.current?.counting === true;
          countingRef.current = nextCountingState(countingRef.current, parsed);
          const countsNow = countingRef.current?.counting === true;
          if (
            before?.hasRace !== parsed.hasRace ||
            before?.state !== parsed.state ||
            countedBefore !== countsNow
          ) {
            publish();
          }
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

  // 200ms cadence, matching the leaderboard: fine enough that a second flips
  // within a frame or two of its true instant, and the quantised publish means
  // ticks between second boundaries are pure no-ops.
  useEffect(() => {
    const iv = setInterval(publish, 200);
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
  compact,
}: {
  track: TrackKey | null;
  accent: string;
  label?: string;
  /** Sized to sit inside a 44px band — the briefing rooms' camera strip when it
   *  is collapsed to its all-clear whisper. Same pill, two thirds the type. */
  compact?: boolean;
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
        gap: compact ? 10 : 16,
        padding: compact ? "3px 16px" : "10px 26px",
        borderRadius: 999,
        background: "rgba(0, 4, 24, 0.82)",
        border: `2px solid ${withAlpha(paused ? "#f0b341" : accent, 0.8)}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: compact ? 9 : 12,
          height: compact ? 9 : 12,
          borderRadius: "50%",
          alignSelf: "center",
          background: paused ? "#f0b341" : "#46d68c",
          boxShadow: `0 0 10px ${paused ? "#f0b341" : "#46d68c"}`,
        }}
      />
      <span
        style={{
          fontSize: compact ? 17 : 26,
          color: "rgba(245,236,238,0.75)",
          letterSpacing: "0.04em",
        }}
      >
        {paused ? "Paused" : label}
      </span>
      <span className="tv-num" style={{ fontSize: compact ? 26 : 40, color: "#fff" }}>
        {formatRemaining(clock.remainingMs)}
      </span>
    </div>
  );
}
