"use client";

/**
 * The race control board — `?board=1` on the check-in station.
 *
 * WHAT IT IS FOR: a called heat has to be sent to a briefing room, and that is
 * the only decision staff make. So the board is two big track panels and, on each,
 * one big button. Everything else on screen exists to make that press correct: the
 * session number, its tier, how far behind the track is running, and how many of
 * the heat are checked in.
 *
 * ONE PRESS RUNS THE WHOLE ROOM. Send puts the video up, then helmet sizes, then
 * the levelled-up board — the TV derives all three from the send time, so there is
 * nothing to advance and nothing for the board and the room to disagree about.
 *
 * MEGA DAYS ARE THE INTERESTING CASE. Both tracks run as one circuit, so a called
 * session could go to either room and staff choose: the single Mega panel offers
 * "→ Red room" and "→ Blue room" instead of one button. On an ordinary day the
 * room follows the track and there is nothing to choose.
 *
 * Deliberately plain, and deliberately BIG: this is used standing up, at arm's
 * length, in a hurry.
 */
import { useCallback, useMemo, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { useTrackStatus, type CurrentRace, type TrackInfo } from "@/hooks/useTrackStatus";
import { ADMIN_SANS, PORTAL_DARK } from "~/components/features/admin-skin/theme";
import {
  tierForRaceType,
  type BriefingPhase,
  type BriefingQualifier,
  type BriefingRoom,
  type BriefingRoomState,
  type BriefingTier,
} from "~/features/signage/briefing/types";

/** Track identity, matching the boards on the wall so the two agree. */
const TRACK_COLOR: Record<string, string> = {
  blue: "#2b8fff",
  red: "#ff3b30",
  mega: "#a06bff",
};
const ROOM_COLOR: Record<BriefingRoom, string> = { red: "#ff3b30", blue: "#2b8fff" };

const PHASE_LABEL: Record<BriefingPhase, string> = {
  video: "Briefing video",
  helmet: "Helmet sizes",
  quals: "Levelled up",
  idle: "Idle",
};

interface RoomStatus {
  room: BriefingRoom;
  state: BriefingRoomState | null;
  phase: BriefingPhase;
  nextInMs: number | null;
  quals: {
    heatNumber: number | null;
    raceType: string | null;
    qualifiers: BriefingQualifier[];
  } | null;
}

interface BoardStatus {
  now: number;
  businessDay: string;
  enabled: boolean;
  rooms: RoomStatus[];
  assignments: {
    id: string;
    room: BriefingRoom;
    track: string;
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    tier: BriefingTier | null;
    mode: string;
    sentAt: string;
  }[];
  videos: Record<BriefingTier, { url: string; durationMs: number | null } | null>;
  helmetPosterUrl: string | null;
}

interface ActiveSession {
  track: string;
  raceType: string;
  heatNumber: number;
  sessionId: number | string;
  checkedIn: number;
  total: number;
}

export default function RaceControlBoard({ token, version }: { token: string; version: string }) {
  const status = useTrackStatus();
  const [board, setBoard] = useState<BoardStatus | null>(null);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Per-track staff override of which film plays. Keyed by track so choosing
  // "Intermediate" for Blue cannot silently change what Red sends.
  const [tierOverride, setTierOverride] = useState<Record<string, BriefingTier | null>>({});

  const loadBoard = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok || signal?.aborted) return; // keep the last good board
        setBoard((await res.json()) as BoardStatus);
      } catch {
        /* a dropped poll must not blank the controls */
      }
    },
    [token],
  );

  /**
   * Poll the board and the check-in counts together.
   *
   * useVisibleInterval rather than a hand-rolled setInterval — the house poller,
   * for the reasons in its own header: no overlapping cycles when an upstream is
   * slow, and per-cycle aborts. This page sits open on the check-in PC all night,
   * which is exactly the shape that piles up promises otherwise.
   *
   * 5 seconds: fast enough that a room's phase readout matches the wall, and it
   * is two cheap reads (Redis, plus a Pandora cache the cron keeps warm).
   */
  useVisibleInterval(async (signal) => {
    await Promise.all([
      loadBoard(signal),
      (async () => {
        try {
          const res = await fetch(
            `/api/admin/checkin?token=${encodeURIComponent(token)}&action=session-stats`,
            { cache: "no-store", signal },
          );
          if (!res.ok || signal.aborted) return;
          const data = (await res.json()) as { sessions?: ActiveSession[] };
          if (Array.isArray(data.sessions)) setSessions(data.sessions);
        } catch {
          /* silent — the counts are a nicety, the send button is the job */
        }
      })(),
    ]);
  }, 5_000);

  const post = useCallback(
    async (body: Record<string, unknown>, successNote: string) => {
      setBusy(true);
      setNote(null);
      try {
        const res = await fetch(`/api/admin/briefing?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { error?: string; hasVideo?: boolean; tier?: string };
        if (!res.ok) {
          setNote(`✕ ${json.error ?? `Failed (${res.status})`}`);
          return;
        }
        // Say when a send will NOT show a film, rather than leaving staff to
        // wonder why the room went straight to helmet sizes.
        setNote(
          json.hasVideo === false
            ? `✓ ${successNote} — but no ${json.tier} video is uploaded, so the room opens on helmet sizes.`
            : `✓ ${successNote}`,
        );
        await loadBoard();
      } catch (err) {
        setNote(`✕ Could not reach the server${err instanceof Error ? ` — ${err.message}` : ""}`);
      } finally {
        setBusy(false);
      }
    },
    [token, loadBoard],
  );

  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;

  // On a Mega day only the Mega panel is meaningful; otherwise the two tracks.
  const panels = useMemo(() => {
    const races = status?.currentRaces;
    if (!races) return [] as { track: string; race: CurrentRace | null }[];
    return megaEnabled
      ? [{ track: "mega", race: races.mega }]
      : [
          { track: "blue", race: races.blue },
          { track: "red", race: races.red },
        ];
  }, [status?.currentRaces, megaEnabled]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
        fontFamily: ADMIN_SANS,
        padding: 20,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, margin: 0 }}>Race control</h1>
        {megaEnabled && (
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              padding: "3px 12px",
              borderRadius: 999,
              background: TRACK_COLOR.mega,
              color: "#fff",
            }}
          >
            MEGA DAY — choose a room for each session
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 12, color: PORTAL_DARK.muted }}>
          build {version}
        </span>
      </header>
      <p style={{ color: PORTAL_DARK.muted, fontSize: 13, margin: "0 0 16px" }}>
        Sending a session runs the whole room: safety video, then helmet sizes, then who levelled up
        last session. The screens pick it up within a couple of seconds.
      </p>

      {board && !board.enabled && (
        <Banner tone="warn">
          Briefing rooms are switched off (NEXT_PUBLIC_BRIEFING_ENABLED=false). Sends will be
          refused until it is turned back on.
        </Banner>
      )}
      {board && !board.videos.starter && !board.videos.intermediate && (
        <Banner tone="warn">
          No briefing videos are uploaded yet. Rooms will show helmet sizes until one is added on
          the Lobby TVs page.
        </Banner>
      )}
      {note && <Banner tone="info">{note}</Banner>}

      {/* ── the tracks ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit,minmax(430px,1fr))",
        }}
      >
        {panels.length === 0 && (
          <p style={{ color: PORTAL_DARK.muted }}>Waiting for track status…</p>
        )}
        {panels.map(({ track, race }) => (
          <TrackPanel
            key={track}
            track={track}
            race={race}
            delay={findDelay(status?.trackStatus.tracks, track)}
            session={findSession(sessions, track, race)}
            megaEnabled={megaEnabled}
            tierOverride={tierOverride[track] ?? null}
            onTierOverride={(tier) => setTierOverride((p) => ({ ...p, [track]: tier }))}
            alreadySentTo={roomsForSession(board, race)}
            busy={busy || board?.enabled === false}
            onSend={(room) =>
              void post(
                {
                  action: "send",
                  room,
                  track,
                  sessionId: String(race?.sessionId ?? ""),
                  heatNumber: race?.heatNumber ?? null,
                  raceType: race?.raceType ?? null,
                  tier: tierOverride[track] ?? undefined,
                },
                `Session ${race?.heatNumber ?? ""} sent to the ${room} room`,
              )
            }
          />
        ))}
      </div>

      {/* ── the rooms ──────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: "1.15rem", fontWeight: 700, margin: "26px 0 10px" }}>
        Briefing rooms
      </h2>
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit,minmax(380px,1fr))",
        }}
      >
        {(board?.rooms ?? []).map((r) => (
          <RoomPanel
            key={r.room}
            status={r}
            busy={busy}
            onClear={() => void post({ action: "clear", room: r.room }, `${r.room} room cleared`)}
            onShowQuals={() =>
              void post(
                { action: "show-quals", room: r.room },
                `Levelled-up board sent to the ${r.room} room`,
              )
            }
          />
        ))}
      </div>

      {/* ── today ──────────────────────────────────────────────────────── */}
      {(board?.assignments.length ?? 0) > 0 && (
        <details style={{ marginTop: 24 }}>
          <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
            Sent today ({board?.assignments.length})
          </summary>
          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {board?.assignments.map((a) => (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  gap: 12,
                  fontSize: 13,
                  color: PORTAL_DARK.muted,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ color: ROOM_COLOR[a.room], fontWeight: 700, minWidth: 46 }}>
                  {a.room.toUpperCase()}
                </span>
                <span style={{ minWidth: 90 }}>
                  {a.mode === "quals-only" ? "Levelled-up board" : `Session ${a.heatNumber ?? "?"}`}
                </span>
                <span style={{ minWidth: 110 }}>{a.raceType ?? ""}</span>
                <span>{a.tier ? `${a.tier} video` : ""}</span>
                <span style={{ marginLeft: "auto" }}>{clockTime(a.sentAt)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/* ── a track ──────────────────────────────────────────────────────────── */

function TrackPanel({
  track,
  race,
  delay,
  session,
  megaEnabled,
  tierOverride,
  onTierOverride,
  alreadySentTo,
  busy,
  onSend,
}: {
  track: string;
  race: CurrentRace | null;
  delay: TrackInfo | null;
  session: ActiveSession | null;
  megaEnabled: boolean;
  tierOverride: BriefingTier | null;
  onTierOverride: (tier: BriefingTier | null) => void;
  alreadySentTo: BriefingRoom[];
  busy: boolean;
  onSend: (room: BriefingRoom) => void;
}) {
  const color = TRACK_COLOR[track] ?? PORTAL_DARK.muted;
  // Pro sessions take the STARTER film (owner 2026-08-11) — there is no Pro
  // briefing, and a Pro grid still has people who have not raced this season.
  const autoTier = tierForRaceType(race?.raceType);
  const tier = tierOverride ?? autoTier;
  const canSend = !!race?.sessionId;

  return (
    <section
      style={{
        border: `1px solid ${PORTAL_DARK.border}`,
        borderTop: `4px solid ${color}`,
        background: PORTAL_DARK.card,
        borderRadius: 10,
        padding: 18,
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 20, color }}>
          {track === "mega" ? "Mega Track" : `${cap(track)} Track`}
        </strong>
        {delay && (
          <span
            style={{
              fontSize: 14,
              padding: "3px 12px",
              borderRadius: 999,
              border: `1px solid ${delay.delayMinutes > 0 ? "#f0b341" : PORTAL_DARK.border}`,
              color: delay.delayMinutes > 0 ? "#f0b341" : PORTAL_DARK.muted,
            }}
          >
            {delay.delayMinutes > 0 ? `Running ${delay.delayFormatted} behind` : "On time"}
          </span>
        )}
      </div>

      {race ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>
              Session {race.heatNumber}
            </span>
            <span style={{ fontSize: 20, color: PORTAL_DARK.muted }}>{race.raceType}</span>
            {session && (
              <span
                style={{
                  fontSize: 15,
                  marginLeft: "auto",
                  color: session.checkedIn >= session.total ? "#4ade80" : PORTAL_DARK.muted,
                }}
              >
                {session.checkedIn} of {session.total} checked in
              </span>
            )}
          </div>
          <span style={{ fontSize: 13, color: PORTAL_DARK.muted }}>
            Called {race.calledAt ? timeAgoShort(race.calledAt) : "—"}
            {alreadySentTo.length > 0 && (
              <>
                {" · "}
                <span style={{ color: "#f0b341" }}>
                  already sent to {alreadySentTo.join(" and ")}
                </span>
              </>
            )}
          </span>

          {/* Which film. Defaulted from the session, overridable per send —
              staff know things the schedule does not (a grid of first-timers in
              an Intermediate heat, say). */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: PORTAL_DARK.muted }}>Video:</span>
            {(["starter", "intermediate"] as BriefingTier[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTierOverride(t === autoTier ? null : t)}
                style={{
                  ...segBtn,
                  borderColor: tier === t ? color : PORTAL_DARK.border,
                  color: tier === t ? "#fff" : PORTAL_DARK.muted,
                  background: tier === t ? `${color}33` : "transparent",
                }}
              >
                {cap(t)}
                {t === autoTier ? " (auto)" : ""}
              </button>
            ))}
          </div>

          {/* THE BUTTON. One on an ordinary day; two on a Mega day, because the
              session could go to either room and only staff know which. */}
          {megaEnabled ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {(["red", "blue"] as BriefingRoom[]).map((room) => (
                <button
                  key={room}
                  type="button"
                  onClick={() => onSend(room)}
                  disabled={busy || !canSend}
                  style={{ ...sendBtn, background: ROOM_COLOR[room], flex: "1 1 160px" }}
                >
                  → {cap(room)} room
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onSend(track === "red" ? "red" : "blue")}
              disabled={busy || !canSend}
              style={{ ...sendBtn, background: color }}
            >
              Send to {track === "red" ? "Red" : "Blue"} briefing room
            </button>
          )}
        </>
      ) : (
        <p style={{ color: PORTAL_DARK.muted, fontSize: 15, margin: "8px 0" }}>
          No session called right now.
        </p>
      )}
    </section>
  );
}

/* ── a room ───────────────────────────────────────────────────────────── */

function RoomPanel({
  status,
  busy,
  onClear,
  onShowQuals,
}: {
  status: RoomStatus;
  busy: boolean;
  onClear: () => void;
  onShowQuals: () => void;
}) {
  const color = ROOM_COLOR[status.room];
  const live = status.phase !== "idle";

  return (
    <section
      style={{
        border: `1px solid ${PORTAL_DARK.border}`,
        borderLeft: `4px solid ${color}`,
        background: PORTAL_DARK.card,
        borderRadius: 10,
        padding: 18,
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <strong style={{ fontSize: 18, color }}>{cap(status.room)} room</strong>
        <span
          style={{
            fontSize: 13,
            padding: "3px 12px",
            borderRadius: 999,
            border: `1px solid ${live ? color : PORTAL_DARK.border}`,
            color: live ? "#fff" : PORTAL_DARK.muted,
          }}
        >
          {PHASE_LABEL[status.phase]}
        </span>
        {status.nextInMs != null && live && (
          <span style={{ fontSize: 13, color: PORTAL_DARK.muted }}>
            next in {Math.max(0, Math.round(status.nextInMs / 1000))}s
          </span>
        )}
      </div>

      {status.state?.heatNumber != null && (
        <span style={{ fontSize: 14, color: PORTAL_DARK.muted }}>
          Session {status.state.heatNumber}
          {status.state.tier ? ` · ${status.state.tier} video` : ""}
        </span>
      )}

      <span style={{ fontSize: 13, color: PORTAL_DARK.muted }}>
        {status.quals && status.quals.qualifiers.length > 0
          ? `Levelled up from session ${status.quals.heatNumber ?? "?"}: ${status.quals.qualifiers
              .map((q) => `${q.firstName} (${q.level})`)
              .join(", ")}`
          : "No qualifiers to show yet — the board falls back to helmet sizes."}
      </span>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onShowQuals}
          disabled={busy || (status.quals?.qualifiers.length ?? 0) === 0}
          style={smallBtn}
          title="Jump this room straight to the levelled-up board"
        >
          Show levelled-up now
        </button>
        <button type="button" onClick={onClear} disabled={busy || !live} style={smallBtn}>
          Clear room
        </button>
      </div>
    </section>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function Banner({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        marginBottom: 14,
        padding: "10px 14px",
        borderRadius: 8,
        border: `1px solid ${tone === "warn" ? "#7c5010" : PORTAL_DARK.border}`,
        background: tone === "warn" ? "rgba(240,179,65,0.12)" : PORTAL_DARK.card,
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

/** The delay row for a track. Names vary upstream ("Blue Track", "Blue"). */
function findDelay(tracks: TrackInfo[] | undefined, track: string): TrackInfo | null {
  if (!tracks) return null;
  return tracks.find((t) => (t.trackName || "").toLowerCase().includes(track)) ?? null;
}

/** Checked-in counts for the called heat, from the check-in station's own
 *  endpoint — matched on session id first, falling back to the track name. */
function findSession(
  sessions: ActiveSession[],
  track: string,
  race: CurrentRace | null,
): ActiveSession | null {
  if (!race) return null;
  const byId = sessions.find((s) => String(s.sessionId) === String(race.sessionId));
  if (byId) return byId;
  return sessions.find((s) => (s.track || "").toLowerCase().includes(track)) ?? null;
}

/** Rooms this exact session has already been sent to today — so a second press
 *  is a visible decision rather than an accident. */
function roomsForSession(board: BoardStatus | null, race: CurrentRace | null): BriefingRoom[] {
  if (!board || !race) return [];
  const id = String(race.sessionId);
  return Array.from(
    new Set(
      board.assignments
        .filter((a) => a.mode === "timeline" && a.sessionId === id)
        .map((a) => a.room),
    ),
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function timeAgoShort(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  return `${mins} min ago`;
}

const sendBtn: React.CSSProperties = {
  padding: "16px 20px",
  borderRadius: 10,
  border: "none",
  color: "#fff",
  fontSize: 18,
  fontWeight: 800,
  cursor: "pointer",
};

const segBtn: React.CSSProperties = {
  padding: "5px 14px",
  borderRadius: 999,
  border: "1px solid",
  background: "transparent",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const smallBtn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: `1px solid ${PORTAL_DARK.border}`,
  background: "transparent",
  color: PORTAL_DARK.fg,
  fontSize: 13,
  cursor: "pointer",
};
