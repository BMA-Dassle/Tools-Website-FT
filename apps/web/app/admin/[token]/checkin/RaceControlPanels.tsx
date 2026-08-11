"use client";

/**
 * Race control — the briefing-room half of the check-in station's `?board=1`.
 *
 * EMBEDDED, NOT A PAGE. It renders inside CheckInClient, because the person who
 * checks racers in is the person who sends the heat to a briefing room, standing
 * in the same spot (owner: "this was supposed to be a dual board, where is all
 * the check in stuff"). State lives in useBriefingControl one level up, because
 * the scan flash unmounts this subtree for four seconds.
 *
 * LAYOUT: one column per room, each column TWO BOXES (owner 2026-08-11) —
 *
 *   CALLED       what the track just called, the film choice, and Send
 *   IN THE ROOM  what that room is showing right now, and the controls for it
 *
 * Splitting them is what makes the busy case legible. When a second heat is
 * called while a room is still briefing, "what is coming" and "what is happening"
 * are two boxes saying two different things — rather than one box trying to be
 * both, which is where somebody clobbers a running film by accident. Sending into
 * an occupied room still works; it asks first.
 *
 * TWO PHASES PER SEND. Send assigns the room and holds it on a "take a seat"
 * board; Start rolls the film, because a group still walking over would otherwise
 * miss the opening of a safety briefing. Undo covers a mis-send, Restart covers
 * latecomers and second showings.
 *
 * EVERY BUTTON ACKNOWLEDGES THE PRESS. Hover, a real pressed state, and a spinner
 * on the button that was actually clicked while its request is in flight — a
 * single global disable told a staff member nothing about whether their press
 * registered (owner: "make the buttons actually show input").
 *
 * THE COUNTDOWN IS COMPUTED HERE, not read off the poll, which arrives every 5
 * seconds and would make a timer jump. It ticks locally and derives the phase with
 * briefingTimelineAt — the SAME pure function the TV runs, so the desk and the
 * wall cannot disagree about what is on screen.
 */
import { useEffect, useState } from "react";
import { useTrackStatus, type CurrentRace, type TrackInfo } from "@/hooks/useTrackStatus";
import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { briefingTimelineAt, type BriefingTimeline } from "~/features/signage/briefing/phase";
import {
  tierForRaceType,
  type BriefingPhase,
  type BriefingRoom,
  type BriefingRoomState,
  type BriefingTier,
} from "~/features/signage/briefing/types";
import type { BriefingControl, RoomStatus } from "./useBriefingControl";

const ROOM_COLOR: Record<BriefingRoom, string> = { red: "#ff3b30", blue: "#2b8fff" };
const MEGA = "#a06bff";
const GREEN = "#4ade80";
const AMBER = "#f0b341";

const PHASE_LABEL: Record<BriefingPhase, string> = {
  waiting: "Waiting to start",
  video: "Briefing video",
  helmet: "Helmet sizes",
  quals: "Levelled up",
  idle: "Empty",
};

/**
 * Interaction states, as real CSS.
 *
 * Inline styles cannot express :hover, :active or :focus-visible, and those are
 * exactly what make a button feel like it registered a press. One injected sheet
 * rather than mouse-event handlers on every control.
 */
const STYLES = `
.rcb {
  border: 1px solid transparent;
  cursor: pointer;
  font-weight: 700;
  transition: filter 120ms ease, transform 60ms ease, box-shadow 120ms ease;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
}
.rcb:hover:not(:disabled) { filter: brightness(1.14); }
.rcb:active:not(:disabled) { transform: translateY(1px); filter: brightness(0.94); }
.rcb:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.rcb:disabled { opacity: 0.4; cursor: not-allowed; filter: none; }
.rcb[aria-busy="true"] { opacity: 0.85; cursor: progress; }
.rcb-primary:hover:not(:disabled) { box-shadow: 0 4px 18px rgba(0,0,0,0.45); }
.rcb-spin {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: rcb-spin 650ms linear infinite;
}
@keyframes rcb-spin { to { transform: rotate(360deg); } }
`;

/** A local 1-second clock, so the countdown ticks between 5-second polls. */
function useNowMs(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}

