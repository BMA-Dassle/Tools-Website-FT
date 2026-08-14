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
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { formatLap, nextLevelTarget } from "~/features/racing/qualify";
import { withAlpha } from "../color";
import { LiveSessionChip, useLiveSessionClock } from "../live-session";
import { liveHeatNumber } from "../briefing/room-return";
import {
  TRACK_ACCENTS,
  TRACK_LABELS,
  effectiveTrack,
  trackFromResourceIds,
  type TrackKey,
} from "../track";
import {
  EMPTY_PIT_LANE,
  mergePitRoster,
  pitRailState,
  type PitLaneFeed,
  type PitRosterEntry,
} from "../pit/pit-board";
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

/** The one photo switch (owner toggled off 2026-08-13, back on same day).
 *  Off = silhouettes only, and the board never calls /api/tv/pit-photo. */
const PIT_PHOTOS_ENABLED = true;

export function ScenePitBoard({ feed, config }: SceneProps) {
  const status = useTrackStatus();
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;

  const screenTrack = trackFromResourceIds(config.scope.resourceIds);
  const track = effectiveTrack(screenTrack, megaEnabled) ?? screenTrack ?? "blue";
  const accent = TRACK_ACCENTS[track];

  const liveClock = useLiveSessionClock(track);

  /** Is this heat ARMED BUT NOT RACING — the two-phase start's first window?
   *  Green flag arms the clock at a static number while karts roll out; the
   *  race truly begins when the wire's clock is seen to decrease. */
  const armedNotCounting = (heatNumber: number | null): boolean =>
    heatNumber != null &&
    (liveClock?.state === "running" || liveClock?.state === "paused") &&
    liveHeatNumber(liveClock.heatName) === heatNumber &&
    !liveClock.counting;

  // THE BOARD ROLLS ON GREEN FLAG *AND* A COUNTING CLOCK (owner 2026-08-13).
  // The server rolls its display session the moment the start marker lands —
  // phase one — but stragglers are still being seated until the timer
  // actually runs, so the previous session's board is HELD client-side until
  // its clock counts (or it stops being the heat on track at all).
  const serverBoard = feed?.pitBoard ?? null;
  const [heldBoard, setHeldBoard] = useState(serverBoard);
  useEffect(() => {
    setHeldBoard((prev) => {
      if (!serverBoard?.session || !prev?.session) return serverBoard;
      if (prev.session.sessionId === serverBoard.session.sessionId) return serverBoard;
      return armedNotCounting(prev.session.heatNumber) ? prev : serverBoard;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- armedNotCounting
    // closes over liveClock, which is already a dependency.
  }, [serverBoard, liveClock]);

  const pit = heldBoard;
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

  // THE ROSTER TRACKS THE DESK IN SECONDS, three layers deep:
  //   1. the FAST roster on the 2s pulse (membership, check-ins, BMI grid) —
  //      the authority whenever it matches the display session,
  //   2. the scan-event overlay (racerKey `{personId}:{sessionId}`), which can
  //      beat even the fast cache by a beat,
  //   3. the 15s full build, which reconciles everything and carries the slow
  //      joins (camera, birthday, VIP).
  const roster = useMemo<PitRosterEntry[] | null>(() => {
    let rows = pit?.roster ?? null;
    if (!session) return rows;
    const fast = feed?.pitRosters?.[track];
    if (fast && fast.sessionId === session.sessionId && fast.rows.length > 0) {
      rows = mergePitRoster(fast.rows, rows ?? []);
    }
    if (!rows) return rows;
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
  }, [pit?.roster, session, track, feed?.pitRosters, feed?.kioskEvents]);

  // RACING MEANS THE CLOCK IS COUNTING, nothing less. The socket both sees
  // the green flag before the server's webhook marker AND vetoes it through
  // the two-phase start: while the staged heat is armed with a static clock,
  // the rail keeps saying seat — that window is exactly when stragglers are
  // still being walked to karts.
  const stagedArmed = armedNotCounting(session?.heatNumber ?? null);
  const stagedRacing =
    liveClock?.state === "running" &&
    liveClock.counting &&
    session?.heatNumber != null &&
    liveHeatNumber(liveClock.heatName) === session.heatNumber;

  /**
   * A RACING SESSION LEAVES THIS BOARD (owner 2026-08-14: "when a session starts
   * it should remove it from the pit assignment boards").
   *
   * These screens hang over the pit seats and answer one question — which spot
   * is mine. Once the heat is on track that question is answered and the seats
   * are empty, so the board showing a grid of racers who are no longer in front
   * of it is worse than showing nothing: the next group walking up reads it as
   * theirs.
   *
   * AND IT IS STICKY, for the same reason the desk's is. The clock only
   * publishes while a heat runs, so `stagedRacing` goes false at the flag — and
   * the finished session would walk straight back onto the wall until the server
   * caught up. Once this screen has watched a session count, that session is
   * done here, whatever the clock says afterwards.
   */
  const racedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (stagedRacing && session?.sessionId) racedRef.current.add(session.sessionId);
  }, [stagedRacing, session?.sessionId]);
  const sessionHasRaced = !!session?.sessionId && racedRef.current.has(session.sessionId);
  const showSession = stagedRacing || sessionHasRaced ? null : session;

  const rail = pitRailState({
    stagedInHolding: session?.inHolding ?? false,
    stagedStartedAtMs: stagedArmed ? null : (session?.startedAtMs ?? (stagedRacing ? 0 : null)),
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
          inset: `${PAD_Y}px ${PAD_X}px ${RAIL_H + 48}px`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* CENTERED, not top-hung: with the chip alone on the right edge a
            flex-start header left it visually adrift in the band (owner
            2026-08-13, "timer closer to bottom than top"). Every header item
            now shares one vertical center. */}
        <header style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: accent,
              boxShadow: `0 0 24px ${accent}`,
              flexShrink: 0,
            }}
          />
          <div>
            <div
              className="tv-display"
              style={{
                color: accent,
                fontSize: 46,
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
                textShadow: `0 0 34px ${withAlpha(accent, 0.65)}`,
              }}
            >
              {TRACK_LABELS[track]}
            </div>
            <DelayLine delay={delay} />
          </div>
          {/* nowrap THROUGHOUT this block: .tv-display carries text-wrap:
              balance, which broke "Session 56" onto two lines the first time
              the header shared a row with the room chips (live 2026-08-13). */}
          <div style={{ marginLeft: 44, minWidth: 0 }}>
            <div className="tv-eyebrow" style={{ fontSize: 26 }}>
              Pit assignments
            </div>
            {showSession ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 22, marginTop: 6 }}>
                <span
                  className="tv-display"
                  style={{
                    fontSize: 84,
                    color: "#fff",
                    whiteSpace: "nowrap",
                    textShadow: `0 0 60px ${withAlpha(accent, 0.55)}`,
                  }}
                >
                  {showSession.heatNumber != null
                    ? `Session ${showSession.heatNumber}`
                    : "Next session"}
                </span>
                {showSession.raceType && (
                  <span
                    className="tv-display"
                    style={{
                      fontSize: 42,
                      color: "rgba(245,236,238,0.72)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {showSession.raceType}
                  </span>
                )}
              </div>
            ) : (
              <div className="tv-display" style={{ fontSize: 64, color: "#fff", marginTop: 6 }}>
                No session staged
              </div>
            )}
          </div>
          {/* The one clock, and nothing else — the room-status chips that
              briefly lived here were not part of the approved mockup and the
              mockup is the target (owner 2026-08-13). */}
          <div style={{ marginLeft: "auto", flexShrink: 0 }}>
            <LiveSessionChip track={track} accent={accent} />
          </div>
        </header>

        {roster && roster.length > 0 && showSession ? (
          <SpotGrid roster={roster} accent={accent} sessionId={showSession.sessionId} />
        ) : (
          <Idle accent={accent} hasSession={!!showSession} />
        )}
      </div>

      <Rail
        kind={rail}
        accent={accent}
        session={session}
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
        // CAPPED AND CENTERED, never stretched to fill. The first live render
        // (2026-08-13) had one racer on the roster and `1fr` handed that card
        // the entire grid — a silhouette the size of the wall. A card is a
        // card: small heats get vendor-board-sized portrait cards centered on
        // the canvas, and only full grids divide the width evenly.
        gridTemplateColumns: `repeat(${cols}, minmax(0, ${n <= 4 ? "430px" : "1fr"}))`,
        // Small heats keep the MOCKUP's card proportions (~430×420) rather
        // than growing portrait — the approved board is the target, verbatim.
        gridAutoRows: n <= 4 ? "minmax(0, 420px)" : "minmax(0, 1fr)",
        justifyContent: "center",
        alignContent: "center",
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
      <div style={{ position: "relative", flex: 1, minHeight: compact ? 120 : 180 }}>
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
            fontSize: compact ? 64 : 92,
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
          padding: "14px 20px 16px",
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
            fontSize: compact ? 25 : 31,
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
          // Faces are decoration, names are the job (owner 2026-08-13): the
          // silhouette+name card paints immediately, and the photo loads at
          // the connection's LOWEST priority so it can never delay a poll —
          // popping in whenever it arrives is the designed behaviour.
          decoding="async"
          fetchPriority="low"
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
 * held until the staff "race returned" press. NO CLOCK DOWN HERE (owner
 * 2026-08-13: "we don't need to restate time") — the header's live "On track"
 * chip is the one clock on this board. The qualification pill is for the
 * group already in the seats, who are looking at exactly this screen.
 */
