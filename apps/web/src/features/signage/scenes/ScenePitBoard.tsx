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
import { briefingTimelineAt } from "../briefing/phase";
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
  pitArrivalNoticeVisible,
  type PitLaneFeed,
  type PitRosterEntry,
} from "../pit/pit-board";
import { TvBrandLogo } from "../components/TvBrandLogo";
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

export function ScenePitBoard({ feed, config, nowMs }: SceneProps) {
  // 2s — the wall repaints on the 2s pulse anyway; session status rides the
  // warm-loop-fresh carry (cacheOnly), never live Pandora.
  const status = useTrackStatus(2_000);
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
          l?.karts?.sessionId === session.sessionId ||
          l?.racing?.sessionId === session.sessionId
        ) {
          return l;
        }
      }
    }
    const own = lanes[track];
    if (own?.holding || own?.karts || own?.racing) return own;
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

  /**
   * PHASE ONE RAISES THE HOLD, FROM THE SOCKET (owner 2026-08-14: "It needs
   * to say HOLD as soon as it hits phase one … this also controls our
   * assignment tv's and these rules are the same"). The finish marker rides
   * bridge → webhook → pulse, seconds behind the flag; this screen's own
   * timing socket flips the heat to "finished" the moment the clock ends.
   * When the finished heat IS the racing group's heat and staff haven't
   * released the lane, the hold shows NOW — a synthetic finished-at of nowMs
   * feeds the same rail machine until the real marker lands. Suppressed once
   * released (the socket keeps saying "finished" until the next heat loads,
   * and a released lane must not re-hold).
   */
  const laneReleased =
    lane.racing?.pittedAtMs != null && lane.racing.pittedAtMs >= (lane.racing.finishedAtMs ?? 0);
  const clockSaysRacingFinished =
    liveClock?.state === "finished" &&
    lane.racing != null &&
    lane.racing.heatNumber != null &&
    liveHeatNumber(liveClock.heatName) === lane.racing.heatNumber;

  const rail = pitRailState({
    stagedInHolding: session?.inHolding ?? false,
    stagedStartedAtMs: stagedArmed ? null : (session?.startedAtMs ?? (stagedRacing ? 0 : null)),
    racingFinishedAtMs:
      lane.racing?.finishedAtMs ?? (clockSaysRacingFinished && !laneReleased ? nowMs : null),
    pittedAtMs: lane.racing?.pittedAtMs ?? null,
  });

  /**
   * THE ARRIVAL CALL (owner 2026-08-14): "when they first get sent to holding,
   * blink something to grab attention that says please find your name and stand
   * on the blue or red square corresponding to your number".
   *
   * Driven off the send stamp rather than a mounted timer, so both pit boards
   * agree and a board that reboots mid-window rejoins it — see
   * pitArrivalNoticeVisible for why it outlives the hold rail but not the green
   * flag.
   */
  const arrivalCall = pitArrivalNoticeVisible({
    holdingAtMs: lane.holding?.atMs ?? null,
    nowMs,
    rail,
  });

  // Which colour they are looking for on the floor. On a Mega day one circuit is
  // served by both sides, so the instruction has to name both or half the group
  // stands on the wrong squares.
  const squareColourWord = track === "mega" ? "BLUE or RED" : track === "red" ? "RED" : "BLUE";

  // The lap to beat — the group in the seats is looking at exactly this
  // screen. Same constants as the check-in board; null on Mega and Pro.
  const qualTarget = session?.raceType
    ? nextLevelTarget(TRACK_LABELS[track], session.raceType)
    : null;

  /**
   * WHERE EVERY SESSION IS, for the times this board has nothing to seat
   * (owner 2026-08-14: "when nothing is showing on pit assignment boards I'd
   * like to show where each session is. Like briefing 4 minutes remaining").
   *
   * The board is now deliberately blank more often than it used to be — it
   * waits for a staff press to show a heat, and it drops one the moment that
   * heat is racing. Blank is honest but it is not useful, and this screen faces
   * the people most affected by the answer: the group whose turn is coming.
   *
   * So the empty state becomes the flow itself. Every stage a heat passes
   * through, in order, with whoever is in it — and the briefing leg carries its
   * countdown, because "4 minutes" is the difference between waiting and
   * wandering off.
   *
   * All of it is already on this screen: the called record from the track
   * status it renders anyway, the rooms and lanes from the 2-second pulse. No
   * new read, and nothing here can disagree with the board above it.
   */
  const idleStages = useMemo(() => {
    const rooms = feed?.briefingRooms ?? null;
    const called = status?.currentRaces?.[track] ?? null;
    const out: Array<{ label: string; value: string; detail?: string }> = [];

    /**
     * A SESSION OCCUPIES EXACTLY ONE STAGE — the same rule the briefing API
     * enforces when Override places a session (see vacateSessionElsewhere).
     *
     * The called record is Pandora's, and Pandora keeps it for roughly twenty
     * minutes after the call — long after the group has been briefed, seated
     * and sent out. Rendered raw, that put one heat in two places at once:
     * owner 2026-08-14, live, "it's showing GF starter called, they're already
     * racing", with session 18 sitting in Called and Holding simultaneously.
     *
     * So a heat that has demonstrably moved on is not still "called". Matched
     * on the heat number because that is what every stage on this board
     * displays, and blanking is the honest answer — the next call will fill it.
     */
    const downstreamHeats = new Set<number>();
    for (const room of track === "mega" ? (["red", "blue"] as const) : ([track] as const)) {
      const h = rooms?.[room as "red" | "blue"]?.heatNumber;
      if (typeof h === "number") downstreamHeats.add(h);
    }
    if (typeof lane.holding?.heatNumber === "number") downstreamHeats.add(lane.holding.heatNumber);
    // In karts counts as moved on for exactly the same reason the other two do:
    // a group sitting in their karts is not still "called", and leaving it out
    // would put one heat in two rows the moment the pre-race cue plays.
    if (typeof lane.karts?.heatNumber === "number") downstreamHeats.add(lane.karts.heatNumber);
    if (typeof lane.racing?.heatNumber === "number") downstreamHeats.add(lane.racing.heatNumber);
    const calledMovedOn = called?.heatNumber != null && downstreamHeats.has(called.heatNumber);

    out.push({
      label: "Called",
      value: called?.heatNumber != null && !calledMovedOn ? `Session ${called.heatNumber}` : "—",
      detail: calledMovedOn ? undefined : (called?.raceType ?? undefined),
    });

    // On a Mega day one circuit is served by both rooms, so both are ours.
    const ourRooms: Array<"red" | "blue"> =
      track === "mega" ? ["red", "blue"] : track === "red" ? ["red"] : ["blue"];
    let briefingValue = "—";
    let briefingDetail: string | undefined;
    for (const room of ourRooms) {
      const state = rooms?.[room] ?? null;
      if (!state?.sessionId) continue;
      const t = briefingTimelineAt(state, feed?.now ?? Date.now());
      if (t.phase === "idle") continue;
      briefingValue = state.heatNumber != null ? `Session ${state.heatNumber}` : "In a room";
      briefingDetail =
        t.phase === "video" && t.nextInMs != null
          ? `${Math.max(1, Math.ceil(t.nextInMs / 60_000))} min of film left`
          : t.phase === "helmet"
            ? "helmets — ready to send"
            : "waiting to start";
      break;
    }
    out.push({ label: "Briefing", value: briefingValue, detail: briefingDetail });

    out.push({
      label: "Holding",
      value: lane.holding?.heatNumber != null ? `Session ${lane.holding.heatNumber}` : "—",
      detail: lane.holding ? "in the seats" : undefined,
    });

    // The stage between the seats and the green flag — filled when the pit
    // station plays the pre-race cue (pit/audio.server.ts). Skippable, so this
    // row reads "—" all evening on a night the PA never plays.
    out.push({
      label: "In karts",
      value: lane.karts?.heatNumber != null ? `Session ${lane.karts.heatNumber}` : "—",
      detail: lane.karts ? "seated — waiting on the green" : undefined,
    });

    const onTrackHeat =
      lane.racing?.heatNumber ?? (liveClock ? liveHeatNumber(liveClock.heatName) : null);
    out.push({
      label: "On track",
      value: onTrackHeat != null ? `Session ${onTrackHeat}` : "—",
      detail:
        lane.racing?.finishedAtMs != null
          ? "finished — karts coming in"
          : liveClock?.counting
            ? "racing"
            : undefined,
    });

    return out;
  }, [feed?.briefingRooms, feed?.now, status?.currentRaces, track, lane, liveClock]);

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
          {/* overflow:hidden is load-bearing. Everything inside is `nowrap`
              (see the note above), so without it a long race type does not
              shrink this block — it SPILLS out of it and runs underneath
              whatever sits to the right, which is how "Session 33 Intermediate"
              ended up printed through the FastTrax mark (owner 2026-08-14). */}
          {/* THE TYPE SITS UNDER THE NUMBER (owner 2026-08-14: "remove the pit
              assignment and move the session type under the session number").
              Side by side the two competed for one line and a long type ran out
              of the block — "Intermediate" was sliced mid-word. Stacked, the
              session number reads first at full size and the type reads second,
              and the freed width is what lets the pit board carry the mark. */}
          <div style={{ marginLeft: 44, minWidth: 0, overflow: "hidden" }}>
            {showSession ? (
              <>
                <div
                  className="tv-display"
                  style={{
                    fontSize: 80,
                    lineHeight: 0.98,
                    color: "#fff",
                    whiteSpace: "nowrap",
                    textShadow: `0 0 60px ${withAlpha(accent, 0.55)}`,
                  }}
                >
                  {showSession.heatNumber != null
                    ? `Session ${showSession.heatNumber}`
                    : "Next session"}
                </div>
                {showSession.raceType && (
                  <div
                    className="tv-display"
                    style={{
                      fontSize: 34,
                      marginTop: 2,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      color: "rgba(245,236,238,0.75)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {showSession.raceType}
                  </div>
                )}
              </>
            ) : (
              <div className="tv-display" style={{ fontSize: 64, color: "#fff", marginTop: 6 }}>
                No session staged
              </div>
            )}
          </div>
          {/*
            THE MARK, IN THE HEADER'S OWN GAP (owner 2026-08-14: "you just need
            to put logo in right spot").
            
            The first attempt hung it in the bottom-left corner from the scene
            director and landed it on top of the green "SEAT SESSION NOW" rail.
            The lesson is that this board has no free CORNERS — every one is
            doing a job — but it does have a flexible gap: the clock is pushed
            right by `marginLeft: auto`, and everything between the session title
            and that clock is empty by construction.
            
            Sitting IN THE FLOW there rather than absolutely positioned is what
            makes it safe: flexbox owns the spacing, so a longer race type or a
            three-digit session pushes the mark instead of colliding with it. It
            takes the auto margin and hands the clock a fixed gap of its own.
          */}
          <div
            style={{
              // Takes the header's slack, and keeps real air on BOTH sides: the
              // first pass had it shoulder to shoulder with the clock on one
              // side and the race type on the other, which reads as clutter
              // even when nothing actually overlaps.
              marginLeft: "auto",
              marginRight: 8,
              paddingLeft: 56,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              opacity: 0.9,
            }}
          >
            <TvBrandLogo venue="FT" height={46} />
          </div>
          {/* The one clock, and nothing else — the room-status chips that
              briefly lived here were not part of the approved mockup and the
              mockup is the target (owner 2026-08-13). */}
          <div style={{ marginLeft: 44, flexShrink: 0 }}>
            <LiveSessionChip track={track} accent={accent} />
          </div>
        </header>

        {/* Arrives with the group, ages out on its own. Full width and directly
            under the header because that is where someone walking in is already
            looking for their name. .tv-blink is the canvas's ONE attention beat —
            never give this its own rate, or the board flashes at two tempos. */}
        {arrivalCall && (
          <div
            className="tv-blink"
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 24,
              marginTop: 22,
              padding: "20px 28px",
              borderRadius: 14,
              background: withAlpha(accent, 0.18),
              border: `3px solid ${accent}`,
              boxShadow: `0 0 70px ${withAlpha(accent, 0.5)}`,
            }}
          >
            {/* A real square, not an icon and not an emoji: the thing they are
                looking for on the floor IS a coloured square. */}
            <span
              aria-hidden
              style={{
                width: 54,
                height: 54,
                flexShrink: 0,
                background: accent,
                borderRadius: 6,
                boxShadow: `0 0 34px ${withAlpha(accent, 0.9)}`,
              }}
            />
            <span className="tv-display" style={{ fontSize: 46, color: "#fff", lineHeight: 1.05 }}>
              Find your name, then stand on the {squareColourWord} square with your number
            </span>
          </div>
        )}

        {roster && roster.length > 0 && showSession ? (
          <SpotGrid roster={roster} accent={accent} sessionId={showSession.sessionId} />
        ) : showSession && roster === null ? (
          /* A group IS seated and we simply do not have their names yet — a
             different thing from an empty board, and it used to render as
             "Nothing to seat right now", which is a lie for the several seconds
             a cold roster takes. `null` is "not loaded"; an actual empty roster
             is `[]` and still falls through to Idle below (owner 2026-08-14:
             "while the screen waits for that roster show a fasttrax loading
             with spin"). */
          <PitLoading accent={accent} heatNumber={showSession.heatNumber} />
        ) : (
          <Idle accent={accent} hasSession={!!showSession} stages={idleStages} />
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
  /**
   * BIRTHDAYS AND VIPS GLOW (owner 2026-08-14: "make the bdays and VIPs stand
   * out more, maybe a glow around the picture box/name").
   *
   * They used to be a corner pill and, for a VIP only, a faint static halo — at
   * pit-fence distance neither read. The whole card now carries it: a coloured
   * border and a slow breathing glow, so a marshal picks the card out of a grid
   * of fourteen without reading a word.
   *
   * BOTH AT ONCE IS A REAL CASE and it is not a conflict — a VIP on their
   * birthday gets the gold border with both colours in the glow, rather than one
   * status silently hiding the other. The keyframe takes the two colours as
   * custom properties precisely so this needs no third variant (tv.css).
   */
  const glowA = r.birthday ? withAlpha(PINK, 0.85) : r.vip ? withAlpha(GOLD, 0.8) : null;
  const glowB = r.vip ? withAlpha(GOLD, 0.5) : r.birthday ? withAlpha(PINK, 0.45) : null;
  const flagged = r.vip || r.birthday;
  const border = r.vip
    ? `3px solid ${withAlpha(GOLD, 0.95)}`
    : r.birthday
      ? `3px solid ${withAlpha(PINK, 0.95)}`
      : "1px solid rgba(255,255,255,0.12)";
  // One step for the whole pill group, so Birthday, VIP and back-to-back can
  // never disagree about their own size on the same card.
  const pillSize = compact ? 17 : 20;
  const pillPad = compact ? "4px 11px" : "5px 16px";
  return (
    <div
      className={flagged ? "tv-card-glow" : undefined}
      style={
        {
          position: "relative",
          background: "rgba(7,16,39,0.55)",
          border,
          borderRadius: 28,
          // NOT hidden when the card glows: `overflow: hidden` clips a box-shadow
          // drawn outside the border box, which would swallow the whole effect.
          overflow: flagged ? "visible" : "hidden",
          display: "flex",
          flexDirection: "column",
          ...(glowA ? { "--tv-glow-a": glowA } : {}),
          ...(glowB ? { "--tv-glow-b": glowB } : {}),
        } as CSSProperties
      }
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
        {/*
          THE PILL GROUP IS A STACK, NOT A ROW (owner 2026-08-14). Back-to-back
          joins Birthday and VIP here rather than taking a place of its own,
          because all three answer the same question — what does staff need to
          know about THIS racer that the photo cannot say. Side by side, three
          pills on a 14-card grid reach past the spot number; stacked and
          right-aligned they grow downward into the photo, where there is room.

          AND THEY STEP DOWN ON A CROWDED GRID, which they did not do before:
          Birthday and VIP were fixed at 20px whatever the card size, which is
          exactly what made a third pill impossible on a GF heat.
        */}
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 12,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 8,
          }}
        >
          {r.birthday && (
            <span
              className="tv-display tv-bday-glow"
              style={{
                fontSize: pillSize,
                color: "#fff",
                padding: pillPad,
                borderRadius: 999,
                whiteSpace: "nowrap",
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
                fontSize: pillSize,
                color: GOLD,
                padding: pillPad,
                borderRadius: 999,
                whiteSpace: "nowrap",
                border: `2px solid ${withAlpha(GOLD, 0.8)}`,
                background: "rgba(0,4,24,0.7)",
              }}
            >
              VIP
            </span>
          )}
          {/*
            ON TRACK NOW IS SOLID WHITE, DELIBERATELY NOT THE TRACK ACCENT. Red
            already means "not checked in" on this card — it is the no-show ring
            — so a red pill on a Red board would fight the one colour that has to
            stay unambiguous. White is the only value on this palette nothing
            else claims, and it is the loudest, which suits the pill that says
            "this empty card is expected, do not go looking for them".

            RACES AGAIN keeps amber, the same "something still to do" family as
            Cam needed; the two never collide — one is a pill up here, the other
            a chip in the footer.
          */}
          {r.backToBack?.state === "arriving" && (
            <span
              className="tv-display"
              style={{
                fontSize: pillSize,
                color: "#04101f",
                padding: pillPad,
                borderRadius: 999,
                whiteSpace: "nowrap",
                border: "2px solid #ffffff",
                background: "#ffffff",
              }}
            >
              On track now
            </span>
          )}
          {r.backToBack?.state === "again" && (
            <span
              className="tv-display"
              style={{
                fontSize: pillSize,
                color: AMBER,
                padding: pillPad,
                borderRadius: 999,
                whiteSpace: "nowrap",
                border: `2px solid ${withAlpha(AMBER, 0.9)}`,
                background: withAlpha(AMBER, 0.16),
              }}
            >
              Races again
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

/**
 * "We know who is racing, we are fetching their names."
 *
 * The mark plus a slow ring, centred — recognisable from the pit fence as the
 * board working rather than the board broken. It should be rare now that the
 * roster is pre-warmed during helmeting (pit/fast-roster.server.ts); this is
 * what a cold start, a redeploy or a Pandora hiccup looks like.
 */
function PitLoading({ accent, heatNumber }: { accent: string; heatNumber: number | null }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 34,
      }}
    >
      <div style={{ position: "relative", width: 190, height: 190 }}>
        <div
          className="tv-spin"
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `6px solid ${withAlpha(accent, 0.18)}`,
            borderTopColor: accent,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 34,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <TvBrandLogo venue="FT" height={72} />
        </div>
      </div>
      <div className="tv-display" style={{ fontSize: 46, color: "#fff", lineHeight: 1.05 }}>
        {heatNumber != null ? `Loading session ${heatNumber}…` : "Loading the grid…"}
      </div>
    </div>
  );
}

