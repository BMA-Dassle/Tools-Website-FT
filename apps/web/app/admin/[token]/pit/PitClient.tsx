"use client";

/**
 * PIT CONTROL — the audio/race controller's tablet at the fence, on our data.
 *
 * The Q-SYS panel's job, replaced by one card per track with a fixed PRE
 * section (the group going out) and POST section (the race coming back),
 * settled through the 2026-08-14 mockups. The buttons ARE the indicators:
 * amber means press to play, green means played, dim means not yet — no
 * separate status rows for a tablet to spend height on.
 *
 * THE TURNOVER CYCLE this screen runs:
 *
 *   race finishes (automatic — the finish marker raises the wall's hold)
 *     → HOLD, don't seat
 *     → ▶ Play post-race        ← the one hot press; doubles as "race
 *                                  returned" and reopens seating — and it is
 *                                  HELD while a briefing room the race would
 *                                  return into is still occupied
 *     → seating reopens (wall goes green)
 *
 * Each cue fires ONCE per track per cycle — the server claims the stamp NX
 * against the session it played for (pit/audio.server.ts), so this client
 * only ever asks; it never decides. The ONE automatic sound is the ambient
 * stay-seated loop while a race is in the pit (audio.server.ts, 2026-08-15)
 * — every ANNOUNCEMENT still fires only from a press on this page, and a
 * press cuts the loop off instantly.
 *
 * THE COUNTDOWN'S SOURCES, in preference order (owner 2026-08-14: "Dont use
 * cache I would prefer websocket", then "bind to the Pandora websocket"):
 *
 *   1. PANDORA'S WSS RELAY of the Core's push feed (docs/
 *      qsys-audio-websocket.md § Connecting through Pandora) — the Core's
 *      frames verbatim, ~10/second while a clip plays, no auth, and wss so
 *      an https page needs no tablet settings. Pandora adds a synthetic
 *      hello carrying upstreamConnected, and {type:"upstream", connected}
 *      frames when ITS link to the Core drops/returns — while that link is
 *      down the last state is stale, and the chip says so. The URL arrives
 *      on the board poll; PIT_QSYS_SOCKET_URL overrides it for a LAN tablet
 *      pointed straight at the Core (ws:// — that path DOES need the
 *      per-site mixed-content allowance).
 *   2. Pandora's polled cache of the same feed, riding the 5s board poll —
 *      the automatic fallback while the socket is down.
 *   3. The stamp's own clock: we know when WE started a cue and how long
 *      the player said it runs, so the bar can count without either feed.
 *      This is also what stops the bar snapping to 100% in the seconds
 *      between a press and the first "playing" report (live bug 2026-08-14).
 *
 * WHICH section shows the countdown is attributed by our own stamps — the
 * latest cue WE played on that zone — because a file staff play from the
 * Q-SYS panel directly is not ours to label.
 *
 * Same polling shape as the check-in board: a 5-second board poll and a
 * 1-second local clock so every readout ticks between polls.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { useBuildUpdate } from "~/hooks/useBuildUpdate";
import { PORTAL_DARK, ADMIN_SANS } from "~/components/features/admin-skin/theme";
import { formatRemaining, useLiveSessionClock } from "~/features/signage/live-session";
import { liveHeatNumber } from "~/features/signage/briefing/room-return";
import {
  isStaySeatedFile,
  kartsAvailability,
  pitRailState,
  type PitLaneFeed,
  type PitLanes,
} from "~/features/signage/pit/pit-board";
import type { TrackKey } from "~/features/signage/track";

const TRACK_TONE: Record<TrackKey, string> = {
  blue: "#4a9bff",
  red: "#ff5a52",
  mega: "#a06bff",
};
const GREEN = "#4ade80";
const AMBER = "#f0b341";
const INK = "#e8eef7";

/** A cue that has played: when, and the clip length when the player said in
 *  time. Mirrors the route's CueStamp — declared locally so this client
 *  never imports from a server-only module. */
interface CueStamp {
  atMs: number;
  durationS: number | null;
}

interface CueStamps {
  pre: CueStamp | null;
  post: CueStamp | null;
}

/** May post-race play — mirrors the route's PostRaceGate. */
interface PostGate {
  allowed: boolean;
  reason: string | null;
  short: string | null;
}

/** One audio zone as the Q-SYS player pushes it (socket frame or Pandora's
 *  cache — same shape). Only the fields this board reads — ignore the rest,
 *  per the wire doc. */
interface QsysZone {
  zone: string;
  wired: boolean;
  playing: boolean;
  file: string;
  timing: {
    source: string;
    remaining?: number;
    remainingText: string;
    elapsed?: number;
    elapsedText: string;
    duration?: number;
    durationText: string;
    progress?: number;
  };
}

interface PitBoard {
  now: number;
  lanes: PitLanes;
  audio: Record<string, CueStamps>;
  qsys: { connected: boolean; zones: QsysZone[] } | null;
  socketUrl: string | null;
  postGate: Record<TrackKey, PostGate | null>;
  /** Each clip's length as the player last reported it — mirrors the route's
   *  ClipLengths. Null until a clip's first ever play. */
  clipLengths: { pre: number | null; post: number | null; big: number | null };
}