function Rail({
  kind,
  accent,
  session,
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
  qual: { lap: string; level: string } | null;
}) {
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

  // ONE LINE, ALWAYS. The rail is a 128px band: the first live render wrapped
  // both the instruction and the qual pill onto second lines and the band
  // overflowed (2026-08-13). Copy is sized to fit beside the pill at 1920 —
  // anything that cannot say itself in one line does not belong on the rail.
  if (kind === "hold") {
    return (
      <div className="tv-overdue-flash" style={base}>
        <span className="tv-display" style={{ fontSize: 54, whiteSpace: "nowrap" }}>
          Hold — karts coming in
        </span>
        <span
          className="tv-display"
          style={{ marginLeft: "auto", fontSize: 32, opacity: 0.85, whiteSpace: "nowrap" }}
        >
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
        <span className="tv-display" style={{ fontSize: 46, color: GREEN, whiteSpace: "nowrap" }}>
          Seat {sessionName} now
        </span>
        <QualPill qual={qual} accent={accent} />
      </div>
    );
  }

  // info / racing — the rail reports rather than instructs. Copy stays SHORT:
  // the pill needs the right half of the band.
  const infoText =
    kind === "racing"
      ? `${sessionName} is racing`
      : session?.inHolding
        ? `Seat ${sessionName} now`
        : session?.briefedAtMs != null
          ? `In briefing${session.briefedRoom ? ` · ${session.briefedRoom} room` : ""}`
          : `${sessionName} checking in`;
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
      <span
        className="tv-display"
        style={{ fontSize: 42, color: "rgba(245,236,238,0.85)", whiteSpace: "nowrap" }}
      >
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
        flexShrink: 0,
        display: "inline-flex",
        // CENTER, not baseline: mixed sizes on a shared baseline sat the
        // small text visibly low inside the pill (owner 2026-08-13).
        alignItems: "center",
        gap: 16,
        padding: "8px 28px",
        borderRadius: 999,
        border: `2px solid ${withAlpha(accent, 0.6)}`,
        background: withAlpha(accent, 0.14),
        whiteSpace: "nowrap",
      }}
    >
      {/* MOCKUP SIZES, verbatim — the pill is the guest-facing half of the
          rail and reads big; the fit problem was the long info copy beside
          it, which is what got shortened. */}
      <span style={{ fontSize: 32, lineHeight: 1, color: "rgba(245,236,238,0.8)" }}>Beat</span>
      <span className="tv-display tv-num" style={{ fontSize: 54, lineHeight: 1, color: "#fff" }}>
        {qual.lap}
      </span>
      <span style={{ fontSize: 32, lineHeight: 1, color: "rgba(245,236,238,0.8)" }}>
        to qualify {qual.level}
      </span>
    </span>
  );
}
