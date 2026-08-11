"use client";

/**
 * Race control — the briefing-room half of the check-in station's `?board=1`.
 *
 * EMBEDDED, NOT A PAGE. It renders inside CheckInClient, below the scanner and
 * the session counts, because the two jobs belong to the same person standing in
 * the same spot: they check racers in, and they send the heat to a briefing room.
 * Replacing the check-in station with this was the wrong shape (owner: "this was
 * supposed to be a dual board, where is all the check in stuff") — so this
 * component owns no page chrome, no header and no background.
 *
 * TWO COLUMNS, RED AND BLUE, mirroring the vendor board staff already read — and
 * mirroring how the venue actually works, because each track feeds the briefing
 * room named after it. A column pairs ONE track with ONE room: the session
 * checking in, how far behind it is running, which film will play, the send
 * button, and what that room is showing right now. One column, one decision.
 *
 * ON A MEGA DAY both columns read the SAME combined session (Pandora reports
 * blue and red as null and only mega populated), and each column's button sends
 * it to that column's room. That is the owner's "Mega has to be triggered
 * individually" requirement falling straight out of the layout rather than
 * needing a mode.
 */
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { useTrackStatus, type CurrentRace, type TrackInfo } from "@/hooks/useTrackStatus";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import {
  tierForRaceType,
  type BriefingPhase,
  type BriefingQualifier,
  type BriefingRoom,
  type BriefingRoomState,
  type BriefingTier,
} from "~/features/signage/briefing/types";

/** Room identity, matching the wall boards so the desk and the TV agree. */
const ROOM_COLOR: Record<BriefingRoom, string> = { red: "#ff3b30", blue: "#2b8fff" };
const MEGA_COLOR = "#a06bff";

const PHASE_LABEL: Record<BriefingPhase, string> = {
  video: "Briefing video",
  helmet: "Helmet sizes",
  quals: "Levelled up",
  idle: "Idle",
};

interface QualsBoard {
  heatNumber: number | null;
  raceType: string | null;
  qualifiers: BriefingQualifier[];
}

interface RoomStatus {
  room: BriefingRoom;
  state: BriefingRoomState | null;
  phase: BriefingPhase;
  nextInMs: number | null;
  quals: QualsBoard | null;
}

interface Assignment {
  id: string;
  room: BriefingRoom;
  track: string;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  tier: BriefingTier | null;
  mode: string;
  sentAt: string;
}

interface BoardStatus {
  now: number;
  businessDay: string;
  enabled: boolean;
  rooms: RoomStatus[];
  assignments: Assignment[];
  videos: Record<BriefingTier, { url: string; durationMs: number | null } | null>;
  helmetPosterUrl: string | null;
}

