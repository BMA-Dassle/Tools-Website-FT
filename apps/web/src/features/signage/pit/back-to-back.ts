/**
 * BACK-TO-BACK RACERS. PURE — no I/O, no clock, no network.
 *
 * A racer is back-to-back when their visit does not stop at this heat. Two
 * shapes of that, and staff need them for opposite reasons:
 *
 *   arriving  they are out on track RIGHT NOW in an earlier heat and are staged
 *             on this grid. They will never appear at check-in, so their empty
 *             card and no-show ring are expected — the pit board reads them as
 *             a no-show today and staff go looking for somebody who is fifty
 *             feet away in a kart.
 *
 *   again     they race again within the next two heats. When this race ends
 *             they go back to the holding seats rather than out through
 *             check-in, and nobody currently tells them or the staff member
 *             seating the next grid.
 *
 * ARRIVING WINS when a racer is both. It changes what staff do *now*; `again`
 * changes what they say when the race ends.
 *
 * ─── THE ORDERING RULE ───────────────────────────────────────────────────
 *
 * `tasks/lessons.md` (2026-07-11): Pandora's `heatNumber` is CREATION order,
 * not schedule order. A single staff-inserted session takes the day-max heat
 * number, and reasoning "later heat = bigger number" once flipped every unrun
 * Blue heat to finished and nearly settled bills hours early.
 *
 * So nothing here compares heat numbers. "The next two" is decided by
 * `pickNextTwoHeats` (lib/checkin-race-flags.ts), which sorts strictly on
 * `scheduledStart` and is already unit-tested — reused rather than reimplemented
 * so the two places that answer this question can never drift apart.
 */
import { pickNextTwoHeats, type HeatCandidate } from "@/lib/checkin-race-flags";

export type BackToBackState = "arriving" | "again";

/** Where a back-to-back racer is going, and why they are flagged. */
export interface BackToBackTarget {
  state: BackToBackState;
  /** The heat they are joining — null only when the session carries no number. */
  session: number | null;
  /** "blue" | "red" | "mega", lower case as the track keys are. */
  track: string;
}

/** A session as this module needs it: the timing system's schedule row plus the
 *  track it belongs to, which `TrackSession` does not carry (the caller knows it
 *  from which list it read). */
export interface B2BSession {
  sessionId: string;
  track: string;
  heatNumber: number | null;
  scheduledStart: string;
  actualStart?: string | null;
  actualEnd?: string | null;
}

/** One candidate session with the people on it. */
export interface B2BRoster {
  session: B2BSession;
  /** personIds as STRINGS — BMI ids exceed Number.MAX_SAFE_INTEGER. */
  members: string[];
}

/**
 * The races under way right now: started and not yet ended.
 *
 * NOT "the previous heat" — on a Mega day, or when the two tracks are offset,
 * the race a returning group is coming off may be on the other track entirely
 * (owner: any track counts). And not "the highest heat number below ours",
 * which is the trap the ordering rule above exists to prevent.
 *
 * The staged session is excluded: a heat cannot be arriving at itself, and
 * during the two-phase start it can briefly be both staged and stamped.
 */
export function racesRunningNow(sessions: B2BSession[], stagedSessionId: string): B2BSession[] {
  return sessions.filter((s) => s.sessionId !== stagedSessionId && !!s.actualStart && !s.actualEnd);
}

/**
 * The next two heats after the staged one, across every track.
 *
 * Delegates to the tested `pickNextTwoHeats`. The mapping to `HeatCandidate` is
 * lossless for its purposes — it reads only `sessionId` and `scheduledStart`.
 */
export function nextTwoAfter(
  sessions: B2BSession[],
  stagedSessionId: string,
  stagedScheduledStart: string,
): B2BSession[] {
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
  const candidates: HeatCandidate[] = sessions.map((s) => ({
    sessionId: s.sessionId,
    track: s.track,
    raceType: null,
    heatNumber: s.heatNumber,
    scheduledStart: s.scheduledStart,
  }));
  return pickNextTwoHeats(candidates, stagedSessionId, stagedScheduledStart)
    .map((c) => bySession.get(c.sessionId))
    .filter((s): s is B2BSession => !!s);
}

/**
 * Who on this grid is back-to-back, and where they are going.
 *
 * Keyed by personId. A racer on none of the candidate rosters is simply absent
 * from the map, so a caller can treat "in the map" as "flagged".
 *
 * `arriving` is applied last-write-wins over `again` on purpose — see the header.
 */
export function backToBackMap(args: {
  personIds: string[];
  arriving: B2BRoster[];
  again: B2BRoster[];
}): Map<string, BackToBackTarget> {
  const wanted = new Set(args.personIds.filter(Boolean));
  const out = new Map<string, BackToBackTarget>();
  if (wanted.size === 0) return out;

  const apply = (rosters: B2BRoster[], state: BackToBackState, overwrite: boolean) => {
    for (const { session, members } of rosters) {
      for (const id of members) {
        if (!wanted.has(id)) continue;
        if (!overwrite && out.has(id)) continue;
        out.set(id, { state, session: session.heatNumber, track: session.track });
      }
    }
  };

  // `again` first, then `arriving` over the top: arriving is the more urgent
  // fact and must win for a racer who is both.
  apply(args.again, "again", false);
  apply(args.arriving, "arriving", true);
  return out;
}

/**
 * The `again` half, grouped by the heat they are JOINING — the shape both
 * guest-facing and staff-facing boards render.
 *
 * ONE RETURNING RACE, N DESTINATIONS (owner 2026-08-14: "we should only have one
 * returning race technically, then this should indicate what session they're
 * joining"). Only one group ever walks back into a briefing room, but its racers
 * can scatter across several later heats on different tracks — so the rows are
 * destinations, never returning heats, and each names its own track.
 *
 * Ordered by heat number for a stable read; ties and nulls keep insertion order.
 */
export interface JoiningGroup {
  session: number | null;
  track: string;
  names: string[];
}

export function groupJoining(
  entries: Array<{ name: string; target: BackToBackTarget }>,
): JoiningGroup[] {
  const groups = new Map<string, JoiningGroup>();
  for (const { name, target } of entries) {
    if (target.state !== "again") continue;
    const key = `${target.session ?? "?"}|${target.track}`;
    const existing = groups.get(key);
    if (existing) existing.names.push(name);
    else groups.set(key, { session: target.session, track: target.track, names: [name] });
  }
  return [...groups.values()].sort((a, b) => (a.session ?? 0) - (b.session ?? 0));
}
