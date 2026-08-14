"use client";

/**
 * The pit assignment board — replaces the vendor AssignmentTV (owner
 * 2026-08-13). ONE JOB, ALL DAY: the staged session's spots, big and obvious,
 * for the staff member seating the group — readable by everyone at the fence.
 *
 * WHAT THE BOARD SHOWS is decided server-side (pit/service.ts): the group in
 * HOLDING owns the board until their own green flag, then it rolls to the
 * session forming at the desk. The rail along the bottom is the staff
 * instruction, in the machine pit/pit-board.ts owns:
 *
 *   info   the group has not reached the seats yet — report, don't instruct
 *   seat   steady green: the lane is safe EXACTLY while the karts are out
 *   hold   the amber flash: a race finished and its karts are in the lane —
 *          released ONLY by the staff "race returned" press, never a timer
 *   racing their green flag has been seen; the board rolls on the next poll
 *
 * SPOT RULES the cards render: checked-in racers fill the list from the
 * front in check-in order; no-shows always hold the last slots behind a
 * solid red ring on a dimmed card (never flashing — the tail IS the state).
 * Cameras are clipped on in the pit, so each checked-in card carries its
 * camera state; a no-show shows none (nothing to clip until they're here).
 *
 * PII: full names and photos, deliberately — the posture the vendor board
 * has always had, kept by owner decision 2026-08-13. Everything else on the
 * signage estate stays first-names-only.
 */
import { useMemo, type CSSProperties } from "react";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { formatLap, nextLevelTarget } from "~/features/racing/qualify";
import { withAlpha } from "../color";
import { LiveSessionChip, useLiveSessionClock, formatRemaining } from "../live-session";
import {
  TRACK_ACCENTS,
  TRACK_LABELS,
  effectiveTrack,
  trackFromResourceIds,
  type TrackKey,
} from "../track";
import {
  EMPTY_PIT_LANE,
  pitRailState,
  type PitLaneFeed,
  type PitRosterEntry,
} from "../pit/pit-board";
import type { BriefingRoomState } from "../briefing/types";
import type { SceneProps } from "../director/types";

const PAD_X = 96;
const PAD_Y = 54;
const RAIL_H = 128;

const GOLD = "#d4af37";
const PINK = "#ec4899";
const RED = "#ff3b30";
const GREEN = "#22c55e";
const OK = "#46d68c";
const AMBER = "#f0b341";

/** PHOTOS ARE OFF for now (owner 2026-08-13, pre-live): cards show the
 *  silhouette only and the board never calls /api/tv/pit-photo. The endpoint
 *  and the wiring stay — flipping this back on is this one constant. */
const PIT_PHOTOS_ENABLED = false;