/**
 * When the pre button starts DEMANDING (blinking): the announcement must
 * finish before the lane turns over, so the alarm raises one clip-length —
 * plus this slack for the walk to the button — before the on-track race ends.
 * The big clip is the bound (the server may pick it for an 8+ grid, and this
 * client does not know the roster), and 90s stands in until the player has
 * reported a length at all — the same guess the playing-attribution uses.
 */
const PRE_URGENT_SLACK_S = 15;
const CLIP_LENGTH_GUESS_S = 90;

const STYLES = `
.pitb {
  display: flex; align-items: center; gap: 12px; width: 100%;
  min-height: 56px; flex: 1; padding: 0 18px; border-radius: 10px;
  /* The button grows with the screen (flex: 1), so its text scales with it —
     vh-clamped so a wall tablet gets billboard type and a cramped window
     falls back to the original 16px (owner 2026-08-14: "fix text sized with
     the bigger button"). */
  font-family: ${ADMIN_SANS}; font-size: clamp(16px, 3.4vh, 34px); font-weight: 800; letter-spacing: 0.02em;
  border: 1px solid transparent; cursor: pointer; text-align: left;
  font-variant-numeric: tabular-nums;
  transition: filter 120ms ease, transform 60ms ease;
}
/* The right-hand status word ("due", "reopens seating", the countdown) rides
   the same scale a step down. */
.pitb-when { margin-left: auto; font-size: clamp(13px, 2.2vh, 22px); font-weight: 700; }
.pitb:hover:not(:disabled) { filter: brightness(1.12); }
.pitb:active:not(:disabled) { transform: translateY(1px); }
.pitb:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
.pitb:disabled { cursor: not-allowed; }
.pitb[aria-busy="true"] { cursor: progress; }
/* GREEN = GO. Owner 2026-08-15: red would read as the Red Track and blue as the
   Blue Track, so severity cannot be carried on those two hues anywhere on this
   page. The traffic-light pair that is left says it without ambiguity —
   green means press it, yellow means caution, and neither is a track. */
.pitb-press { background: ${GREEN}; color: #05210f; }
/* the cue is sounding right now — a state, not a control */
.pitb-playing { background: rgba(240,179,65,0.12); border-color: ${AMBER}; color: ${AMBER}; cursor: default; }
/* played and locked — a state, not a control. Outlined, so the solid green fill
   above stays unique to the one button that wants pressing. */
.pitb-done { background: rgba(74,222,128,0.08); border-color: rgba(74,222,128,0.4); color: ${GREEN}; cursor: default; }
/* dim = not armed yet */
.pitb-idle { background: transparent; border-color: ${PORTAL_DARK.border}; color: ${PORTAL_DARK.muted}; opacity: 0.45; }
/* CAUTION — armed by the race but HELD by the room gate. Loud yellow, struck
   through, and it names the reason: staff were reporting the old quiet version
   as "post doesn't work on red" when it was the red room being occupied. */
.pitb-blocked { background: rgba(240,179,65,0.18); border-color: ${AMBER}; color: ${AMBER}; opacity: 1; }
.pitb-blocked .pitb-x { font-weight: 900; margin-right: 0.15em; font-size: 1.15em; line-height: 1; }
.pitb-blocked .pitb-strike { text-decoration: line-through; text-decoration-thickness: 2px; opacity: 0.75; }
.pit-blink { animation: pit-blink 1.1s ease-in-out infinite; }
@keyframes pit-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.pitb-spin {
  width: 0.8em; height: 0.8em; border-radius: 50%; flex-shrink: 0;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: pitb-spin 650ms linear infinite;
}
@keyframes pitb-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .pit-blink { animation: none; }
}
`;

/** A local 1-second clock, so the seated/finished readouts (and the
 *  interpolated countdown) tick between polls and frames. */
function useNowMs(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSeconds(s: number): string {
  return formatClock(Math.round(s) * 1000);
}

/** Wall-clock time in venue time (ET) — what "played 7:36 PM" means. */
function clockTimeMs(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

/* ── the Core's own push feed ──────────────────────────────────────────── */

interface QsysSocket {
  connected: boolean;
  /** Pandora's own link to the Core, from the relay's hello/upstream frames.
   *  Always true on a direct-Core connection (no such frames). While false,
   *  the last state is the state before the venue link dropped — stale. */
  upstream: boolean;
  zones: QsysZone[] | null;
  /** When the newest state frame landed — the interpolation anchor. */
  atMs: number;
}

/**
 * The push feed, per the wire doc's client guidance: reconnect forever with
 * exponential backoff (1s doubling to a 60s cap), nothing to send on
 * connect, and NEVER infer disconnection from silence — the feed is quiet
 * while every zone is idle. Works against both the Pandora relay (default;
 * relay-only hello/upstream frames handled below) and the Core directly
 * (the env override); frames Pandora relays are the Core's verbatim.
 * ~10 frames/second only while a clip plays, so the setState rate is fine.
 */
function useQsysSocket(url: string | null): QsysSocket {
  const [state, setState] = useState<QsysSocket>({
    connected: false,
    upstream: true,
    zones: null,
    atMs: 0,
  });

  useEffect(() => {
    if (!url) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      const delay = Math.min(60_000, 1_000 * 2 ** attempt++);
      timer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed) return;
      try {
        ws = new WebSocket(url);
      } catch {
        // A malformed URL, or the browser's mixed-content rule — retrying is
        // cheap, and the poll fallback is already carrying the board.
        schedule();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        setState((s) => ({ ...s, connected: true }));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data)) as {
            type?: string;
            zones?: QsysZone[];
            connected?: boolean;
            upstreamConnected?: boolean;
          };
          if (msg.type === "state" && Array.isArray(msg.zones)) {
            setState((s) => ({
              ...s,
              connected: true,
              zones: msg.zones ?? null,
              atMs: Date.now(),
            }));
          } else if (msg.type === "hello" && typeof msg.upstreamConnected === "boolean") {
            // The relay's synthetic hello — the Core's own hello carries no
            // such field and leaves upstream at its default true.
            setState((s) => ({ ...s, connected: true, upstream: msg.upstreamConnected === true }));
          } else if (msg.type === "upstream" && typeof msg.connected === "boolean") {
            // Pandora's link to the Core dropped or returned. While down, no
            // state frames arrive — the last state is stale, and fresh state
            // follows the reconnect on its own.
            setState((s) => ({ ...s, upstream: msg.connected === true }));
          }
          // event frames carry nothing the state pushes don't; unknown types
          // are ignored by instruction of the wire doc.
        } catch {
          /* a bad frame is not a bad socket */
        }
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        schedule();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* close after error can throw on some engines */
        }
      };
    };

    // A tablet coming back from sleep must not sit out a 60s backoff.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (ws && ws.readyState !== WebSocket.CLOSED) return;
      if (timer) clearTimeout(timer);
      attempt = 0;
      connect();
    };
    document.addEventListener("visibilitychange", onVisible);

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    };
  }, [url]);

  return state;
}