export default function RaceControlPanels({ token }: { token: string }) {
  const status = useTrackStatus();
  const [board, setBoard] = useState<BoardStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which film staff picked, per ROOM (not per track): on a Mega day both rooms
  // read one session, and choosing Intermediate for Red must not change Blue.
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

  // The house poller: no overlapping cycles when an upstream is slow, and a
  // per-cycle abort. This sits open on the check-in PC all night.
  useVisibleInterval(async (signal) => {
    await loadBoard(signal);
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

  /**
   * One column per room, each carrying the track that feeds it.
   *
   * Mega days point BOTH columns at the combined session — the tracks have no
   * session of their own then, so a column showing "Red Track: nothing" would be
   * wrong and useless on the busiest day of the week.
   */
  const columns: {
    room: BriefingRoom;
    track: string;
    race: CurrentRace | null;
    delay: TrackInfo | null;
  }[] = (["red", "blue"] as BriefingRoom[]).map((room) => {
    const track = megaEnabled ? "mega" : room;
    return {
      room,
      track,
      race: (megaEnabled ? status?.currentRaces?.mega : status?.currentRaces?.[room]) ?? null,
      delay: findDelay(status?.trackStatus.tracks, track),
    };
  });

  const roomStatus = (room: BriefingRoom): RoomStatus | null =>
    board?.rooms.find((r) => r.room === room) ?? null;

  const noVideos = !!board && !board.videos.starter && !board.videos.intermediate;

  return (
    <section
      className="border-t px-6 py-4"
      style={{ borderColor: PORTAL_DARK.border }}
      aria-label="Race control"
    >
      <div className="flex items-baseline gap-3 mb-3" style={{ flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 700, margin: 0 }}>Briefing rooms</h2>
        {megaEnabled && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 800,
              padding: "2px 10px",
              borderRadius: 999,
              background: MEGA_COLOR,
              color: "#fff",
            }}
          >
            MEGA — pick a room for each session
          </span>
        )}
        <span style={{ fontSize: 12, color: PORTAL_DARK.muted, marginLeft: "auto" }}>
          One press plays the video, then helmet sizes, then who levelled up.
        </span>
      </div>

      {board && !board.enabled && (
        <Banner tone="warn">
          Briefing rooms are switched off (NEXT_PUBLIC_BRIEFING_ENABLED=false). Sends are refused
          until it is turned back on.
        </Banner>
      )}
      {noVideos && (
        <Banner tone="warn">
          No briefing videos uploaded yet — rooms will show helmet sizes. Add them on the Lobby TVs
          page.
        </Banner>
      )}
      {note && <Banner tone="info">{note}</Banner>}

      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))",
        }}
      >
        {columns.map((col) => (
          <RoomColumn
            key={col.room}
            room={col.room}
            track={col.track}
            race={col.race}
            delay={col.delay}
            status={roomStatus(col.room)}
            tierOverride={tierOverride[col.room] ?? null}
            onTierOverride={(tier) => setTierOverride((p) => ({ ...p, [col.room]: tier }))}
            alreadySent={
              !!col.race &&
              !!board?.assignments.some(
                (a) =>
                  a.mode === "timeline" &&
                  a.room === col.room &&
                  a.sessionId === String(col.race!.sessionId),
              )
            }
            busy={busy || board?.enabled === false}
            onSend={() =>
              void post(
                {
                  action: "send",
                  room: col.room,
                  track: col.track,
                  sessionId: String(col.race?.sessionId ?? ""),
                  heatNumber: col.race?.heatNumber ?? null,
                  raceType: col.race?.raceType ?? null,
                  tier: tierOverride[col.room] ?? undefined,
                },
                `Session ${col.race?.heatNumber ?? ""} sent to the ${col.room} room`,
              )
            }
            onShowQuals={() =>
              void post(
                { action: "show-quals", room: col.room },
                `Levelled-up board sent to the ${col.room} room`,
              )
            }
            onClear={() =>
              void post({ action: "clear", room: col.room }, `${col.room} room cleared`)
            }
          />
        ))}
      </div>

      {(board?.assignments.length ?? 0) > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: PORTAL_DARK.muted }}>
            Sent today ({board?.assignments.length})
          </summary>
          <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
            {board?.assignments.map((a) => (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  gap: 10,
                  fontSize: 12,
                  color: PORTAL_DARK.muted,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ color: ROOM_COLOR[a.room], fontWeight: 800, minWidth: 42 }}>
                  {a.room.toUpperCase()}
                </span>
                <span style={{ minWidth: 96 }}>
                  {a.mode === "quals-only" ? "Levelled-up board" : `Session ${a.heatNumber ?? "?"}`}
                </span>
                <span style={{ minWidth: 104 }}>{a.raceType ?? ""}</span>
                <span>{a.tier ? `${a.tier} video` : ""}</span>
                <span style={{ marginLeft: "auto" }}>{clockTime(a.sentAt)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/* ── one room, and the track that feeds it ────────────────────────────── */

function RoomColumn({
  room,
  track,
  race,
  delay,
  status,
  tierOverride,
  onTierOverride,
  alreadySent,
  busy,
  onSend,
  onShowQuals,
  onClear,
}: {
  room: BriefingRoom;
  track: string;
  race: CurrentRace | null;
  delay: TrackInfo | null;
  status: RoomStatus | null;
  tierOverride: BriefingTier | null;
  onTierOverride: (tier: BriefingTier | null) => void;
  alreadySent: boolean;
  busy: boolean;
  onSend: () => void;
  onShowQuals: () => void;
  onClear: () => void;
}) {
  const color = ROOM_COLOR[room];
  // Pro sessions take the STARTER film (owner) — there is no Pro briefing, and a
  // Pro grid still contains people who have not raced this season.
  const autoTier = tierForRaceType(race?.raceType);
  const tier = tierOverride ?? autoTier;
  const live = status && status.phase !== "idle";
  const qualCount = status?.quals?.qualifiers.length ?? 0;

  return (
    <div
      style={{
        border: `1px solid ${PORTAL_DARK.border}`,
        borderTop: `4px solid ${color}`,
        background: PORTAL_DARK.card,
        borderRadius: 10,
        padding: 14,
        display: "grid",
        gap: 10,
        alignContent: "start",
      }}
    >
      {/* who this column is */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 17, color }}>{cap(room)} room</strong>
        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{cap(track)} Track</span>
        {delay && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 12,
              padding: "2px 10px",
              borderRadius: 999,
              border: `1px solid ${delay.delayMinutes > 0 ? "#f0b341" : PORTAL_DARK.border}`,
              color: delay.delayMinutes > 0 ? "#f0b341" : PORTAL_DARK.muted,
            }}
          >
            {delay.delayMinutes > 0 ? `${delay.delayFormatted} behind` : "On time"}
          </span>
        )}
      </div>

      {/* the session, and the send */}
      {race ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 34, fontWeight: 800, lineHeight: 1 }}>
              Session {race.heatNumber}
            </span>
            <span style={{ fontSize: 16, color: PORTAL_DARK.muted }}>{race.raceType}</span>
          </div>
          <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
            Called {race.calledAt ? timeAgoShort(race.calledAt) : "—"}
            {alreadySent && <span style={{ color: "#f0b341" }}> · already sent here</span>}
          </span>

          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>Video:</span>
            {(["starter", "intermediate"] as BriefingTier[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTierOverride(t === autoTier ? null : t)}
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  border: `1px solid ${tier === t ? color : PORTAL_DARK.border}`,
                  background: tier === t ? `${color}33` : "transparent",
                  color: tier === t ? "#fff" : PORTAL_DARK.muted,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {cap(t)}
                {t === autoTier ? " ·auto" : ""}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onSend}
            disabled={busy || !race.sessionId}
            style={{
              padding: "14px 18px",
              borderRadius: 10,
              border: "none",
              background: color,
              color: "#fff",
              fontSize: 17,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Send to {cap(room)} briefing
          </button>
        </>
      ) : (
        <p style={{ color: PORTAL_DARK.muted, fontSize: 14, margin: "6px 0" }}>
          No session called on {cap(track)} Track right now.
        </p>
      )}

      {/* what the room is showing */}
      <div
        style={{
          borderTop: `1px solid ${PORTAL_DARK.border}`,
          paddingTop: 8,
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>Room is showing:</span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "2px 10px",
              borderRadius: 999,
              border: `1px solid ${live ? color : PORTAL_DARK.border}`,
              color: live ? "#fff" : PORTAL_DARK.muted,
            }}
          >
            {PHASE_LABEL[status?.phase ?? "idle"]}
          </span>
          {live && status?.nextInMs != null && (
            <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
              next in {Math.max(0, Math.round(status.nextInMs / 1000))}s
            </span>
          )}
        </div>

        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
          {qualCount > 0
            ? `Levelled up (session ${status?.quals?.heatNumber ?? "?"}): ${status!
                .quals!.qualifiers.map((q) => `${q.firstName} — ${q.level}`)
                .join(", ")}`
            : "No qualifiers yet — the board falls back to helmet sizes."}
        </span>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onShowQuals}
            disabled={busy || qualCount === 0}
            style={smallBtn}
            title="Jump this room straight to the levelled-up board"
          >
            Show levelled-up
          </button>
          <button type="button" onClick={onClear} disabled={busy || !live} style={smallBtn}>
            Clear room
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function Banner({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        marginBottom: 10,
        padding: "8px 12px",
        borderRadius: 8,
        border: `1px solid ${tone === "warn" ? "#7c5010" : PORTAL_DARK.border}`,
        background: tone === "warn" ? "rgba(240,179,65,0.12)" : "transparent",
        fontSize: 13,
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

const smallBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: `1px solid ${PORTAL_DARK.border}`,
  background: "transparent",
  color: PORTAL_DARK.fg,
  fontSize: 12,
  cursor: "pointer",
};