export default function RaceControlPanels({ control }: { control: BriefingControl }) {
  const status = useTrackStatus();
  const nowMs = useNowMs();
  const { board, note, pending } = control;

  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;
  const rooms: BriefingRoom[] = ["red", "blue"];
  const noVideos = !!board && !board.videos.starter && !board.videos.intermediate;

  return (
    <section
      className="flex flex-col px-6 py-4 border-t"
      style={{ borderColor: PORTAL_DARK.border, flex: 1, minHeight: 0 }}
      aria-label="Race control"
    >
      <style>{STYLES}</style>

      <header className="flex items-center gap-3 mb-3" style={{ flexWrap: "wrap", flexShrink: 0 }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>Briefing rooms</h2>
        {megaEnabled && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 800,
              padding: "2px 10px",
              borderRadius: 999,
              background: MEGA,
              color: "#fff",
              letterSpacing: "0.04em",
            }}
          >
            MEGA DAY
          </span>
        )}
        <span style={{ fontSize: 12, color: PORTAL_DARK.muted, marginLeft: "auto" }}>
          Send them over, then press Start once they are seated.
        </span>
      </header>

      {board && !board.enabled && (
        <Banner tone="warn">
          Briefing rooms are switched off (NEXT_PUBLIC_BRIEFING_ENABLED=false). Sends are refused.
        </Banner>
      )}
      {noVideos && (
        <Banner tone="warn">
          No briefing videos uploaded — rooms will show helmet sizes. Add them on the Lobby TVs
          page.
        </Banner>
      )}
      {note && <Banner tone={note.startsWith("✕") ? "warn" : "ok"}>{note}</Banner>}

      <div
        style={{
          display: "grid",
          gap: 18,
          gridTemplateColumns: "repeat(auto-fit,minmax(400px,1fr))",
          flex: 1,
          minHeight: 0,
        }}
      >
        {rooms.map((room) => {
          const track = megaEnabled ? "mega" : room;
          const race =
            (megaEnabled ? status?.currentRaces?.mega : status?.currentRaces?.[room]) ?? null;
          return (
            <RoomColumn
              key={room}
              room={room}
              track={track}
              race={race}
              delay={findDelay(status?.trackStatus.tracks, track)}
              status={board?.rooms.find((r) => r.room === room) ?? null}
              nowMs={nowMs}
              tierOverride={control.tierOverride[room] ?? null}
              onTierOverride={(tier) => control.setTierOverride(room, tier)}
              locked={board?.enabled === false}
              pending={pending}
              onSend={() =>
                control.send({
                  room,
                  track,
                  sessionId: String(race?.sessionId ?? ""),
                  heatNumber: race?.heatNumber ?? null,
                  raceType: race?.raceType ?? null,
                })
              }
              onStart={(restart) => control.start(room, { restart })}
              onUndo={() => control.clearRoom(room)}
            />
          );
        })}
      </div>

      {(board?.assignments.length ?? 0) > 0 && (
        <details style={{ marginTop: 12, flexShrink: 0 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: PORTAL_DARK.muted }}>
            Sent today ({board?.assignments.length})
          </summary>
          <div style={{ marginTop: 8, display: "grid", gap: 3 }}>
            {board?.assignments.slice(0, 12).map((a) => (
              <div
                key={a.id}
                style={{ display: "flex", gap: 10, fontSize: 12, color: PORTAL_DARK.muted }}
              >
                <span style={{ color: ROOM_COLOR[a.room], fontWeight: 800, minWidth: 42 }}>
                  {a.room.toUpperCase()}
                </span>
                <span style={{ minWidth: 96 }}>
                  {a.mode === "quals-only" ? "Levelled-up board" : `Session ${a.heatNumber ?? "?"}`}
                </span>
                <span style={{ minWidth: 100 }}>{a.raceType ?? ""}</span>
                <span style={{ marginLeft: "auto" }}>{clockTime(a.sentAt)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/* ── one room: a called box and an in-room box ─────────────────────────── */

function RoomColumn({
  room,
  track,
  race,
  delay,
  status,
  nowMs,
  tierOverride,
  onTierOverride,
  locked,
  pending,
  onSend,
  onStart,
  onUndo,
}: {
  room: BriefingRoom;
  track: string;
  race: CurrentRace | null;
  delay: TrackInfo | null;
  status: RoomStatus | null;
  nowMs: number;
  tierOverride: BriefingTier | null;
  onTierOverride: (tier: BriefingTier | null) => void;
  /** The kill switch is off — sends and starts are refused server-side anyway. */
  locked: boolean;
  pending: string | null;
  onSend: () => void;
  onStart: (restart: boolean) => void;
  onUndo: () => void;
}) {
  const color = ROOM_COLOR[room];
  const state = status?.state ?? null;
  const timeline = briefingTimelineAt(state, nowMs);
  const occupied = timeline.phase !== "idle";
  const autoTier = tierForRaceType(race?.raceType);
  const tier = tierOverride ?? autoTier;
  const sameSessionInRoom = !!race && state?.sessionId === String(race.sessionId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 10px ${color}`,
          }}
        />
        <strong style={{ fontSize: 18, color }}>{cap(room)} room</strong>
        <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
          fed by {cap(track)} Track
          {delay && delay.delayMinutes > 0 ? ` · ${delay.delayFormatted} behind` : ""}
        </span>
      </div>

      {/* ── BOX 1: CALLED ── */}
      <Box label="Called" accent={color} dim={!race}>
        {race ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 34, fontWeight: 800, lineHeight: 1 }}>
                Session {race.heatNumber}
              </span>
              <span style={{ fontSize: 16, color: PORTAL_DARK.muted }}>{race.raceType}</span>
              <span style={{ fontSize: 11, color: PORTAL_DARK.muted, marginLeft: "auto" }}>
                {race.calledAt ? timeAgoShort(race.calledAt) : ""}
              </span>
            </div>

            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: PORTAL_DARK.muted }}>Video</span>
              {(["starter", "intermediate"] as BriefingTier[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="rcb"
                  onClick={() => onTierOverride(t === autoTier ? null : t)}
                  aria-pressed={tier === t}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 999,
                    borderColor: tier === t ? color : PORTAL_DARK.border,
                    background: tier === t ? withAlpha(color, 0.25) : "transparent",
                    color: tier === t ? "#fff" : PORTAL_DARK.muted,
                    fontSize: 11,
                  }}
                >
                  {cap(t)}
                  {t === autoTier ? " ·auto" : ""}
                </button>
              ))}
            </div>

            {sameSessionInRoom ? (
              <p style={{ fontSize: 12, color: GREEN, margin: 0 }}>
                Already in the {room} room — see below.
              </p>
            ) : (
              <ActionButton
                variant="primary"
                tone={occupied ? AMBER : color}
                outline={occupied}
                pendingKey={`send:${room}`}
                pending={pending}
                disabled={!race.sessionId || locked}
                pendingLabel={occupied ? "Replacing…" : "Sending…"}
                onClick={() => {
                  if (
                    occupied &&
                    !window.confirm(
                      `The ${room} room is showing ${PHASE_LABEL[timeline.phase].toLowerCase()} for session ${
                        state?.heatNumber ?? "?"
                      }.\n\nReplace it with Session ${race.heatNumber}?`,
                    )
                  ) {
                    return;
                  }
                  onSend();
                }}
              >
                {occupied ? `Replace what is in the ${room} room` : `Send to ${cap(room)} briefing`}
              </ActionButton>
            )}
          </>
        ) : (
          <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: "6px 0" }}>
            Nothing called on {cap(track)} Track.
          </p>
        )}
      </Box>

      {/* ── BOX 2: IN THE ROOM ── */}
      <Box
        label="In the room"
        accent={color}
        dim={!occupied}
        grow
        badge={
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 700,
              padding: "2px 10px",
              borderRadius: 999,
              border: `1px solid ${occupied ? withAlpha(phaseColor(timeline.phase, color), 0.6) : PORTAL_DARK.border}`,
              background: occupied
                ? withAlpha(phaseColor(timeline.phase, color), 0.18)
                : "transparent",
              color: occupied ? "#fff" : PORTAL_DARK.muted,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: phaseColor(timeline.phase, color),
              }}
            />
            {PHASE_LABEL[timeline.phase]}
          </span>
        }
      >
        <InRoom
          room={room}
          color={color}
          state={state}
          timeline={timeline}
          quals={status?.quals ?? null}
          locked={locked}
          pending={pending}
          onStart={onStart}
          onUndo={onUndo}
        />
      </Box>
    </div>
  );
}

/* ── the in-room body: what is on that TV, per phase ──────────────────── */

function InRoom({
  room,
  color,
  state,
  timeline,
  quals,
  locked,
  pending,
  onStart,
  onUndo,
}: {
  room: BriefingRoom;
  color: string;
  state: BriefingRoomState | null;
  timeline: BriefingTimeline;
  quals: RoomStatus["quals"];
  locked: boolean;
  pending: string | null;
  onStart: (restart: boolean) => void;
  onUndo: () => void;
}) {
  const phase = timeline.phase;
  const qualCount = quals?.qualifiers.length ?? 0;
  const running = phase === "video" || phase === "helmet" || phase === "quals";
  const pct =
    timeline.videoMs > 0 ? Math.min(100, (timeline.videoOffsetMs / timeline.videoMs) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      {phase !== "idle" && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>
            {state?.heatNumber != null ? `Session ${state.heatNumber}` : "Briefing"}
          </span>
          {state?.tier && (
            <span style={{ fontSize: 13, color: PORTAL_DARK.muted }}>{cap(state.tier)} video</span>
          )}
        </div>
      )}

      {phase === "idle" && (
        <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: "4px 0" }}>
          Empty — the TV is showing helmet sizes.
        </p>
      )}

      {phase === "waiting" && (
        <>
          <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
            Holding on a &ldquo;take a seat&rdquo; board.
          </p>
          {!state?.videoUrl && (
            <p style={{ fontSize: 11, color: AMBER, margin: 0 }}>
              No film for this tier — Start goes straight to helmet sizes.
            </p>
          )}
          <div style={{ marginTop: "auto", display: "grid", gap: 8 }}>
            <ActionButton
              variant="primary"
              tone={GREEN}
              textColor="#04240f"
              pendingKey={`start:${room}`}
              pending={pending}
              disabled={locked}
              pendingLabel="Starting…"
              onClick={() => onStart(false)}
            >
              ▶ Start video
            </ActionButton>
            <ActionButton
              variant="ghost"
              pendingKey={`clear:${room}`}
              pending={pending}
              disabled={locked}
              pendingLabel="Undoing…"
              onClick={() => {
                if (window.confirm(`Undo the send to the ${room} room?`)) onUndo();
              }}
            >
              Undo send
            </ActionButton>
          </div>
        </>
      )}

      {running && (
        <>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
            <div>
              <div
                style={{
                  fontSize: 46,
                  fontWeight: 800,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                  color: "#fff",
                }}
              >
                {timeline.nextInMs != null ? formatClock(timeline.nextInMs) : "—"}
              </div>
              <div style={{ fontSize: 11, color: PORTAL_DARK.muted, marginTop: 3 }}>
                {phase === "video"
                  ? "left in the briefing video"
                  : phase === "helmet"
                    ? "until the levelled-up board"
                    : "until the room goes idle"}
              </div>
            </div>

            {phase === "video" && timeline.videoMs > 0 && (
              <div
                style={{
                  marginLeft: "auto",
                  textAlign: "right",
                  fontSize: 12,
                  color: PORTAL_DARK.muted,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <div>
                  {formatClock(timeline.videoOffsetMs)} played of {formatClock(timeline.videoMs)}
                </div>
                <div style={{ fontSize: 11 }}>{Math.round(pct)}% through</div>
              </div>
            )}
          </div>

          {phase === "video" && timeline.videoMs > 0 && (
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: "rgba(255,255,255,0.10)",
                overflow: "hidden",
              }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-label="Briefing video progress"
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: color,
                  transition: "width 1s linear",
                }}
              />
            </div>
          )}

          {phase === "quals" && (
            <span style={{ fontSize: 13, color: qualCount > 0 ? GREEN : PORTAL_DARK.muted }}>
              {qualCount > 0 && quals
                ? `On screen — ${quals.qualifiers.map((q) => `${q.firstName} (${q.level})`).join(", ")}`
                : "Nobody levelled up, so it fell back to helmet sizes."}
            </span>
          )}

          <span style={{ fontSize: 11, color: PORTAL_DARK.muted }}>
            {phase === "video"
              ? "then helmet sizes → levelled up"
              : phase === "helmet"
                ? "then levelled up"
                : ""}
          </span>

          <div style={{ marginTop: "auto" }}>
            <ActionButton
              variant="ghost"
              tone={color}
              pendingKey={`restart:${room}`}
              pending={pending}
              disabled={locked}
              pendingLabel="Restarting…"
              onClick={() => onStart(true)}
              title="Play the briefing from the top — latecomers, or a second showing"
              full
            >
              ⟲ Restart video
            </ActionButton>
          </div>
        </>
      )}
    </div>
  );
}

/* ── pieces ───────────────────────────────────────────────────────────── */

/**
 * A button that acknowledges its own press.
 *
 * `pendingKey` is compared against the one action actually in flight, so THIS
 * button spins while the others simply go inert — the difference between "did that
 * work?" and knowing it did.
 */
function ActionButton({
  children,
  onClick,
  variant,
  tone,
  textColor,
  outline,
  pendingKey,
  pending,
  disabled,
  pendingLabel,
  title,
  full,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant: "primary" | "ghost";
  tone?: string;
  textColor?: string;
  outline?: boolean;
  pendingKey: string;
  pending: string | null;
  disabled?: boolean;
  pendingLabel: string;
  title?: string;
  full?: boolean;
}) {
  const isPending = pending === pendingKey;
  const primary = variant === "primary";
  // ONLY this button's own request disables it (plus a genuinely invalid state).
  // A single global `busy` locked the whole board on every press, so a staff
  // member could not queue Blue while Red was still saving (owner 2026-08-11:
  // "make sure buttons are available when they're supposed to be").
  const isDisabled = isPending || disabled === true;
  return (
    <button
      type="button"
      className={primary ? "rcb rcb-primary" : "rcb"}
      onClick={onClick}
      title={title}
      aria-busy={isPending}
      disabled={isDisabled}
      style={{
        width: full || primary ? "100%" : undefined,
        padding: primary ? "15px 18px" : "8px 14px",
        borderRadius: primary ? 9 : 7,
        fontSize: primary ? 17 : 12,
        background: outline ? "transparent" : primary ? tone : "transparent",
        borderColor: outline ? tone : primary ? "transparent" : (tone ?? PORTAL_DARK.border),
        color: outline ? tone : primary ? (textColor ?? "#fff") : PORTAL_DARK.fg,
      }}
    >
      {isPending && <span aria-hidden className="rcb-spin" />}
      {isPending ? pendingLabel : children}
    </button>
  );
}

function Box({
  label,
  accent,
  badge,
  dim,
  grow,
  children,
}: {
  label: string;
  accent: string;
  badge?: React.ReactNode;
  dim?: boolean;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${PORTAL_DARK.border}`,
        borderLeft: `3px solid ${dim ? PORTAL_DARK.border : accent}`,
        background: PORTAL_DARK.card,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 9,
        ...(grow ? { flex: 1, minHeight: 0 } : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.10em",
            textTransform: "uppercase",
            color: PORTAL_DARK.muted,
          }}
        >
          {label}
        </span>
        {badge && <span style={{ marginLeft: "auto" }}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function Banner({ tone, children }: { tone: "warn" | "ok"; children: React.ReactNode }) {
  const color = tone === "warn" ? AMBER : GREEN;
  return (
    <div
      role="status"
      style={{
        marginBottom: 10,
        padding: "8px 12px",
        borderRadius: 8,
        border: `1px solid ${withAlpha(color, 0.45)}`,
        background: withAlpha(color, 0.1),
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function phaseColor(phase: BriefingPhase, roomColor: string): string {
  if (phase === "waiting") return AMBER;
  if (phase === "quals") return GREEN;
  if (phase === "idle") return PORTAL_DARK.muted;
  return roomColor;
}

function findDelay(tracks: TrackInfo[] | undefined, track: string): TrackInfo | null {
  if (!tracks) return null;
  return tracks.find((t) => (t.trackName || "").toLowerCase().includes(track)) ?? null;
}

/** `m:ss`. Ceiled — a timer reading 0:00 while a film is still playing is worse
 *  than one that rounds up. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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
  if (mins < 1) return "called just now";
  if (mins === 1) return "called 1 min ago";
  return `called ${mins} min ago`;
}