/* ── countdown arithmetic ──────────────────────────────────────────────── */

/** The zone's countdown, run forward from the frame/poll that carried it.
 *  Numeric fields only — the *Text strings go stale (wire doc: drive
 *  behavior off the numbers). */
interface LiveTiming {
  remainingS: number | null;
  durationS: number | null;
  progress: number | null;
}

function liveTimingAt(zone: QsysZone | null, anchorMs: number, nowMs: number): LiveTiming | null {
  if (!zone?.playing) return null;
  // A cue runs well under two minutes: a "playing" report older than that is
  // a stale frame from a dropped feed (upstream down, poll cache frozen),
  // not a clip — and a bar that runs forever teaches staff to ignore it.
  if (nowMs - anchorMs > 120_000) return null;
  const t = zone.timing;
  const sinceS = Math.max(0, (nowMs - anchorMs) / 1000);
  const remainingS = typeof t.remaining === "number" ? Math.max(0, t.remaining - sinceS) : null;
  const durationS = typeof t.duration === "number" && t.duration > 0 ? t.duration : null;
  const progress =
    durationS != null && remainingS != null
      ? Math.min(1, Math.max(0, (durationS - remainingS) / durationS))
      : typeof t.progress === "number"
        ? t.progress
        : null;
  return { remainingS, durationS, progress };
}

/**
 * The stamp's own clock: WE know when the cue started and how long the
 * player said it runs, so the bar can count with no feed at all. This is
 * what stops the strip snapping to a full "played" bar in the seconds
 * between the press and the first playing report. Null once the clip is
 * over (small pad so the boundary doesn't flicker) or when the play reply
 * carried no duration.
 */
function stampClockAt(stamp: CueStamp | null, nowMs: number): LiveTiming | null {
  if (!stamp || stamp.durationS == null || stamp.durationS <= 0) return null;
  const elapsedS = (nowMs - stamp.atMs) / 1000;
  if (elapsedS < 0 || elapsedS >= stamp.durationS + 1.5) return null;
  const remainingS = Math.max(0, stamp.durationS - elapsedS);
  return {
    remainingS,
    durationS: stamp.durationS,
    progress: Math.min(1, elapsedS / stamp.durationS),
  };
}

