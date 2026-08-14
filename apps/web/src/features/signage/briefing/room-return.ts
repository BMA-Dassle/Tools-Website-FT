/**
 * IS THIS ROOM ACTUALLY FREE? PURE — numbers in, one state out.
 *
 * THE BUG THIS EXISTS FOR (owner 2026-08-12: "Free might not be right word here…
 * need to warn that race is returning in X time based on the on track timer. It
 * can say free about 1 minute after race has finished").
 *
 * The briefing timeline ends at video + 30s of helmet sizes, and the room's Redis
 * state outlives it by one minute (phase.ts / briefingStateTtlSeconds). So about a
 * minute after the helmet board, the room falls to `idle` and the desk board
 * printed FREE — while that group was strapped into karts, mid-race, and due to
 * walk straight back into that same room to return helmets and cameras
 * (welcome-back.ts). The room was the opposite of free: it was spoken for by
 * people who had not left yet.
 *
 * WHAT MAKES THIS ANSWERABLE is that every fact needed already exists on the desk:
 *
 *   WHO went out from this room   `briefing_assignments`, newest-first, the
 *                                 durable send record (assignments-db)
 *   WHETHER they have finished    the venue's own RaceFinish stamp, a Redis
 *                                 marker written seconds after the flag
 *                                 (race-finish.server.ts) — the same fast path
 *                                 the welcome-back board reads
 *   HOW LONG until they do         the live on-track clock the board already
 *                                 renders in its identity row (live-session.tsx)
 *
 * So nothing here guesses and nothing new is fetched. This module only decides
 * WHICH of those facts the badge should be speaking about.
 *
 * TWO RULES IT MUST NOT BREAK:
 *
 *  1. NEVER CLAIM IN BOTH ROOMS WHAT CAN ONLY BE TRUE OF ONE. On a Mega day both
 *     rooms serve one circuit, so one live clock would otherwise have both rooms
 *     announcing the same returning race — the exact bug that killed the "next up"
 *     board (types.ts, owner 2026-08-11). Hence the heat-number match, and hence
 *     Mega + an unidentifiable heat name reports FREE rather than a coin flip.
 *  2. A STALE SEND ROW MUST NOT HOLD A ROOM ALL EVENING. Every "not free" answer
 *     is bounded — by the group's own end stamp, by a later heat being on track,
 *     or failing both by GROUP_OUT_WINDOW_MS. A board that cries "returning" at
 *     11pm about a 4pm race would teach staff to ignore it.
 */

/** How long after a send this room can still be considered spoken for.
 *
 *  Generous, because it is the LAST-resort bound: film (~5m) + helmets (30s) +
 *  the walk + a wait on the grid + a 14-minute heat + the walk back is a real
 *  40 minutes on a night when the track is running behind. The bounds that
 *  normally end a claim are the end stamp and the later-heat rule below; this one
 *  only catches the case where the bridge never delivered a finish AND no further
 *  heat ran on that track. */
export const GROUP_OUT_WINDOW_MS = 45 * 60_000;

/**
 * How long "they are walking back" holds after the flag, before the room is free.
 *
 * The owner's number, verbatim: "it can say free about 1 minute after race has
 * finished." Note this deliberately does NOT match the room's TV, which keeps the
 * welcome-back board up until the next send (welcome-back.ts — no time ceiling).
 * Different questions: the wall is talking to the group in the room, the desk is
 * answering "can I send the next group here", and a minute after the flag the
 * answer to that is yes.
 */
export const RETURN_GRACE_MS = 60_000;

/** The room's last group out, as the board receives it from the service. */
export interface GroupOut {
  sessionId: string;
  heatNumber: number | null;
  /** When the group was sent to the room, ms. */
  sentAtMs: number;
  /** The venue's own end stamp, ms. Null while the race has not finished — or
   *  while the timing bridge is down and never told us it did. */
  endedAtMs: number | null;
}

/** The live on-track clock for this room's track, or null when no heat is running. */
export interface LiveHeat {
  /** Parsed from the heat's name — null for a group event or a custom race. */
  heatNumber: number | null;
  remainingMs: number;
}

export type RoomReturnState =
  /** Nothing out that this room is waiting on. */
  | { kind: "free" }
  /** Briefed and gone, but their heat is not running yet — on the grid. */
  | { kind: "on-grid"; heatNumber: number | null }
  /** Racing now. `remainingMs` is the on-track clock — what the badge counts down. */
  | { kind: "racing"; heatNumber: number | null; remainingMs: number }
  /** Flag has dropped and they are walking back with the kit. */
  | { kind: "returning"; heatNumber: number | null; sinceEndMs: number };

const FREE: RoomReturnState = { kind: "free" };

export interface RoomReturnInput {
  /** This room's last group briefed today, or null if it has briefed nobody. */
  group: GroupOut | null;
  liveHeat: LiveHeat | null;
  /** Mega day — one circuit, two rooms. See rule 1 in the header. */
  megaDay: boolean;
  nowMs: number;
}