export function ScenePitBoard({ feed, config }: SceneProps) {
  const status = useTrackStatus();
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;

  const screenTrack = trackFromResourceIds(config.scope.resourceIds);
  const track = effectiveTrack(screenTrack, megaEnabled) ?? screenTrack ?? "blue";
  const accent = TRACK_ACCENTS[track];

  const pit = feed?.pitBoard ?? null;
  const session = pit?.session ?? null;

  // The lane whose racing/holding state governs this board's rail: the one
  // that actually mentions the display session, falling back to the screen's
  // own track (and to Mega, which is where staff actions land on a Mega day).
  const lane = useMemo<PitLaneFeed>(() => {
    const lanes = feed?.pitLanes ?? null;
    if (!lanes) return EMPTY_PIT_LANE;
    if (session) {
      for (const key of ["blue", "red", "mega"] as TrackKey[]) {
        const l = lanes[key];
        if (
          l?.holding?.sessionId === session.sessionId ||
          l?.racing?.sessionId === session.sessionId
        ) {
          return l;
        }
      }
    }
    const own = lanes[track];
    if (own?.holding || own?.racing) return own;
    return lanes.mega ?? EMPTY_PIT_LANE;
  }, [feed?.pitLanes, session, track]);

  // A SCAN LANDS IN TWO SECONDS, not fifteen: the pulse's event rail carries
  // racerKey `{personId}:{sessionId}`, so a card's ring can drop the moment
  // the desk scans them, with the 15s roster rebuild as the reconciler.
  const roster = useMemo<PitRosterEntry[] | null>(() => {
    const rows = pit?.roster ?? null;
    if (!rows || !session) return rows;
    const scanned = new Set<string>();
    for (const e of feed?.kioskEvents ?? []) {
      if (e.kind !== "racer-scanned" || !e.racerKey) continue;
      const [pid, sid] = e.racerKey.split(":");
      if (sid === session.sessionId && pid) scanned.add(pid);
    }
    if (scanned.size === 0) return rows;
    return rows.map((r) =>
      r.checkedIn || !scanned.has(r.personId) ? r : { ...r, checkedIn: true },
    );
  }, [pit?.roster, session, feed?.kioskEvents]);

  const rail = pitRailState({
    stagedInHolding: session?.inHolding ?? false,
    stagedStartedAtMs: session?.startedAtMs ?? null,
    racingFinishedAtMs: lane.racing?.finishedAtMs ?? null,
    pittedAtMs: lane.racing?.pittedAtMs ?? null,
  });

  // The lap to beat — the group in the seats is looking at exactly this
  // screen. Same constants as the check-in board; null on Mega and Pro.
  const qualTarget = session?.raceType
    ? nextLevelTarget(TRACK_LABELS[track], session.raceType)
    : null;

  const delay = findDelay(status?.trackStatus.tracks, track);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* Track identity, same vocabulary as the check-in boards: the colour
          owns the top bar, a floor glow, and a radial wash. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
          zIndex: 1,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 40%, ${withAlpha(accent, 0.42)}, transparent 74%)`,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 220,
          background: `linear-gradient(to top, ${withAlpha(accent, 0.35)}, transparent)`,
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px ${RAIL_H + 24}px`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: accent,
              boxShadow: `0 0 24px ${accent}`,
              marginTop: 12,
            }}
          />
          <div>
            <div
              className="tv-display"
              style={{
                color: accent,
                fontSize: 46,
                letterSpacing: "0.04em",
                textShadow: `0 0 34px ${withAlpha(accent, 0.65)}`,
              }}
            >
              {TRACK_LABELS[track]}
            </div>
            <DelayLine delay={delay} />
          </div>
          <div style={{ marginLeft: 44 }}>
            <div className="tv-eyebrow" style={{ fontSize: 26 }}>
              Pit assignments
            </div>
            {session ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 22, marginTop: 6 }}>
                <span
                  className="tv-display"
                  style={{
                    fontSize: 84,
                    color: "#fff",
                    textShadow: `0 0 60px ${withAlpha(accent, 0.55)}`,
                  }}
                >
                  {session.heatNumber != null ? `Session ${session.heatNumber}` : "Next session"}
                </span>
                {session.raceType && (
                  <span
                    className="tv-display"
                    style={{ fontSize: 42, color: "rgba(245,236,238,0.72)" }}
                  >
                    {session.raceType}
                  </span>
                )}
              </div>
            ) : (
              <div className="tv-display" style={{ fontSize: 64, color: "#fff", marginTop: 6 }}>
                No session staged
              </div>
            )}
          </div>
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 12,
            }}
          >
            <LiveSessionChip track={track} accent={accent} />
            <RoomStrip rooms={feed?.briefingRooms ?? null} />
          </div>
        </header>

        {roster && roster.length > 0 && session ? (
          <SpotGrid roster={roster} accent={accent} sessionId={session.sessionId} />
        ) : (
          <Idle accent={accent} hasSession={!!session} />
        )}
      </div>

      <Rail
        kind={rail}
        accent={accent}
        session={session}
        track={track}
        qual={qualTarget ? { lap: formatLap(qualTarget.ms), level: qualTarget.level } : null}
      />
    </div>
  );
}

/* ── the grid ─────────────────────────────────────────────────────────── */

function SpotGrid({
  roster,
  accent,
  sessionId,
}: {
  roster: PitRosterEntry[];
  accent: string;
  sessionId: string;
}) {
  const n = roster.length;
  // Four or fewer race as one big row; bigger heats split across two.
  const cols = n <= 4 ? Math.max(n, 1) : Math.min(6, Math.ceil(n / 2));
  const compact = n > 8;
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridAutoRows: "1fr",
        gap: 20,
        marginTop: 22,
      }}
    >
      {roster.map((r) => (
        <SpotCard
          key={r.personId || r.spot}
          r={r}
          accent={accent}
          sessionId={sessionId}
          compact={compact}
        />
      ))}
    </div>
  );
}

