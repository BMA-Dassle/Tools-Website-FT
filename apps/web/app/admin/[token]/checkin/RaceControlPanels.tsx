"use client";

/**
 * Race control — the briefing-room half of the check-in station's `?board=1`.
 *
 * EMBEDDED, NOT A PAGE. It renders inside CheckInClient, because the person who
 * checks racers in is the person who sends the heat to a briefing room (owner:
 * "this was supposed to be a dual board, where is all the check in stuff"). State
 * lives in useBriefingControl one level up, because the scan flash unmounts this
 * subtree for four seconds.
 *
 * IT IS A TIMING BOARD FIRST (owner 2026-08-11: "timing is important — checking in
 * for X minutes, how long the video has been running… delay on track time is
 * important"). So the layout is built around four numbers, each a labelled tile
 * with its unit:
 *
 *   CHECKING IN   how long since the heat was called
 *   TRACK DELAY   how far behind the track is running
 *   ELAPSED       how long the film has been playing
 *   LEFT          how long until the room's board changes
 *
 * Everything else is subordinate to those. An earlier pass made Send a full-width
 * saturated slab, which read as the most important thing on a board whose actual
 * job is telling staff where the time has gone ("feels busy and the button is
 * overwhelming"). Send is now a normal control at the end of its row; the room
 * colour is a thin spine and a small fill, never a wall of red.
 *
 * TWO BOXES PER ROOM — Called, and In the room. That is what makes the busy case
 * legible: a second heat called mid-briefing is two boxes saying two different
 * things, rather than one box trying to be both. Sending into an occupied room
 * still works; it asks first.
 *
 * TWO PHASES PER SEND. Send assigns the room and holds a "take a seat" board;
 * Start rolls the film, because a group still walking over would miss the opening.
 * Undo covers a mis-send, Restart covers latecomers.
 *
 * NUMBERS TICK LOCALLY. The board polls every 5 seconds, which would make a timer
 * visibly jump, so a 1s clock drives the readouts and the phase comes from
 * briefingTimelineAt — the SAME pure function the TV runs, so desk and wall agree.
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

const ROOM_COLOR: Record<BriefingRoom, string> = { red: "#ff5a52", blue: "#4a9bff" };
const MEGA = "#a06bff";
const GREEN = "#4ade80";
const AMBER = "#f0b341";
const INK = "#e8eef7";

const PHASE_LABEL: Record<BriefingPhase, string> = {
  waiting: "Waiting to start",
  video: "Video playing",
  helmet: "Helmet sizes",
  idle: "Free",
};

const STYLES = `
.rcb {
  border: 1px solid transparent; cursor: pointer; font-weight: 650;
  transition: filter 120ms ease, transform 60ms ease, background 120ms ease;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  white-space: nowrap;
}
.rcb:hover:not(:disabled) { filter: brightness(1.15); }
.rcb:active:not(:disabled) { transform: translateY(1px); filter: brightness(0.93); }
.rcb:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
.rcb:disabled { opacity: 0.35; cursor: not-allowed; filter: none; }
.rcb[aria-busy="true"] { cursor: progress; }
.rcb-spin {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: rcb-spin 650ms linear infinite;
}
@keyframes rcb-spin { to { transform: rotate(360deg); } }
.rc-num { font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
`;

/** A local 1-second clock, so every readout ticks between 5-second polls. */
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
      className="flex flex-col border-t"
      style={{
        borderColor: PORTAL_DARK.border,
        flex: 1,
        minHeight: 0,
        padding: "14px 20px 16px",
      }}
      aria-label="Race control"
    >
      <style>{STYLES}</style>

      <header
        className="flex items-center gap-3"
        style={{ flexWrap: "wrap", flexShrink: 0, marginBottom: 12 }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: "0.08em",
            margin: 0,
            color: PORTAL_DARK.muted,
            textTransform: "uppercase",
          }}
        >
          Briefing rooms
        </h2>
        {megaEnabled && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              padding: "2px 9px",
              borderRadius: 4,
              background: withAlpha(MEGA, 0.2),
              border: `1px solid ${withAlpha(MEGA, 0.5)}`,
              color: MEGA,
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
              fontSize: 12,
              color: note.startsWith("✕") ? AMBER : GREEN,
            }}
          >
            {note}
          </span>
        )}
      </header>

      {(board?.enabled === false || noVideos) && (
        <div style={{ display: "grid", gap: 6, marginBottom: 10, flexShrink: 0 }}>
          {board?.enabled === false && (
            <Note>Briefing rooms are switched off — sends are refused.</Note>
          )}
          {noVideos && (
            <Note>
              No briefing videos uploaded — rooms show helmet sizes. Add them on the Lobby TVs page.
            </Note>
          )}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(auto-fit,minmax(430px,1fr))",
          alignItems: "stretch",
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
              proFilmMissing={!board?.videos.pro}
              // Once a session has gone to EITHER room it leaves the Called boxes
              // (owner 2026-08-11: "once a session is moved to the room it should
              // clear from these top boxes"). It is no longer waiting to be sent, so
              // leaving it there only invites sending it twice.
              sentTo={
                board?.assignments.find(
                  (a) => a.mode === "timeline" && !!race && a.sessionId === String(race.sessionId),
                )?.room ?? null
              }
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
        <details style={{ marginTop: 10, flexShrink: 0 }}>
          <summary style={{ cursor: "pointer", fontSize: 11, color: PORTAL_DARK.muted }}>
            Sent today ({board?.assignments.length})
          </summary>
          <div style={{ marginTop: 6, display: "grid", gap: 2 }}>
            {board?.assignments.slice(0, 10).map((a) => (
              <div
                key={a.id}
                className="rc-num"
                style={{ display: "flex", gap: 10, fontSize: 11, color: PORTAL_DARK.muted }}
              >
                <span style={{ color: ROOM_COLOR[a.room], fontWeight: 800, minWidth: 38 }}>
                  {a.room.toUpperCase()}
                </span>
                <span style={{ minWidth: 90 }}>
                  {a.mode === "quals-only" ? "Levelled-up" : `Session ${a.heatNumber ?? "?"}`}
                </span>
                <span style={{ minWidth: 90 }}>{a.raceType ?? ""}</span>
                <span style={{ marginLeft: "auto" }}>{clockTime(a.sentAt)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/* ── one room ──────────────────────────────────────────────────────────── */

function RoomColumn({
  room,
  track,
  race,
  delay,
  status,
  proFilmMissing,
  nowMs,
  sentTo,
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
  /** No Pro film uploaded — a Pro pick will play the Intermediate film. */
  proFilmMissing: boolean;
  nowMs: number;
  /** Which room this called session already went to, if any. */
  sentTo: BriefingRoom | null;
  tierOverride: BriefingTier | null;
  onTierOverride: (tier: BriefingTier | null) => void;
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
  // The desk says what will REALLY play before the send: a Pro pick with no Pro
  // film uploaded runs the Intermediate film (owner 2026-08-11). Availability
  // comes down as a prop — `board` lives in the parent.
  const proMissing = tier === "pro" && proFilmMissing;
  const sameSessionInRoom = !!race && state?.sessionId === String(race.sessionId);

  const calledMs = race?.calledAt ? Date.parse(race.calledAt) : NaN;
  const checkingInMs = Number.isFinite(calledMs) ? Math.max(0, nowMs - calledMs) : null;
  const delayMins = delay?.delayMinutes ?? null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 0,
        borderLeft: `3px solid ${color}`,
        paddingLeft: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexShrink: 0 }}>
        <strong style={{ fontSize: 15, color, letterSpacing: "0.02em" }}>
          {cap(room).toUpperCase()} ROOM
        </strong>
        <span style={{ fontSize: 11, color: PORTAL_DARK.muted }}>{cap(track)} Track</span>
      </div>

      {/* ── CALLED ── */}
      <Panel label="Called" flat>
        {race && !sentTo ? (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <div style={{ minWidth: 150 }}>
                <div
                  className="rc-num"
                  style={{ fontSize: 34, fontWeight: 800, lineHeight: 1.05, color: INK }}
                >
                  Session {race.heatNumber}
                </div>
                <div style={{ fontSize: 14, color: PORTAL_DARK.muted, marginTop: 2 }}>
                  {race.raceType}
                </div>
              </div>

              {/* The two numbers that matter before a send. */}
              <Stat
                label="Checking in"
                value={checkingInMs != null ? formatClock(checkingInMs) : "—"}
                unit="since called"
              />
              <Stat
                label="Track delay"
                value={delayMins != null ? (delayMins > 0 ? `+${delayMins}` : "0") : "—"}
                unit={delayMins && delayMins > 0 ? "min behind" : "on time"}
                tone={delayMins && delayMins > 0 ? AMBER : undefined}
              />
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 2,
              }}
            >
              <span style={{ fontSize: 10, color: PORTAL_DARK.muted, letterSpacing: "0.06em" }}>
                VIDEO
              </span>
              {(["starter", "intermediate", "pro"] as BriefingTier[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="rcb"
                  onClick={() => onTierOverride(t === autoTier ? null : t)}
                  aria-pressed={tier === t}
                  style={{
                    padding: "4px 11px",
                    borderRadius: 5,
                    borderColor: tier === t ? withAlpha(color, 0.8) : PORTAL_DARK.border,
                    background: tier === t ? withAlpha(color, 0.16) : "transparent",
                    color: tier === t ? INK : PORTAL_DARK.muted,
                    fontSize: 11,
                  }}
                >
                  {cap(t)}
                  {t === autoTier ? " · auto" : ""}
                </button>
              ))}
              {/* Say what will REALLY play, before the send — the fallback is
                  server-side, and hiding it would leave staff thinking a Pro grid
                  is getting a film that does not exist yet. */}
              {proMissing && (
                <span style={{ fontSize: 10, color: AMBER }}>
                  no Pro film yet — plays Intermediate
                </span>
              )}

              {sameSessionInRoom ? (
                <span style={{ marginLeft: "auto", fontSize: 11, color: GREEN }}>
                  ✓ in the {room} room
                </span>
              ) : (
                <span style={{ marginLeft: "auto" }}>
                  <ActionButton
                    tone={occupied ? AMBER : color}
                    outline={occupied}
                    size="md"
                    pendingKey={`send:${room}`}
                    pending={pending}
                    disabled={!race.sessionId || locked}
                    pendingLabel={occupied ? "Replacing…" : "Sending…"}
                    onClick={() => {
                      if (
                        occupied &&
                        !window.confirm(
                          `The ${room} room is showing ${PHASE_LABEL[
                            timeline.phase
                          ].toLowerCase()} for session ${state?.heatNumber ?? "?"}.\n\nReplace it with Session ${race.heatNumber}?`,
                        )
                      ) {
                        return;
                      }
                      onSend();
                    }}
                  >
                    {occupied ? "Replace" : `Send to ${cap(room)} →`}
                  </ActionButton>
                </span>
              )}
            </div>
          </>
        ) : sentTo && race ? (
          <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: "2px 0" }}>
            Session {race.heatNumber} went to the {sentTo} room — waiting on the next call.
          </p>
        ) : (
          <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: "2px 0" }}>
            Nothing called on {cap(track)} Track.
          </p>
        )}
      </Panel>

      {/* ── IN THE ROOM ── */}
      <Panel
        label="In the room"
        grow
        accent={occupied ? phaseColor(timeline.phase, color) : undefined}
        badge={
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.05em",
              color: occupied ? phaseColor(timeline.phase, color) : PORTAL_DARK.muted,
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
            {PHASE_LABEL[timeline.phase].toUpperCase()}
          </span>
        }
      >
        <InRoom
          room={room}
          color={color}
          state={state}
          timeline={timeline}
          nowMs={nowMs}
          locked={locked}
          pending={pending}
          onStart={onStart}
          onUndo={onUndo}
        />
      </Panel>
    </div>
  );
}