/**
 * What the room's idle badge is really looking at.
 *
 * ONLY MEANINGFUL WHILE THE ROOM IS IDLE. A room playing a film or holding a
 * take-a-seat board is occupied by the group in front of it, and that always
 * outranks a group who has left — the caller checks the phase first.
 */
export function roomReturnStateAt(input: RoomReturnInput): RoomReturnState {
  const { group, liveHeat, megaDay, nowMs } = input;
  if (!group) return FREE;
  if (!Number.isFinite(group.sentAtMs)) return FREE;
  // Rule 2's backstop. Checked before anything else so an ancient row cannot
  // reach the clock comparisons at all.
  if (nowMs - group.sentAtMs > GROUP_OUT_WINDOW_MS) return FREE;

  // FINISHED AS A MATTER OF RECORD. The venue stamped the end, so no clock and no
  // inference gets a vote: they are either walking back, or long back.
  if (group.endedAtMs != null && Number.isFinite(group.endedAtMs)) {
    const sinceEndMs = nowMs - group.endedAtMs;
    // A stamp in the future (clock skew between the venue server and us) is
    // treated as "just now" — the group is certainly not back yet.
    if (sinceEndMs < RETURN_GRACE_MS) {
      return {
        kind: "returning",
        heatNumber: group.heatNumber,
        sinceEndMs: Math.max(0, sinceEndMs),
      };
    }
    return FREE;
  }

  // NO END STAMP. Nothing is running on their track, so they are between the room
  // and the green flag.
  if (!liveHeat) return { kind: "on-grid", heatNumber: group.heatNumber };

  // A heat is running but neither side can be named — a group event, a custom
  // race, or a send row with no heat number. On a Mega day that is unattributable
  // and BOTH rooms would claim it (rule 1), so say nothing. On a Red/Blue day the
  // room's own track is running and this room's latest group is who went out to
  // it, which is as identified as this ever needs to be.
  if (liveHeat.heatNumber == null || group.heatNumber == null) {
    return megaDay
      ? FREE
      : {
          kind: "racing",
          heatNumber: group.heatNumber,
          remainingMs: Math.max(0, liveHeat.remainingMs),
        };
  }

  if (liveHeat.heatNumber === group.heatNumber) {
    return {
      kind: "racing",
      heatNumber: group.heatNumber,
      remainingMs: Math.max(0, liveHeat.remainingMs),
    };
  }

  // HEAT NUMBERS ONLY GO UP through a day, which makes the mismatch informative
  // rather than merely "not ours":
  //   an EARLIER heat still on track ⇒ ours has not gone green yet
  //   a LATER heat on track          ⇒ ours finished, and we simply never got the
  //                                    end stamp (a bridge outage — 2.5h of one on
  //                                    8/11). This is the rule that keeps a dead
  //                                    bridge from freezing a room on "returning".
  return liveHeat.heatNumber < group.heatNumber
    ? { kind: "on-grid", heatNumber: group.heatNumber }
    : FREE;
}

/**
 * Heat number out of a live clock's heat name.
 *
 * THREE SHAPES, and the third is the one the venue actually sends most of the
 * time. The timing cloud socket sends `"[HEAT] 66 - Mega Pro"`, which
 * useLiveSessionClock humanises to `"Heat 66 - Mega Pro"` — so a `[HEAT]`-only
 * regex (results-frame.ts parseHeatNumber, which reads raw frames) matches
 * nothing here. But the venue broadcast's own `Name` carries NO "heat" word at
 * all: `"60 - Blue Intermediate"`, `"66 - Mega Pro"`, `"43 - Blue Starter"` —
 * verified against live finish markers and the kart-events survey.
 *
 * That gap was silent and expensive. Anything matching on heat number simply
 * never matched: the desk's Holding box could not tell that its group had taken
 * the green flag, so a heat sat in the seats through its own race (owner
 * 2026-08-14: "I started blue 61 and it didn't move it from holding to on
 * track"), and the room-return countdown fell through to its no-clock branch.
 *
 * So: the explicit forms first, then a LEADING number, which is the venue's own
 * convention and unambiguous — a name that starts with digits starts with its
 * heat number.
 *
 * Null for anything unnumbered — group events and custom races carry arbitrary
 * names, and an unidentified heat must fail the match rather than force one. In
 * particular a number that is not at the front and not after "heat" is NOT a
 * heat number: "Corporate Event 2024" must stay null.
 */
export function liveHeatNumber(heatName: string | null | undefined): number | null {
  if (!heatName) return null;
  const labelled = /(?:\[HEAT\]|HEAT)\s*#?\s*(\d+)/i.exec(heatName);
  if (labelled) return Number(labelled[1]);
  const leading = /^\s*#?\s*(\d+)\b/.exec(heatName);
  return leading ? Number(leading[1]) : null;
}