export default function PitClient({ token, version }: { token: string; version: string }) {
  const [board, setBoard] = useState<{ data: PitBoard; fetchedAtMs: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const nowMs = useNowMs();
  // 1s session-status cadence (owner 2026-08-14) — cacheOnly reads against
  // the warm-loop-fresh Redis carry, never live Pandora.
  const status = useTrackStatus(1_000);

  // Read at fetch time by loadBoard (a ref, not state, so the poller's
  // closure always sees the current value): while this tablet holds the
  // player's socket, the poll skips the server-side Pandora live read and is
  // pure Redis — which is what makes the 1s cadence below free.
  const socketConnectedRef = useRef(false);

  const loadBoard = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const qsysParam = socketConnectedRef.current ? "&qsys=0" : "";
        const res = await fetch(`/api/admin/pit?token=${encodeURIComponent(token)}${qsysParam}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok || signal?.aborted) return; // keep the last good board
        const data = (await res.json()) as PitBoard;
        setBoard({ data, fetchedAtMs: Date.now() });
      } catch {
        /* a dropped poll must not blank the controls */
      }
    },
    [token],
  );

  // 1s lane cadence (owner 2026-08-14: "1 second is the minimums" for
  // session status). The handler is a handful of Redis reads once the
  // socket carries the audio feed.
  useVisibleInterval(
    async (signal) => {
      await loadBoard(signal);
    },
    1_000,
    true,
  );

  // The player's push feed, preferred; Pandora's cached copy is the fallback.
  const socket = useQsysSocket(board?.data.socketUrl ?? null);
  useEffect(() => {
    socketConnectedRef.current = socket.connected;
  }, [socket.connected]);
  const zones = socket.connected && socket.zones ? socket.zones : (board?.data.qsys?.zones ?? null);
  const zonesAtMs = socket.connected && socket.zones ? socket.atMs : (board?.fetchedAtMs ?? 0);

  /**
   * SELF-UPDATE (owner 2026-08-14: "Add auto updating to the pit page
   * aswell") — same shape as the check-in station: a fence tablet is opened
   * once and left open, so a deploy would never reach it. Reloads after a
   * minute of quiet (no press in flight — a playing clip doesn't block it,
   * every piece of state here is server-held), and offers the button for
   * staff who were just told a fix is live.
   */
  const buildUpdate = useBuildUpdate(version);
  useEffect(() => {
    // staleUptime: a tab past its max uptime recycles in the same quiet gap a
    // new build would — the reload is also this tablet's memory amnesty.
    if ((!buildUpdate.ready && !buildUpdate.staleUptime) || pending != null) return;
    const t = setTimeout(() => window.location.reload(), 60_000);
    return () => clearTimeout(t);
  }, [buildUpdate.ready, buildUpdate.staleUptime, pending]);

  const play = useCallback(
    async (track: TrackKey, cue: "pre" | "post") => {
      const key = `audio-${cue}:${track}`;
      setPending(key);
      setNote(null);
      try {
        const res = await fetch(`/api/admin/pit?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: `audio-${cue}`, track }),
        });
        const json = (await res.json()) as {
          error?: string;
          alreadyPlayed?: boolean;
          atMs?: number;
        };
        if (!res.ok) {
          setNote(`✕ ${json.error ?? `Failed (${res.status})`}`);
          return;
        }
        setNote(
          json.alreadyPlayed
            ? `✓ ${cue}-race already played this cycle${json.atMs ? ` at ${clockTimeMs(json.atMs)}` : ""}`
            : cue === "post"
              ? `✓ Post-race playing on ${track} — seating reopens`
              : `✓ Pre-race playing on ${track}`,
        );
        await loadBoard();
      } catch (err) {
        setNote(`✕ Could not reach the server${err instanceof Error ? ` — ${err.message}` : ""}`);
      } finally {
        setPending(null);
      }
    },
    [token, loadBoard],
  );

  // On a Mega day both rooms feed the one circuit, so the staff actions live
  // under `mega` and it's a single card — same rule as the check-in board's
  // one pit-lane button.
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;
  const tracks: TrackKey[] = megaEnabled ? ["mega"] : ["blue", "red"];

  // The PA feed's health, said quietly: LIVE when the socket is up end to
  // end, a named amber when Pandora is up but the VENUE's link to the Core
  // is down (the relay tells us — last state is stale), VIA POLL while the
  // socket itself is down, and amber only when there is no feed at all.
  const hasPoll = board?.data.qsys != null;
  const paChip =
    board == null
      ? null
      : socket.connected && socket.upstream
        ? { label: "PA LIVE", tone: GREEN }
        : socket.connected
          ? { label: "PA LINK DOWN AT VENUE", tone: AMBER }
          : hasPoll
            ? { label: "PA VIA POLL", tone: PORTAL_DARK.muted }
            : { label: "PA FEED UNAVAILABLE", tone: AMBER };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
        fontFamily: ADMIN_SANS,
        padding: "16px 18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <style>{STYLES}</style>

      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1
          style={{
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: "0.08em",
            margin: 0,
            color: PORTAL_DARK.muted,
            textTransform: "uppercase",
          }}
        >
          Pit control
        </h1>
        {megaEnabled && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              padding: "2px 9px",
              borderRadius: 4,
              background: "rgba(160,107,255,0.2)",
              border: "1px solid rgba(160,107,255,0.5)",
              color: TRACK_TONE.mega,
              letterSpacing: "0.06em",
            }}
          >
            MEGA DAY
          </span>
        )}
        {paChip && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              padding: "2px 9px",
              borderRadius: 4,
              border: `1px solid ${paChip.tone === AMBER ? "rgba(240,179,65,0.5)" : PORTAL_DARK.border}`,
              color: paChip.tone,
              letterSpacing: "0.06em",
            }}
          >
            {paChip.label}
          </span>
        )}
        {buildUpdate.ready && (
          <button
            type="button"
            onClick={buildUpdate.reloadNow}
            title={`This tab is on v${version}; v${buildUpdate.serverVersion} is live`}
            style={{
              fontSize: 11,
              fontWeight: 800,
              padding: "4px 12px",
              borderRadius: 6,
              border: `1px solid ${TRACK_TONE.blue}`,
              background: "transparent",
              color: TRACK_TONE.blue,
              cursor: "pointer",
              letterSpacing: "0.04em",
            }}
          >
            New version ready — reload
          </button>
        )}
        {note && (
          <span
            role="status"
            style={{
              marginLeft: "auto",
              fontSize: 13,
              color: note.startsWith("✕") ? AMBER : GREEN,
            }}
          >
            {note}
          </span>
        )}
      </header>

      {/* Cards STRETCH to the bottom of the screen (owner 2026-08-14: "make
          them fill vertically") — the grid takes the viewport's leftover
          height and the default stretch alignment hands it to the cards;
          inside, each PRE/POST section takes half and its button soaks up
          the growth, so the fill buys bigger touch targets, not blank card
          bottoms. */}
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
          flex: 1,
          minHeight: 0,
        }}
      >
        {tracks.map((track) => (
          <TrackCard
            key={track}
            track={track}
            lane={board?.data.lanes[track] ?? null}
            audio={board?.data.audio ?? {}}
            gate={board?.data.postGate[track] ?? null}
            zone={zones?.find((z) => z.zone === track) ?? null}
            // One clip per TRACK (owner): a zone can't overlap itself, and
            // mega conflicts with both pits' zones since it IS their
            // speakers. Red and blue run independently. The server refuses
            // too; this is the button saying so instead of erroring.
            //
            // EXCEPT THE AMBIENT LOOP, WHICH YIELDS (owner 2026-08-16, live:
            // "don't block this board for PA busy on karts returning. Pre-post
            // always have priority"). The server has always stopped the
            // stay-seated clip to make way for a real cue — yieldStaySeated,
            // owner 2026-08-15: "pre/post should be able to override it
            // instantly". This button never learned the distinction, so it
            // struck itself through and printed "PA busy on this track".
            //
            // That was a self-sustaining deadlock: the loop only plays while a
            // group sits in the pit owing a post, the post button is what pays
            // that debt, and the button refused because the loop was playing.
            // Blue 19 sat "finished 3:36 ago" with its one release struck out.
            paBusyZone={
              zones?.find(
                (z) =>
                  z.playing &&
                  !isStaySeatedFile(z.file) &&
                  (z.zone === track || z.zone === "mega" || track === "mega"),
              )?.zone ?? null
            }
            zonesAtMs={zonesAtMs}
            nowMs={nowMs}
            pending={pending}
            clipLengths={board?.data.clipLengths ?? null}
            onPlay={(cue) => void play(track, cue)}
          />
        ))}
      </div>

      <footer style={{ fontSize: 10, color: PORTAL_DARK.muted, textAlign: "right" }}>
        v {version}
      </footer>
    </div>
  );
}