/* ── the in-room body ──────────────────────────────────────────────────── */

function InRoom({
  room,
  color,
  state,
  timeline,
  nowMs,
  locked,
  pending,
  onStart,
  onUndo,
}: {
  room: BriefingRoom;
  color: string;
  state: BriefingRoomState | null;
  timeline: BriefingTimeline;
  nowMs: number;
  locked: boolean;
  pending: string | null;
  onStart: (restart: boolean) => void;
  onUndo: () => void;
}) {
  const phase = timeline.phase;
  const running = phase === "video" || phase === "helmet";
  const pct =
    timeline.videoMs > 0 ? Math.min(100, (timeline.videoOffsetMs / timeline.videoMs) * 100) : 0;
  const waitingMs = state ? Math.max(0, nowMs - state.triggeredAtMs) : 0;

  if (phase === "idle") {
    return (
      <p style={{ fontSize: 13, color: PORTAL_DARK.muted, margin: 0 }}>
        Empty — the TV is showing helmet sizes.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className="rc-num" style={{ fontSize: 20, fontWeight: 800, color: INK }}>
          {state?.heatNumber != null ? `Session ${state.heatNumber}` : "Briefing"}
        </span>
        {state?.raceType && (
          <span style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{state.raceType}</span>
        )}
        {state?.tier && (
          <span style={{ fontSize: 11, color: PORTAL_DARK.muted }}>· {state.tier} film</span>
        )}
      </div>

      {phase === "waiting" && (
        <>
          <Stat label="Waiting" value={formatClock(waitingMs)} unit="since sent" tone={AMBER} big />
          <p style={{ fontSize: 12, color: PORTAL_DARK.muted, margin: 0 }}>
            TV is holding a &ldquo;take a seat&rdquo; board.
            {!state?.videoUrl && " No film for this tier — Start skips to helmet sizes."}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: "auto", alignItems: "center" }}>
            <ActionButton
              tone={GREEN}
              textColor="#052e14"
              size="lg"
              pendingKey={`start:${room}`}
              pending={pending}
              disabled={locked}
              pendingLabel="Starting…"
              onClick={() => onStart(false)}
            >
              ▶ Start video
            </ActionButton>
            <ActionButton
              size="sm"
              pendingKey={`clear:${room}`}
              pending={pending}
              disabled={locked}
              pendingLabel="Undoing…"
              onClick={() => {
                if (window.confirm(`Undo the send to the ${room} room?`)) onUndo();
              }}
            >
              Undo
            </ActionButton>
          </div>
        </>
      )}

      {running && (
        <>
          {/* THE TIMING ROW. */}
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            {phase === "video" ? (
              <>
                <Stat
                  label="Elapsed"
                  value={formatClock(timeline.videoOffsetMs)}
                  unit={`of ${formatClock(timeline.videoMs)}`}
                  big
                />
                <Stat
                  label="Left"
                  value={timeline.nextInMs != null ? formatClock(timeline.nextInMs) : "—"}
                  unit="of the film"
                  big
                  tone={color}
                />
              </>
            ) : (
              <Stat
                label="Left"
                value={timeline.nextInMs != null ? formatClock(timeline.nextInMs) : "—"}
                unit="until the room is free"
                big
                tone={color}
              />
            )}
          </div>

          {phase === "video" && timeline.videoMs > 0 && (
            <div>
              <div
                style={{
                  height: 6,
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.09)",
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
              <div
                className="rc-num"
                style={{ fontSize: 10, color: PORTAL_DARK.muted, marginTop: 4 }}
              >
                {Math.round(pct)}% · then helmet sizes, then free
              </div>
            </div>
          )}

          <div style={{ marginTop: "auto" }}>
            <ActionButton
              size="sm"
              tone={color}
              pendingKey={`restart:${room}`}
              pending={pending}
              disabled={locked}
              pendingLabel="Restarting…"
              onClick={() => onStart(true)}
              title="Play from the top — latecomers, or a second showing"
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

/** A labelled number with its unit. The board is read at a glance, so the value is
 *  large and tabular and the words around it are small. */
function Stat({
  label,
  value,
  unit,
  tone,
  big,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: string;
  big?: boolean;
}) {
  return (
    <div style={{ minWidth: big ? 118 : 96 }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          color: PORTAL_DARK.muted,
        }}
      >
        {label}
      </div>
      <div
        className="rc-num"
        style={{
          fontSize: big ? 40 : 28,
          fontWeight: 800,
          lineHeight: 1.1,
          color: tone ?? INK,
        }}
      >
        {value}
      </div>
      {unit && <div style={{ fontSize: 10, color: PORTAL_DARK.muted }}>{unit}</div>}
    </div>
  );
}

function Panel({
  label,
  badge,
  accent,
  grow,
  flat,
  children,
}: {
  label: string;
  badge?: React.ReactNode;
  accent?: string;
  grow?: boolean;
  flat?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${accent ? withAlpha(accent, 0.35) : PORTAL_DARK.border}`,
        background: flat ? "transparent" : PORTAL_DARK.card,
        borderRadius: 8,
        padding: "10px 12px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        ...(grow ? { flex: 1, minHeight: 0 } : { flexShrink: 0 }),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.12em",
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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        border: `1px solid ${withAlpha(AMBER, 0.35)}`,
        background: withAlpha(AMBER, 0.08),
        fontSize: 12,
        color: INK,
      }}
    >
      {children}
    </div>
  );
}

/** A button that acknowledges its own press: only the in-flight one disables, and
 *  it is the one that spins. */
function ActionButton({
  children,
  onClick,
  tone,
  textColor,
  outline,
  size,
  pendingKey,
  pending,
  disabled,
  pendingLabel,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: string;
  textColor?: string;
  outline?: boolean;
  size: "sm" | "md" | "lg";
  pendingKey: string;
  pending: string | null;
  disabled?: boolean;
  pendingLabel: string;
  title?: string;
}) {
  const isPending = pending === pendingKey;
  const pad = size === "lg" ? "11px 20px" : size === "md" ? "9px 16px" : "6px 12px";
  const font = size === "lg" ? 15 : size === "md" ? 13 : 11;
  const solid = !!tone && !outline && size !== "sm";
  return (
    <button
      type="button"
      className="rcb"
      onClick={onClick}
      title={title}
      aria-busy={isPending}
      disabled={isPending || disabled === true}
      style={{
        padding: pad,
        borderRadius: 6,
        fontSize: font,
        background: solid ? tone : "transparent",
        borderColor: solid ? "transparent" : tone ? withAlpha(tone, 0.55) : PORTAL_DARK.border,
        color: solid ? (textColor ?? "#0b1220") : (tone ?? PORTAL_DARK.fg),
      }}
    >
      {isPending && <span aria-hidden className="rcb-spin" />}
      {isPending ? pendingLabel : children}
    </button>
  );
}

function phaseColor(phase: BriefingPhase, roomColor: string): string {
  if (phase === "waiting") return AMBER;
  if (phase === "idle") return PORTAL_DARK.muted;
  return roomColor;
}

function findDelay(tracks: TrackInfo[] | undefined, track: string): TrackInfo | null {
  if (!tracks) return null;
  return tracks.find((t) => (t.trackName || "").toLowerCase().includes(track)) ?? null;
}

/** `m:ss`, ceiled — a timer reading 0:00 while a film still plays is worse than one
 *  that rounds up. */
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
