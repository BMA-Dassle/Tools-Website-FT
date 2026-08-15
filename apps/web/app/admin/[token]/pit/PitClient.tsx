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
 *                                  returned" and reopens seating
 *     → seating reopens (wall goes green)
 *
 * Each cue fires ONCE per track per cycle — the server claims the stamp NX
 * against the session it played for (pit/audio.server.ts), so this client
 * only ever asks; it never decides. A press now really PLAYS the cue: the
 * server fires Pandora's Q-SYS proxy and releases the claim if the PA never
 * started, so a failed press re-arms instead of lying.
 *
 * THE COUNTDOWN comes from the player itself: Pandora holds the Core's
 * WebSocket (docs/qsys-audio-websocket.md) and re-serves the cached zone
 * state on our board poll. Numeric `remaining` is interpolated against the
 * local clock between polls, so the bar runs smoothly on a 5-second poll.
 * WHICH section shows the countdown is attributed by our own stamps — the
 * latest cue WE played on that zone — because a file staff play from the
 * Q-SYS panel directly is not ours to label.
 *
 * Same polling shape as the check-in board: a 5-second board poll and a
 * 1-second local clock so every readout ticks between polls.
 */
import { useCallback, useEffect, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { PORTAL_DARK, ADMIN_SANS } from "~/components/features/admin-skin/theme";
import { formatRemaining, useLiveSessionClock } from "~/features/signage/live-session";
import { pitRailState, type PitLaneFeed, type PitLanes } from "~/features/signage/pit/pit-board";
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

/** One audio zone as the Q-SYS player pushes it (via Pandora's cache). Only
 *  the fields this board reads — ignore the rest, per the wire doc. */
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
}

const STYLES = `
.pitb {
  display: flex; align-items: center; gap: 12px; width: 100%;
  min-height: 56px; padding: 0 18px; border-radius: 10px;
  font-family: ${ADMIN_SANS}; font-size: 16px; font-weight: 800; letter-spacing: 0.02em;
  border: 1px solid transparent; cursor: pointer; text-align: left;
  font-variant-numeric: tabular-nums;
  transition: filter 120ms ease, transform 60ms ease;
}
.pitb:hover:not(:disabled) { filter: brightness(1.12); }
.pitb:active:not(:disabled) { transform: translateY(1px); }
.pitb:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
.pitb:disabled { cursor: not-allowed; }
.pitb[aria-busy="true"] { cursor: progress; }
/* amber = press to play */
.pitb-press { background: ${AMBER}; color: #1a1205; }
/* the cue is sounding right now — a state, not a control */
.pitb-playing { background: rgba(240,179,65,0.12); border-color: ${AMBER}; color: ${AMBER}; cursor: default; }
/* green = played, locked — a state, not a control */
.pitb-done { background: rgba(74,222,128,0.08); border-color: rgba(74,222,128,0.4); color: ${GREEN}; cursor: default; }
/* dim = not armed yet */
.pitb-idle { background: transparent; border-color: ${PORTAL_DARK.border}; color: ${PORTAL_DARK.muted}; opacity: 0.45; }
.pit-blink { animation: pit-blink 1.1s ease-in-out infinite; }
@keyframes pit-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.pitb-spin {
  width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: pitb-spin 650ms linear infinite;
}
@keyframes pitb-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .pit-blink { animation: none; }
}
`;

/** A local 1-second clock, so the seated/finished readouts (and the
 *  interpolated countdown) tick between the 5-second polls. */
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

/** The zone's countdown, run forward from the poll that carried it. Numeric
 *  fields only — the *Text strings are for humans and go stale between
 *  polls (wire doc: drive behavior off the numbers). */
interface LiveTiming {
  remainingS: number | null;
  durationS: number | null;
  progress: number | null;
}