function Idle({
  accent,
  hasSession,
  stages,
}: {
  accent: string;
  hasSession: boolean;
  stages: Array<{ label: string; value: string; detail?: string }>;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 28,
      }}
    >
      {!hasSession && (
        <>
          <div className="tv-display" style={{ fontSize: 72, color: "#fff", lineHeight: 0.95 }}>
            Nothing to seat right now
          </div>
          {/* THE FLOW, IN ORDER. A guest reading this wants one thing — how far
              away is my turn — and the order of the rows answers it without a
              word of explanation. */}
          <div style={{ display: "grid", gap: 14 }}>
            {stages.map((st) => {
              const empty = st.value === "—";
              return (
                <div
                  key={st.label}
                  style={{ display: "flex", alignItems: "baseline", gap: 28, flexWrap: "wrap" }}
                >
                  <span
                    className="tv-display"
                    style={{
                      minWidth: 260,
                      fontSize: 34,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: withAlpha("#f5ecee", 0.5),
                    }}
                  >
                    {st.label}
                  </span>
                  <span
                    className="tv-display"
                    style={{
                      fontSize: 46,
                      color: empty ? withAlpha("#f5ecee", 0.28) : "#fff",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {st.value}
                  </span>
                  {st.detail && (
                    <span
                      className="tv-display"
                      style={{ fontSize: 30, color: accent, whiteSpace: "nowrap" }}
                    >
                      {st.detail}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
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
    /** When the group's pre-race PA cue played — the rail's small indicator
     *  (owner 2026-08-14: "add some small indicator on our assignment board
     *  if prerace has been completed"). */
    preRaceAtMs: number | null;
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
        <PreRacePill session={session} />
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
      <PreRacePill session={session} />
      <QualPill qual={qual} accent={accent} />
    </div>
  );
}

/**
 * The pre-race PA cue's small indicator (owner 2026-08-14). Green tick once
 * the cue has played; amber "due" only while the group is actually in the
 * seats with the cue owed — a group still briefing has nothing due yet, and
 * an indicator that ambers early is an indicator staff learn to ignore.
 */
function PreRacePill({
  session,
}: {
  session: { inHolding: boolean; preRaceAtMs: number | null } | null;
}) {
  if (!session) return null;
  const played = session.preRaceAtMs != null;
  if (!played && !session.inHolding) return null;
  const color = played ? OK : AMBER;
  return (
    <span
      className="tv-display"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 20px",
        borderRadius: 999,
        border: `2px solid ${withAlpha(color, 0.7)}`,
        background: withAlpha(color, 0.12),
        color,
        fontSize: 24,
        whiteSpace: "nowrap",
      }}
    >
      {played ? "Pre-race ✓" : "Pre-race due"}
    </span>
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