/* ── one track ─────────────────────────────────────────────────────────── */

function TrackCard({
  track,
  lane,
  audio,
  gate,
  zone,
  paBusyZone,
  zonesAtMs,
  nowMs,
  pending,
  clipLengths,
  onPlay,
}: {
  track: TrackKey;
  lane: PitLaneFeed | null;
  audio: Record<string, CueStamps>;
  gate: PostGate | null;
  zone: QsysZone | null;
  /** Which zone the PA is currently sounding on, if any — one clip at a
   *  time across the whole player, so this blocks every other press. */
  paBusyZone: string | null;
  zonesAtMs: number;
  nowMs: number;
  pending: string | null;
  clipLengths: PitBoard["clipLengths"] | null;
  onPlay: (cue: "pre" | "post") => void;
}) {
  const tone = TRACK_TONE[track];
  const liveClock = useLiveSessionClock(track);

  // PRE belongs to the group being staged (seats or karts — the pre cue is what
  // moves them between the two); POST belongs to the group in the PIT. Two
  // different groups, which is the whole reason pitIn exists (2026-08-15).
  // KARTS FIRST, matching the wall's rail and playPreRace (owner 2026-08-16:
  // "the pit controller should be showing race that's in the rail"). This read
  // `holding ?? karts`, so while somebody was strapped in this card named the
  // seated group while the wall named the karts group -- and the press, which
  // resolves its own subject server-side, would have played for whichever one
  // the card was not showing.
  const holding = lane?.karts ?? lane?.holding ?? null;
  const racing = lane?.racing ?? null;
  const pitIn = lane?.pitIn ?? null;
  /**
   * A GROUP OUT ON TRACK WITH NO PRE STAMP STILL OWES IT (owner 2026-08-15:
   * "it is not optional and must be played"). The lane promotes on the green
   * flag whether or not the cue sounded, so when nothing is staged the racing
   * group inherits the PRE section — the server's playPreRace resolves the
   * same subject, so the press plays for exactly who this card names.
   */
  // THE DEBT OUTRANKS THE NEXT CYCLE, same as playPreRace — a group that went
  // out unannounced is owed their cue even while the next group is seated,
  // because seating them used to destroy the debt rather than delay it.
  const preOwed = racing != null && (audio[racing.sessionId]?.pre ?? null) == null ? racing : null;
  const preSubject = preOwed ?? holding;
  /**
   * THE KARTS ARE FULL — the same verdict the server will return (owner
   * 2026-08-16, live: blue 17 in the seats, blue 16 strapped in on the green).
   *
   * The cue walks the seated group into their karts, so it cannot be owed while
   * somebody else is in them. This card offered it as "due" regardless, and the
   * press would have overwritten the karts group off the lane. Reading the
   * shared rule rather than restating it keeps this button and playPreRace's
   * refusal from ever disagreeing.
   */
  // Not applied to a late cue: that group is already on track, so they are not
  // walking into the karts and an occupant there is none of their business.
  const kartsVerdict =
    preSubject && !preOwed
      ? kartsAvailability({ karts: lane?.karts, sessionId: preSubject.sessionId })
      : ({ ok: true } as const);
  const kartsHeld = kartsVerdict.ok ? null : kartsVerdict.error;
  const preStamp = preSubject ? (audio[preSubject.sessionId]?.pre ?? null) : null;
  const postStamp = pitIn ? (audio[pitIn.sessionId]?.post ?? null) : null;

  /**
   * THE PRE ALARM (owner 2026-08-15: "we know how long pre/big is so we
   * should indicate a race almost being done by blinking the green").
   *
   * The announcement has to FINISH before the lane turns over, so the button
   * starts blinking when the on-track race is within one clip-length (plus
   * walk-to-the-button slack) of ending — and keeps blinking once the race is
   * already back (pitIn occupied) or went out unannounced (preOwed). Steady
   * green before that: early is fine, missed is not.
   */
  const preClipS = Math.max(clipLengths?.big ?? 0, clipLengths?.pre ?? 0) || CLIP_LENGTH_GUESS_S;
  const raceEndingSoon =
    liveClock?.state === "running" &&
    liveClock.counting &&
    liveClock.remainingMs <= (preClipS + PRE_URGENT_SLACK_S) * 1000;
  const preUrgent =
    preSubject != null && preStamp == null && (preOwed != null || raceEndingSoon || pitIn != null);

  // The SAME machine the wall boards run (pit-board.ts): "hold" is karts in
  // (or rolling into) the lane, un-released. Staged-started is always null
  // here because a resolved lane moves a green-flagged group to `racing`.
  const rail = pitRailState({
    stagedInHolding: !!holding,
    stagedStartedAtMs: null,
    pitInOccupied: pitIn != null,
  });
  /**
   * PHASE ONE, FROM THE FASTEST WITNESS THIS TABLET HOLDS (owner 2026-08-14:
   * "It needs to say HOLD as soon as it hits phase one"). The finish marker
   * rides bridge → webhook → 5s poll, seconds behind the flag; the timing
   * socket this card already watches flips the heat to "finished" the moment
   * the clock ends. When the finished heat IS the racing group's heat and no
   * release has been pressed, the lane is live — say HOLD now, not at the
   * next poll. Suppressed once released, because the socket keeps saying
   * "finished" until the next heat loads and a released lane must not
   * re-hold. The post BUTTON still arms off the server's marker (the press
   * path's own gate) — a beat later, deliberately: the one-shot must never
   * fire off a client-side guess.
   */
  // Released = the pit is empty. The server drops a group from `pitIn` the
  // instant their post (or the pitted press) lands, so there is no longer a
  // pair of stamps here to compare — an empty slot IS the release. The local
  // post stamp still counts, because this tablet can know a beat before the
  // next poll that its own press sounded.
  const released = pitIn == null || postStamp != null;
  // Phase one is ALSO the clock hitting zero (owner 2026-08-14: "blue race
  // didnt say HOLD until full finish") — the socket may not flip its state
  // to "finished" until the official end, but a counting clock at 0:00 IS
  // karts coming in, right now, no bridge required.
  const clockSaysFinished =
    racing != null &&
    racing.heatNumber != null &&
    liveClock != null &&
    liveHeatNumber(liveClock.heatName) === racing.heatNumber &&
    // RUNNING to zero only (owner 2026-08-14): a PAUSED clock sitting at
    // 00:00 is a stopped race, not karts coming in — it must not hold.
    (liveClock.state === "finished" ||
      (liveClock.state === "running" && liveClock.counting && liveClock.remainingMs <= 500));
  const holdLive = rail === "hold" || (clockSaysFinished && !released);

  // "Finished N ago" is about the group in the pit: they are the ones whose
  // race has ended and whose announcement is owed.
  const finished = pitIn != null;
  const finishedAgoMs =
    pitIn != null ? Math.max(0, nowMs - (pitIn.finishedAtMs ?? pitIn.atMs)) : null;

  // WHICH cue is sounding: the player's zone state when it's attributable to
  // our latest stamp; otherwise each stamp's own clock carries its section.
  const zoneLive = liveTimingAt(zone, zonesAtMs, nowMs);
  const latest =
    preStamp && (!postStamp || preStamp.atMs > postStamp.atMs)
      ? ({ cue: "pre", stamp: preStamp } as const)
      : postStamp
        ? ({ cue: "post", stamp: postStamp } as const)
        : null;
  // A stamp claims a playing zone only while ITS OWN clip could still be
  // sounding (length + slack; 90s guess when the player never said). The old
  // 10-minute window let a long-done cue flip back to "playing" whenever the
  // zone sounded for any reason — which is how one track's play "updated
  // both" cards when the player lit more than the zone we asked for
  // (owner 2026-08-14).
  const attributed =
    zoneLive && latest && nowMs - latest.stamp.atMs < ((latest.stamp.durationS ?? 90) + 10) * 1000
      ? latest.cue
      : null;
  const preLive = attributed === "pre" ? zoneLive : stampClockAt(preStamp, nowMs);
  const postLive = attributed === "post" ? zoneLive : stampClockAt(postStamp, nowMs);

  // The room gate: armed by the race, held by an occupied briefing room.
  const postBlocked = finished && postStamp == null && gate != null && !gate.allowed;

  return (
    <div
      style={{
        background: PORTAL_DARK.card,
        border: `1px solid ${PORTAL_DARK.border}`,
        borderTop: `4px solid ${tone}`,
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minWidth: 0,
        // The grid stretches this card to the bottom of the screen; the two
        // sections split whatever the header row leaves.
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px" }}>
        <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: "0.02em", color: tone }}>
          {track.toUpperCase()}
        </span>
        <StatusChip holdLive={holdLive} clock={liveClock} />
      </div>

      {/* ── PRE — the group going out ── */}
      <CueSection
        tag="Pre"
        title={preSubject ? `Session ${preSubject.heatNumber ?? "?"}` : null}
        sub={
          preOwed
            ? "already on track — pre-race still owed"
            : holding
              ? `next up · seated ${formatClock(nowMs - holding.atMs)}${
                  holding.room ? ` · from the ${holding.room} room` : ""
                }`
              : "No group in holding — pre-race arms when a group is seated."
        }
        subTone={preUrgent && preStamp == null ? AMBER : undefined}
      >
        <CueButton
          label="Play pre-race"
          playingLabel="Pre-race playing"
          doneLabel="Pre-race played"
          state={
            preLive
              ? "playing"
              : preStamp != null
                ? "done"
                : preSubject
                  ? kartsHeld || paBusyZone
                    ? "blocked"
                    : "press"
                  : "idle"
          }
          urgent={preUrgent}
          when={
            preLive?.remainingS != null
              ? `${formatSeconds(preLive.remainingS)} left`
              : preLive
                ? "playing"
                : preStamp != null
                  ? clockTimeMs(preStamp.atMs)
                  : preSubject
                    ? kartsHeld
                      ? `Session ${lane?.karts?.heatNumber ?? "?"} in karts`
                      : paBusyZone
                        ? `PA busy · ${paBusyZone}`
                        : preOwed
                          ? "OWED — play now"
                          : raceEndingSoon || pitIn != null
                            ? "play now — track turning over"
                            : "due"
                    : "no group seated"
          }
          busy={pending === `audio-pre:${track}`}
          onPress={() => onPlay("pre")}
        />
        <CueLengthStrip live={preLive} stamp={preStamp} />
      </CueSection>

      {/* ── POST — the race coming back ──
          Titled off the group in the PIT first, the one on track second
          (2026-08-15: a red race settled into pitIn with nothing staged and
          this card said "No race out." — the session fell off the station
          with its post still owed. `racing` goes null at that exact moment,
          because on track means ON TRACK only; the post's subject is pitIn). */}
      <CueSection
        tag="Post"
        title={(pitIn ?? racing) ? `Session ${(pitIn ?? racing)?.heatNumber ?? "?"}` : null}
        sub={
          finished
            ? `finished ${formatClock(finishedAgoMs ?? 0)} ago${
                postBlocked ? ` · ${gate?.short ?? "room busy"}` : ""
              }`
            : racing
              ? clockSaysFinished
                ? // The socket saw phase one; the marker is a beat behind.
                  "finishing — karts coming in"
                : `racing${liveClock?.state === "running" ? ` · ${formatRemaining(liveClock.remainingMs)} left` : ""}`
              : "No race out."
        }
        subTone={finished && postStamp == null ? AMBER : undefined}
      >
        <CueButton
          label="Play post-race"
          playingLabel="Post-race playing"
          doneLabel="Post-race played"
          blockedLabel={
            postBlocked
              ? "Briefing room occupied — radio check-in"
              : paBusyZone
                ? "PA busy on this track"
                : undefined
          }
          state={
            postLive
              ? "playing"
              : postStamp != null
                ? "done"
                : finished
                  ? postBlocked || paBusyZone
                    ? "blocked"
                    : "press"
                  : "idle"
          }
          when={
            postLive?.remainingS != null
              ? `${formatSeconds(postLive.remainingS)} left`
              : postLive
                ? "playing"
                : postStamp != null
                  ? clockTimeMs(postStamp.atMs)
                  : finished
                    ? postBlocked
                      ? (gate?.short ?? "room busy")
                      : paBusyZone
                        ? `PA busy · ${paBusyZone}`
                        : "reopens seating"
                    : "after the finish"
          }
          busy={pending === `audio-post:${track}`}
          onPress={() => onPlay("post")}
        />
        <CueLengthStrip live={postLive} stamp={postStamp} />
      </CueSection>
    </div>
  );
}