function liveTimingAt(
  zone: QsysZone | null,
  fetchedAtMs: number,
  nowMs: number,
): LiveTiming | null {
  if (!zone?.playing) return null;
  const t = zone.timing;
  const sinceS = Math.max(0, (nowMs - fetchedAtMs) / 1000);
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

export default function PitClient({ token, version }: { token: string; version: string }) {
  const [board, setBoard] = useState<{ data: PitBoard; fetchedAtMs: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const nowMs = useNowMs();
  const status = useTrackStatus();

  const loadBoard = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/admin/pit?token=${encodeURIComponent(token)}`, {
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

  useVisibleInterval(
    async (signal) => {
      await loadBoard(signal);
    },
    5_000,
    true,
  );

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

  // The PA feed's health, said quietly. `connected: false` right after a
  // quiet spell is Pandora's socket warming up (one poll), so only a feed
  // that is MISSING is worth amber — a warming one just says so.
  const qsys = board?.data.qsys ?? null;
  const paNote =
    board == null
      ? null
      : qsys == null
        ? "PA feed unavailable"
        : !qsys.connected
          ? "PA feed connecting…"
          : null;

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
        {paNote && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              padding: "2px 9px",
              borderRadius: 4,
              border: `1px solid ${qsys == null ? "rgba(240,179,65,0.5)" : PORTAL_DARK.border}`,
              color: qsys == null ? AMBER : PORTAL_DARK.muted,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {paNote}
          </span>
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

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
          alignItems: "start",
          flex: 1,
        }}
      >
        {tracks.map((track) => (
          <TrackCard
            key={track}
            track={track}
            lane={board?.data.lanes[track] ?? null}
            audio={board?.data.audio ?? {}}
            zone={qsys?.zones.find((z) => z.zone === track) ?? null}
            fetchedAtMs={board?.fetchedAtMs ?? 0}
            nowMs={nowMs}
            pending={pending}
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

/** How old our latest stamp may be and still claim a playing zone. Clips run
 *  well under a minute; ten covers a replayed cycle without claiming a
 *  sponsor spot somebody fires an hour later. */
const ATTRIBUTION_WINDOW_MS = 10 * 60_000;

function TrackCard({
  track,
  lane,
  audio,
  zone,
  fetchedAtMs,
  nowMs,
  pending,
  onPlay,
}: {
  track: TrackKey;
  lane: PitLaneFeed | null;
  audio: Record<string, CueStamps>;
  zone: QsysZone | null;
  fetchedAtMs: number;
  nowMs: number;
  pending: string | null;
  onPlay: (cue: "pre" | "post") => void;
}) {
  const tone = TRACK_TONE[track];
  const liveClock = useLiveSessionClock(track);

  const holding = lane?.holding ?? null;
  const racing = lane?.racing ?? null;
  const preStamp = holding ? (audio[holding.sessionId]?.pre ?? null) : null;
  const postStamp = racing ? (audio[racing.sessionId]?.post ?? null) : null;

  // The SAME machine the wall boards run (pit-board.ts): "hold" is karts in
  // (or rolling into) the lane, un-released. Staged-started is always null
  // here because a resolved lane moves a green-flagged group to `racing`.
  const rail = pitRailState({
    stagedInHolding: !!holding,
    stagedStartedAtMs: null,
    racingFinishedAtMs: racing?.finishedAtMs ?? null,
    pittedAtMs: racing?.pittedAtMs ?? null,
  });
  const holdLive = rail === "hold";

  const finished = racing?.finishedAtMs != null;
  const finishedAgoMs = finished ? Math.max(0, nowMs - (racing?.finishedAtMs as number)) : null;

  // WHICH cue is sounding, when the zone is playing: the latest cue WE
  // stamped, and recently — a file fired from the Q-SYS panel directly is
  // not ours to label, so it shows on neither section.
  const live = liveTimingAt(zone, fetchedAtMs, nowMs);
  const latest =
    preStamp && (!postStamp || preStamp.atMs > postStamp.atMs)
      ? ({ cue: "pre", atMs: preStamp.atMs } as const)
      : postStamp
        ? ({ cue: "post", atMs: postStamp.atMs } as const)
        : null;
  const playingCue =
    live && latest && nowMs - latest.atMs < ATTRIBUTION_WINDOW_MS ? latest.cue : null;

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
        title={holding ? `Session ${holding.heatNumber ?? "?"}` : null}
        sub={
          holding
            ? `next up · seated ${formatClock(nowMs - holding.atMs)}${
                holding.room ? ` · from the ${holding.room} room` : ""
              }`
            : "No group in holding — pre-race arms when a group is seated."
        }
        subTone={undefined}
      >
        <CueButton
          label="Play pre-race"
          playingLabel="Pre-race playing"
          doneLabel="Pre-race played"
          state={
            playingCue === "pre"
              ? "playing"
              : preStamp != null
                ? "done"
                : holding
                  ? "press"
                  : "idle"
          }
          when={
            playingCue === "pre" && live?.remainingS != null
              ? `${formatSeconds(live.remainingS)} left`
              : preStamp != null
                ? clockTimeMs(preStamp.atMs)
                : holding
                  ? "due"
                  : "no group seated"
          }
          busy={pending === `audio-pre:${track}`}
          onPress={() => onPlay("pre")}
        />
        <CueLengthStrip live={playingCue === "pre" ? live : null} stamp={preStamp} />
      </CueSection>

      {/* ── POST — the race coming back ── */}
      <CueSection
        tag="Post"
        title={racing ? `Session ${racing.heatNumber ?? "?"}` : null}
        sub={
          racing
            ? finished
              ? `finished ${formatClock(finishedAgoMs ?? 0)} ago`
              : `racing${liveClock?.state === "running" ? ` · ${formatRemaining(liveClock.remainingMs)} left` : ""}`
            : "No race out."
        }
        subTone={finished && postStamp == null ? AMBER : undefined}
      >
        <CueButton
          label="Play post-race"
          playingLabel="Post-race playing"
          doneLabel="Post-race played"
          state={
            playingCue === "post"
              ? "playing"
              : postStamp != null
                ? "done"
                : finished
                  ? "press"
                  : "idle"
          }
          when={
            playingCue === "post" && live?.remainingS != null
              ? `${formatSeconds(live.remainingS)} left`
              : postStamp != null
                ? clockTimeMs(postStamp.atMs)
                : finished
                  ? "reopens seating"
                  : "after the finish"
          }
          busy={pending === `audio-post:${track}`}
          onPress={() => onPlay("post")}
        />
        <CueLengthStrip live={playingCue === "post" ? live : null} stamp={postStamp} />
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
              fontSize: 25,
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
            fontSize: 12.5,
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
 *  sounding right now, green = played (locked), dim = not armed yet. */
function CueButton({
  label,
  playingLabel,
  doneLabel,
  state,
  when,
  busy,
  onPress,
}: {
  label: string;
  playingLabel: string;
  doneLabel: string;
  state: "press" | "playing" | "done" | "idle";
  when: string;
  busy: boolean;
  onPress: () => void;
}) {
  const cls =
    state === "press"
      ? "pitb-press"
      : state === "playing"
        ? "pitb-playing"
        : state === "done"
          ? "pitb-done"
          : "pitb-idle";
  return (
    <button
      type="button"
      className={`pitb ${cls}`}
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
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: AMBER,
            boxShadow: `0 0 9px ${AMBER}`,
            flexShrink: 0,
          }}
        />
      ) : null}
      {state === "done" ? `✓ ${doneLabel}` : state === "playing" ? playingLabel : `▶ ${label}`}
      <span
        style={{
          marginLeft: "auto",
          fontSize: 13,
          fontWeight: 700,
          opacity: state === "press" ? 0.75 : 1,
        }}
      >
        {busy ? "Playing…" : when}
      </span>
    </button>
  );
}

/**
 * The announcement's length and how much is left.
 *
 * Live (this cue is sounding): the amber bar runs at the player's own
 * progress, interpolated between polls. Played and settled: a full green
 * bar with the clip length the /play reply reported. Not played, or length
 * never reported: —:— and an empty bar — the layout never changes.
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
          fontSize: 12,
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
