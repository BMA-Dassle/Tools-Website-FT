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
 * only ever asks; it never decides.
 *
 * THE LENGTH STRIP under each cue is deliberately empty for now: cue
 * durations aren't in the system yet (owner: "We dont have data yet but we
 * will"). The readout shows —:— and the layout doesn't change when the data
 * lands.
 *
 * Same polling shape as the check-in board: a 5-second board poll and a
 * 1-second local clock so the seated/finished readouts tick between polls.
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

/** What the cues stamped, per session — mirrors the route's PitCueStamps.
 *  Declared locally so this client never imports from a server-only module. */
interface CueStamps {
  preAtMs: number | null;
  postAtMs: number | null;
}

interface PitBoard {
  now: number;
  lanes: PitLanes;
  audio: Record<string, CueStamps>;
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

/** A local 1-second clock, so the seated/finished readouts tick between the
 *  5-second polls — same pattern as the check-in board. */
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

/** Wall-clock time in venue time (ET) — what "played 7:36 PM" means. */
function clockTimeMs(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

export default function PitClient({ token, version }: { token: string; version: string }) {
  const [board, setBoard] = useState<PitBoard | null>(null);
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
        setBoard((await res.json()) as PitBoard);
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
              ? `✓ Post-race played on ${track} — seating reopens`
              : `✓ Pre-race played on ${track}`,
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
            lane={board?.lanes[track] ?? null}
            audio={board?.audio ?? {}}
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

function TrackCard({
  track,
  lane,
  audio,
  nowMs,
  pending,
  onPlay,
}: {
  track: TrackKey;
  lane: PitLaneFeed | null;
  audio: Record<string, CueStamps>;
  nowMs: number;
  pending: string | null;
  onPlay: (cue: "pre" | "post") => void;
}) {
  const tone = TRACK_TONE[track];
  const liveClock = useLiveSessionClock(track);

  const holding = lane?.holding ?? null;
  const racing = lane?.racing ?? null;
  const preAtMs = holding ? (audio[holding.sessionId]?.preAtMs ?? null) : null;
  const postAtMs = racing ? (audio[racing.sessionId]?.postAtMs ?? null) : null;

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
          state={
            preAtMs != null ? "done" : holding ? "press" : "idle"
            // pre is a ghost-amber press in the mock, but on a tablet a solid
            // press reads better through glare — same treatment as post.
          }
          when={preAtMs != null ? clockTimeMs(preAtMs) : holding ? "due" : "no group seated"}
          doneLabel="Pre-race played"
          busy={pending === `audio-pre:${track}`}
          onPress={() => onPlay("pre")}
        />
        <CueLengthStrip playedAtMs={preAtMs} />
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
        subTone={finished && postAtMs == null ? AMBER : undefined}
      >
        <CueButton
          label="Play post-race"
          state={postAtMs != null ? "done" : finished ? "press" : "idle"}
          when={
            postAtMs != null
              ? clockTimeMs(postAtMs)
              : finished
                ? "reopens seating"
                : "after the finish"
          }
          doneLabel="Post-race played"
          busy={pending === `audio-post:${track}`}
          onPress={() => onPlay("post")}
        />
        <CueLengthStrip playedAtMs={postAtMs} />
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

/** The button IS the indicator: amber = press to play, green = played
 *  (locked), dim = not armed yet. */
function CueButton({
  label,
  doneLabel,
  state,
  when,
  busy,
  onPress,
}: {
  label: string;
  doneLabel: string;
  state: "press" | "done" | "idle";
  when: string;
  busy: boolean;
  onPress: () => void;
}) {
  const cls = state === "press" ? "pitb-press" : state === "done" ? "pitb-done" : "pitb-idle";
  return (
    <button
      type="button"
      className={`pitb ${cls}`}
      disabled={state !== "press" || busy}
      aria-busy={busy || undefined}
      onClick={onPress}
    >
      {busy ? <span className="pitb-spin" aria-hidden /> : null}
      {state === "done" ? `✓ ${doneLabel}` : `▶ ${label}`}
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
 * The announcement's length and how much is left. Cue durations aren't in the
 * system yet (owner 2026-08-14: "We dont have data yet but we will") — until
 * they land this shows —:— and an empty bar, and the layout won't change when
 * the data arrives: a played cue fills the bar, a playing one will carry the
 * live countdown.
 */
function CueLengthStrip({ playedAtMs }: { playedAtMs: number | null }) {
  const played = playedAtMs != null;
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
            width: played ? "100%" : 0,
            background: played ? "rgba(74,222,128,0.55)" : AMBER,
          }}
        />
      </div>
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: PORTAL_DARK.muted,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        —:—
      </span>
    </div>
  );
}