/** The card's one-line answer to "what is the track doing": the hold outranks
 *  the live clock — karts in the lane is a safety fact. */
function StatusChip({
  holdLive,
  clock,
}: {
  holdLive: boolean;
  clock: ReturnType<typeof useLiveSessionClock>;
}) {
  const running = clock?.state === "running";
  const paused = clock?.state === "paused";
  const color = holdLive ? AMBER : running ? INK : paused ? AMBER : PORTAL_DARK.muted;
  const dot = holdLive || paused ? AMBER : running ? GREEN : PORTAL_DARK.muted;
  return (
    <span
      className={holdLive ? "pit-blink" : undefined}
      style={{
        marginLeft: "auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontSize: 15,
        fontWeight: 800,
        letterSpacing: "0.03em",
        fontVariantNumeric: "tabular-nums",
        color,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: dot,
          boxShadow: dot === PORTAL_DARK.muted ? undefined : `0 0 9px ${dot}`,
        }}
      />
      {holdLive
        ? "KARTS COMING IN"
        : running
          ? `ON TRACK ${formatRemaining(clock.remainingMs)}`
          : paused
            ? `PAUSED ${formatRemaining(clock.remainingMs)}`
            : "TRACK CLEAR"}
    </span>
  );
}

/* ── the PRE / POST sections ───────────────────────────────────────────── */