/**
 * One spot. The number is plated huge on the photo — assignment first,
 * everything else supporting. A no-show keeps their name, photo and spot; the
 * only change is the solid red ring and a dimmed card (owner 2026-08-13:
 * "just a red border… all not checked in racers must directly fill last
 * slots" — the tail position carries the rest of the message).
 */
function SpotCard({
  r,
  accent,
  sessionId,
  compact,
}: {
  r: PitRosterEntry;
  accent: string;
  sessionId: string;
  compact: boolean;
}) {
  const numCol = r.vip ? GOLD : accent;
  const border = r.vip ? `2px solid ${withAlpha(GOLD, 0.85)}` : "1px solid rgba(255,255,255,0.12)";
  return (
    <div
      style={{
        position: "relative",
        background: "rgba(7,16,39,0.55)",
        border,
        borderRadius: 28,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: r.vip ? `0 0 44px ${withAlpha(GOLD, 0.25)}` : undefined,
      }}
    >
      <div style={{ position: "relative", flex: 1, minHeight: compact ? 120 : 170 }}>
        <Photo sessionId={sessionId} personId={r.personId} />
        <div
          className="tv-display tv-num"
          style={{
            position: "absolute",
            top: 12,
            left: 12,
            padding: "2px 20px",
            borderRadius: 18,
            background: "rgba(0,4,24,0.85)",
            border: `2px solid ${withAlpha(numCol, 0.75)}`,
            fontSize: compact ? 64 : 88,
            color: numCol,
            textShadow: `0 0 34px ${withAlpha(numCol, 0.65)}`,
          }}
        >
          {r.spot}
        </div>
        <div style={{ position: "absolute", top: 14, right: 12, display: "flex", gap: 10 }}>
          {r.birthday && (
            <span
              className="tv-display tv-bday-glow"
              style={{
                fontSize: 20,
                color: "#fff",
                padding: "5px 16px",
                borderRadius: 999,
                border: `2px solid ${PINK}`,
                background: withAlpha(PINK, 0.35),
              }}
            >
              Birthday
            </span>
          )}
          {r.vip && (
            <span
              className="tv-display"
              style={{
                fontSize: 20,
                color: GOLD,
                padding: "5px 16px",
                borderRadius: 999,
                border: `2px solid ${withAlpha(GOLD, 0.8)}`,
                background: "rgba(0,4,24,0.7)",
              }}
            >
              VIP
            </span>
          )}
        </div>
      </div>
      <div
        style={{
          padding: "13px 18px 15px",
          background: "rgba(0,4,24,0.72)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          className="tv-display"
          style={{
            fontSize: compact ? 25 : 30,
            color: "#fff",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {r.name}
        </span>
        {/* Camera state, checked-in cards only — nothing to clip on someone
            who isn't here. Quiet once the rig is on; amber while one is owed. */}
        {r.checkedIn && r.camera && (
          <span
            className="tv-display tv-num"
            style={{
              marginLeft: "auto",
              fontSize: 19,
              color: "rgba(245,236,238,0.65)",
              padding: "4px 13px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.22)",
              whiteSpace: "nowrap",
            }}
          >
            Cam {r.camera}
          </span>
        )}
        {r.checkedIn && !r.camera && r.cameraDue && (
          <span
            className="tv-display"
            style={{
              marginLeft: "auto",
              fontSize: 19,
              color: AMBER,
              padding: "4px 13px",
              borderRadius: 999,
              border: `2px solid ${withAlpha(AMBER, 0.7)}`,
              background: withAlpha(AMBER, 0.12),
              whiteSpace: "nowrap",
            }}
          >
            Cam needed
          </span>
        )}
      </div>
      {!r.checkedIn && (
        <>
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,4,24,0.38)",
              pointerEvents: "none",
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 28,
              border: `5px solid ${RED}`,
              boxShadow: `0 0 44px ${withAlpha(RED, 0.6)}, inset 0 0 28px ${withAlpha(RED, 0.28)}`,
              pointerEvents: "none",
            }}
          />
        </>
      )}
    </div>
  );
}

/** The racer's photo, with the silhouette as the ground so a missing or
 *  still-loading face never leaves a hole in a card. */
function Photo({ sessionId, personId }: { sessionId: string; personId: string }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(160deg, #0d1a36, #071027)",
      }}
    >
      <svg
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
      >
        <circle cx="50" cy="37" r="16" fill="rgba(245,236,238,0.16)" />
        <path d="M16 96c4-22 17-32 34-32s30 10 34 32" fill="rgba(245,236,238,0.12)" />
      </svg>
      {PIT_PHOTOS_ENABLED && /^\d+$/.test(personId) && (
        // eslint-disable-next-line @next/next/no-img-element -- a fixed-size
        // signage canvas on a wall PC; next/image's optimizer buys nothing here
        <img
          src={`/api/tv/pit-photo?session=${sessionId}&person=${personId}`}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
          onError={(e) => {
            // No photo in BMI — the silhouette underneath IS the design.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
    </div>
  );
}

/* ── the staff room strip ─────────────────────────────────────────────── */

/**
 * Which briefing rooms are open — a race can only return to a room nobody is
 * briefing in (owner 2026-08-13), so the seater can see at a glance where the
 * incoming group will hand kit in.
 */
function RoomStrip({ rooms }: { rooms: Record<"red" | "blue", BriefingRoomState | null> | null }) {
  if (!rooms) return null;
  const chip = (room: "red" | "blue") => {
    const state = rooms[room];
    const roomColor = room === "red" ? RED : "#2b8fff";
    const busy = state != null;
    return (
      <span
        key={room}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 16px",
          borderRadius: 999,
          background: "rgba(0,4,24,0.7)",
          border: "1px solid rgba(255,255,255,0.16)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: busy ? roomColor : OK,
            boxShadow: `0 0 10px ${busy ? roomColor : OK}`,
          }}
        />
        <span className="tv-display" style={{ fontSize: 20, color: roomColor }}>
          {room} room
        </span>
        <span
          className="tv-display tv-num"
          style={{ fontSize: 20, color: "rgba(245,236,238,0.6)" }}
        >
          {busy
            ? state.heatNumber != null
              ? `briefing S${state.heatNumber}`
              : "briefing"
            : "open"}
        </span>
      </span>
    );
  };
  return (
    <span style={{ display: "inline-flex", gap: 12 }}>
      {chip("red")}
      {chip("blue")}
    </span>
  );
}

/* ── idle + delay ─────────────────────────────────────────────────────── */

function Idle({ accent, hasSession }: { accent: string; hasSession: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 22,
      }}
    >
      {!hasSession && (
        <div className="tv-display" style={{ fontSize: 96, color: "#fff", lineHeight: 0.95 }}>
          Assignments show here
          <br />
          when a session is called
        </div>
      )}
      <div
        aria-hidden
        style={{
          width: 240,
          height: 5,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${accent}, ${withAlpha(accent, 0)})`,
        }}
      />
    </div>
  );
}

function DelayLine({ delay }: { delay: { delayMinutes: number; delayFormatted: string } | null }) {
  if (!delay) return null;
  const late = delay.delayMinutes > 0;
  const color = late ? AMBER : OK;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
      <span
        aria-hidden
        className={late ? "tv-blink" : undefined}
        style={{ width: 11, height: 11, borderRadius: "50%", background: color }}
      />
      <span className="tv-display" style={{ fontSize: 28, color }}>
        {late
          ? `Running ${delay.delayFormatted || `${delay.delayMinutes} min`} behind`
          : "Running on time"}
      </span>
    </div>
  );
}

function findDelay(
  tracks: { trackName: string; delayMinutes: number; delayFormatted: string }[] | undefined,
  track: TrackKey,
): { delayMinutes: number; delayFormatted: string } | null {
  if (!tracks) return null;
  const hit = tracks.find((t) => new RegExp(`\\b${track}\\b`, "i").test(t.trackName));
  if (!hit) return null;
  return { delayMinutes: hit.delayMinutes ?? 0, delayFormatted: hit.delayFormatted ?? "" };
}

/* ── the seating rail ─────────────────────────────────────────────────── */

/**
 * The staff instruction along the bottom edge. GREEN IS THE RESTING STATE —
 * the lane is safe to seat exactly while the karts are out racing — and the
 * flash is the stop: a race has finished and its karts are rolling back in,
 * held until the staff "race returned" press. The timing rides beside the
 * directive deliberately unlabelled (owner 2026-08-13: the directive names
 * the session that matters); the qualification pill is for the group already
 * in the seats, who are looking at exactly this screen.
 */
function Rail({
  kind,
  accent,
  session,
  track,
  qual,
}: {
  kind: "info" | "seat" | "hold" | "racing";
  accent: string;
  session: {
    heatNumber: number | null;
    briefedRoom: "red" | "blue" | null;
    briefedAtMs: number | null;
    inHolding: boolean;
  } | null;
  track: TrackKey;
  qual: { lap: string; level: string } | null;
}) {
  const clock = useLiveSessionClock(track);
  const clockLabel = clock && clock.state === "running" ? formatRemaining(clock.remainingMs) : null;
  const sessionName = session?.heatNumber != null ? `Session ${session.heatNumber}` : "the session";

  const base: CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: RAIL_H,
    display: "flex",
    alignItems: "center",
    gap: 30,
    padding: `0 ${PAD_X}px`,
    zIndex: 2,
  };

  if (kind === "hold") {
    return (
      <div className="tv-overdue-flash" style={base}>
        <span className="tv-display" style={{ fontSize: 52 }}>
          Hold — karts coming in
        </span>
        <span className="tv-display" style={{ marginLeft: "auto", fontSize: 30, opacity: 0.85 }}>
          Seating resumes when the lane is clear
        </span>
      </div>
    );
  }

  if (kind === "seat") {
    return (
      <div style={{ ...base, background: "rgba(0,4,24,0.88)", borderTop: `4px solid ${GREEN}` }}>
        <span
          aria-hidden
          style={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: GREEN,
            boxShadow: `0 0 18px ${GREEN}`,
          }}
        />
        <span className="tv-display" style={{ fontSize: 46, color: GREEN }}>
          Seat {sessionName} now
        </span>
        {clockLabel && (
          <span className="tv-display tv-num" style={{ fontSize: 56, color: "#fff" }}>
            {clockLabel}
          </span>
        )}
        <QualPill qual={qual} accent={accent} />
      </div>
    );
  }

  // info / racing — the rail reports rather than instructs.
  const infoText =
    kind === "racing"
      ? `${sessionName} is racing`
      : session?.inHolding
        ? `Seat ${sessionName} now`
        : session?.briefedAtMs != null
          ? `In briefing${session.briefedRoom ? ` · ${session.briefedRoom} room` : ""} · seat when they arrive`
          : `${sessionName} checking in at the desk`;
  return (
    <div
      style={{
        ...base,
        background: "rgba(0,4,24,0.88)",
        borderTop: `4px solid ${withAlpha(accent, 0.55)}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: accent,
          boxShadow: `0 0 18px ${accent}`,
        }}
      />
      <span className="tv-display" style={{ fontSize: 42, color: "rgba(245,236,238,0.85)" }}>
        {infoText}
      </span>
      <QualPill qual={qual} accent={accent} />
    </div>
  );
}

function QualPill({
  qual,
  accent,
}: {
  qual: { lap: string; level: string } | null;
  accent: string;
}) {
  if (!qual) return null;
  return (
    <span
      style={{
        marginLeft: "auto",
        display: "inline-flex",
        alignItems: "baseline",
        gap: 16,
        padding: "8px 28px",
        borderRadius: 999,
        border: `2px solid ${withAlpha(accent, 0.6)}`,
        background: withAlpha(accent, 0.14),
      }}
    >
      <span style={{ fontSize: 30, color: "rgba(245,236,238,0.8)" }}>Beat</span>
      <span className="tv-display tv-num" style={{ fontSize: 52, color: "#fff" }}>
        {qual.lap}
      </span>
      <span style={{ fontSize: 30, color: "rgba(245,236,238,0.8)" }}>to qualify {qual.level}</span>
    </span>
  );
}