function CueSection({
  tag,
  title,
  sub,
  subTone,
  children,
}: {
  tag: string;
  title: string | null;
  sub: string;
  subTone: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "rgba(13,22,38,0.55)",
        border: `1px solid ${PORTAL_DARK.border}`,
        borderRadius: 10,
        padding: "12px 14px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        // Each section takes an equal share of the card's height, and the
        // growth goes to the BUTTON (flex: 1 in .pitb) — a taller touch
        // target at the fence, never a blank section bottom.
        flex: 1,
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: PORTAL_DARK.muted,
            padding: "3px 10px",
            border: `1px solid ${PORTAL_DARK.border}`,
            borderRadius: 5,
            background: PORTAL_DARK.muted2,
            alignSelf: "center",
          }}
        >
          {tag}
        </span>
        {title && (
          <span
            style={{
              fontSize: "clamp(25px, 3.6vh, 38px)",
              fontWeight: 800,
              lineHeight: 1.1,
              color: INK,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.02em",
            }}
          >
            {title}
          </span>
        )}
        <span
          style={{
            fontSize: "clamp(12.5px, 1.9vh, 18px)",
            color: subTone ?? PORTAL_DARK.muted,
            fontWeight: subTone ? 700 : 400,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {sub}
        </span>
      </div>
      {children}
    </div>
  );
}

/** The button IS the indicator: amber = press to play, blinking outline =
 *  sounding right now, green = played (locked), amber outline = armed but
 *  held by the room gate, dim = not armed yet. */
function CueButton({
  label,
  playingLabel,
  doneLabel,
  blockedLabel,
  state,
  when,
  busy,
  urgent,
  onPress,
}: {
  label: string;
  playingLabel: string;
  doneLabel: string;
  /** What to say INSTEAD of the label when refused — staff were reporting the
   *  quiet amber version as "post doesn't work on red" (owner 2026-08-15). */
  blockedLabel?: string;
  state: "press" | "playing" | "done" | "idle" | "blocked";
  when: string;
  busy: boolean;
  /** The press is time-critical NOW — the green blinks (owner 2026-08-15:
   *  "blinking the green to indicate it NEEDS to be played"). Only ever
   *  dressed onto a pressable button: a blinking thing that cannot be
   *  pressed is an alarm nobody can answer. */
  urgent?: boolean;
  onPress: () => void;
}) {
  const cls =
    state === "press"
      ? "pitb-press"
      : state === "playing"
        ? "pitb-playing"
        : state === "done"
          ? "pitb-done"
          : state === "blocked"
            ? "pitb-blocked"
            : "pitb-idle";
  return (
    <button
      type="button"
      className={`pitb ${cls}${urgent && state === "press" ? " pit-blink" : ""}`}
      disabled={state !== "press" || busy}
      aria-busy={busy || undefined}
      onClick={onPress}
    >
      {busy ? <span className="pitb-spin" aria-hidden /> : null}
      {state === "playing" ? (
        <span
          className="pit-blink"
          aria-hidden
          style={{
            width: "0.55em",
            height: "0.55em",
            borderRadius: "50%",
            background: AMBER,
            boxShadow: `0 0 9px ${AMBER}`,
            flexShrink: 0,
          }}
        />
      ) : null}
      {state === "blocked" && blockedLabel ? (
        <>
          <span className="pitb-x" aria-hidden>
            ✕
          </span>
          <span className="pitb-strike">{label}</span>
          <span style={{ marginLeft: "0.5em", fontWeight: 700 }}>{blockedLabel}</span>
        </>
      ) : state === "done" ? (
        `✓ ${doneLabel}`
      ) : state === "playing" ? (
        playingLabel
      ) : (
        `▶ ${label}`
      )}
      <span className="pitb-when" style={{ opacity: state === "press" ? 0.75 : 1 }}>
        {busy ? "Playing…" : when}
      </span>
    </button>
  );
}

/**
 * The announcement's length and how much is left.
 *
 * Live (this cue is sounding — player feed or the stamp's own clock): the
 * amber bar runs at the playback progress. Played and OVER: a full green
 * bar with the clip length. Not played, or length never reported: —:— and
 * an empty bar — the layout never changes.
 */
function CueLengthStrip({ live, stamp }: { live: LiveTiming | null; stamp: CueStamp | null }) {
  const pct = live != null ? Math.round((live.progress ?? 0) * 100) : stamp != null ? 100 : 0;
  const text =
    live != null
      ? live.durationS != null && live.remainingS != null
        ? `${formatSeconds(live.durationS - live.remainingS)} / ${formatSeconds(live.durationS)}`
        : live.remainingS != null
          ? `${formatSeconds(live.remainingS)} left`
          : "playing"
      : stamp?.durationS != null
        ? formatSeconds(stamp.durationS)
        : "—:—";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 999,
          background: "rgba(255,255,255,0.09)",
          overflow: "hidden",
        }}
        aria-hidden
      >
        <div
          style={{
            height: "100%",
            borderRadius: 999,
            width: `${pct}%`,
            background: live != null ? AMBER : stamp != null ? "rgba(74,222,128,0.55)" : AMBER,
            transition: "width 900ms linear",
          }}
        />
      </div>
      <span
        style={{
          fontSize: "clamp(12px, 1.8vh, 17px)",
          fontWeight: 700,
          color: live != null ? AMBER : PORTAL_DARK.muted,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </span>
    </div>
  );
}
