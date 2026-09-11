/**
 * THE TRACK OPS LIST — who is on the floor, what state they are in, and in what
 * order. PURE, and the ONLY place any of those three questions is answered
 * (owner 2026-09-07: "exactly one place for each concern").
 *
 * The same list is drawn on the check-in board's strip and in the TRACK OPS row
 * of every session-status panel. Two surfaces, one fold: if the strip and the
 * wall could each decide who belongs, they would eventually disagree in front
 * of the same staff member.
 *
 * ── WHO IS ON IT ────────────────────────────────────────────────────────────
 *
 * The portal pit board's current holders of Track Ops and Track Ops Floaters,
 * PLUS anyone our own floor says is hosting a group. Nobody else — not even
 * somebody who briefed nine groups this afternoon and has since moved to the
 * front desk. The list answers "who can I send to the next group", which is a
 * question about right now, and the old all-briefers strip answered it wrongly
 * and grew all evening.
 *
 * A PERSON WHO HAS CLOCKED OUT DROPS OFF, unless they are still hosting: `out`
 * with a punch today means they have gone home. `out` with NO punch today is a
 * different fact — they are rostered and have not arrived — so they stay,
 * greyed, at the bottom, where they read as a gap in the crew rather than a
 * person you could call on.
 *
 * Their briefings still count in the night's totals. The totals are about the
 * DAY; the list is about the floor.
 *
 * ── THE ORDER IS A QUEUE, NOT A LEADERBOARD (owner 2026-09-10) ──────────────
 *
 * Within a state, the person who has been FREE LONGEST comes first. It used to
 * be whoever had briefed the most, which answered "who is carrying tonight" —
 * a recognition question — while the desk was reading the strip to answer "who
 * do I send next", which is a fairness one. On 09-09 the two came apart badly:
 * one marshal ran 17 groups and another ran 2, and the strip put the person
 * with 17 at the front all evening.
 *
 * FREE SINCE = WHEN THEIR KARTS CAME BACK, not when they left with the group —
 * the `pitted` stamp, threaded in by countBriefingsByStaff. See that function
 * for why the distinction is worth ~19 minutes on the pill.
 *
 * NO STAMP SORTS FIRST. Somebody who has not taken a group tonight has been
 * waiting the whole shift; somebody whose "Race returned" press was missed
 * cannot be distinguished from them, and both should be offered a group rather
 * than skipped. The pill shows no clock in either case — a counter with no
 * start time would have to invent one.
 *
 * `briefed` NO LONGER DECIDES ANYTHING. It is still counted and still printed,
 * and the top-briefer mark still finds the highest: the count says who is
 * carrying the night, the POSITION says who is owed the next group. Two facts,
 * two marks, neither pretending to be the other.
 *
 * ── THE FOUR STATES ─────────────────────────────────────────────────────────
 *
 *   available  clocked in, hosting nothing   green ring + dot, sorted FIRST
 *   assigned   hosting a group                normal pill + the race tag
 *   break      the portal says break          greyed, orange dot, tag kept
 *   not-in     rostered, no punch today       greyed hardest, sorted LAST
 *
 * BREAK OUTRANKS ASSIGNED, deliberately. Somebody on their break who still
 * holds a group is not available to be sent anywhere, and the tag stays so the
 * desk can see whose group needs covering.
 *
 * PRESENCE IS THE PORTAL'S WORD. We never infer it from our own race map — a
 * pill that contradicted the pit board about whether somebody is clocked in
 * would make both boards untrustworthy.
 */
import { TRACK_TAG } from "~/lib/constants/crew";
import type { TrackKey } from "../signage/track";
import type { StaffRace } from "./current-races-fold";
import type { CrewPresence, TrackOpsHolder } from "./portal-roster";

export type CrewState = "available" | "assigned" | "break" | "not-in";

/** Sort order of the states — the reading order of the strip. */
const STATE_RANK: Record<CrewState, number> = {
  available: 0,
  assigned: 1,
  break: 2,
  "not-in": 3,
};

/** Track letter for the race tag: B34, R33, M12. */
export const TRACK_LETTER: Record<TrackKey, "B" | "R" | "M"> = {
  blue: "B",
  red: "R",
  mega: "M",
};

/** The tag as it is printed. Letter alone when the heat has no number — a
 *  group event or a custom race is still somewhere, and "B" beats nothing. */
export function raceTagLabel(race: { track: TrackKey; heatNumber: number | null }): string {
  return `${TRACK_LETTER[race.track]}${race.heatNumber ?? ""}`;
}

/** The tag's colours, from the one palette. */
export function raceTagColors(race: { track: TrackKey }): {
  ink: string;
  bg: string;
  border: string;
} {
  return TRACK_TAG[race.track];
}

export interface CrewEntry {
  userId: number;
  firstName: string;
  /** Groups briefed today. Zero is printed, not hidden — "flag 0" beside a
   *  green ring is the shape of somebody who has been free all evening. */
  briefed: number;
  /** The group they are running, or null. Null IS the free signal. */
  race: { track: TrackKey; heatNumber: number | null } | null;
  /**
   * When their last group's karts came back — the sort key, and the clock the
   * desk reads. Null = no group tonight, or a missed "Race returned" press;
   * both sort to the front and both print no clock. See the header.
   */
  freeSinceMs: number | null;
  state: CrewState;
  /** The highest count on the list, marked exactly once and never at zero.
   *  Decided here so the two surfaces cannot each pick their own top briefer. */
  top: boolean;
}

export interface CrewBoard {
  list: CrewEntry[];
  /** Groups nobody claimed at the tablet — reported, never folded into a person. */
  unattributed: number;
  /** Distinct groups briefed today, across everybody. */
  groups: number;
  /** How many people briefed at least one, across everybody — including people
   *  who have since gone home and are not on `list`. */
  briefers: number;
  /** False when the portal could not be reached and no recent answer survived.
   *  The surfaces then show the race hosts alone plus a dim note, so a short
   *  list is never mistaken for a quiet floor. */
  rosterAvailable: boolean;
}

/** What the counts query hands over, per staff member. */
export interface BriefedCount {
  userId: number;
  firstName: string | null;
  briefed: number;
  /** Epoch ms of their last `pitted` stamp. Null when there is none. */
  freeSinceMs: number | null;
}

export interface CrewInput {
  briefedByStaff: readonly BriefedCount[];
  currentRaces: readonly StaffRace[];
  /** `null` = the portal could not be reached. NOT the same as an empty roster:
   *  one means "we don't know", the other means "nobody is on". */
  onShiftTrackOps: readonly TrackOpsHolder[] | null;
  unattributed: number;
}

/**
 * The state one person is in. Exported and tested on its own because it is the
 * whole visual vocabulary of the feature in five lines.
 *
 * `presence` is null for somebody who is hosting but is not on the portal's
 * Track Ops list at all — a pit boss or a manager who has picked up a group.
 * They are assigned; nothing else about them is knowable from here.
 */
export function crewState(entry: {
  presence: CrewPresence | null;
  hasPunchedToday: boolean;
  hosting: boolean;
}): CrewState {
  // Break first: a break is not availability, whatever else is true.
  if (entry.presence === "break") return "break";
  if (entry.hosting) return "assigned";
  if (entry.presence === "in") return "available";
  // `out` with a punch is handled by the membership rule and never reaches
  // here unless they are hosting (caught above). What is left is "rostered,
  // hasn't arrived".
  return "not-in";
}

/**
 * Has this person gone home? The membership rule, in one place.
 *
 * Hosting always wins — somebody whose punch is out but who is still walking a
 * group to the karts is on the floor, whatever the clock says.
 */
function hasGoneHome(holder: TrackOpsHolder, hosting: boolean): boolean {
  return !hosting && holder.presence === "out" && holder.hasPunchedToday;
}

/**
 * The sort position of one person's idle clock. Older (smaller) comes first.
 *
 * ZERO FOR "NO STAMP", NOT `-Infinity`. Epoch 0 is 1970, which is older than
 * anything a race night can produce, so it lands them at the front exactly as
 * intended — and unlike `-Infinity` it can be subtracted from itself. Two
 * people with no stamp would otherwise compare `-Infinity - -Infinity`, which
 * is `NaN`: not a wrong order but an INCONSISTENT one, so the two surfaces
 * would disagree and each poll could reshuffle the strip under the desk's
 * hand. The `|| name` tie-break only runs because this returns 0.
 */
function freeSinceRank(entry: CrewEntry): number {
  return entry.freeSinceMs ?? 0;
}

/**
 * How long they have been standing there, as the pill prints it — `38m`,
 * `1h 12m`, `2h`. Null when there is no stamp to count from, which is the
 * pill's signal to draw no clock at all.
 *
 * THE CLOCK IS HANDED IN, never read here. This whole module is arithmetic
 * over what the caller passes, which is what makes every rule in it testable
 * without waiting for a race night — and on the walls `nowMs` is the
 * director's venue-corrected clock rather than the player's own.
 *
 * A NEGATIVE READS AS `0m`. Clock skew between Neon and a screen is small but
 * it is not zero, and "-1m since their last group" is the kind of thing that
 * makes staff stop believing the rest of the board.
 */
export function formatIdle(freeSinceMs: number | null, nowMs: number): string | null {
  if (freeSinceMs == null) return null;
  const minutes = Math.max(0, Math.floor((nowMs - freeSinceMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * WHO IS NEXT, AND WHO IS BEHIND THEM (owner 2026-09-10: "so the check in team
 * knows who is next").
 *
 * The list is already in queue order, so this is a filter rather than a second
 * opinion — and it lives here, beside the sort, precisely so it can never
 * BECOME a second opinion. A component that picked its own "next" would
 * eventually disagree with the pill sitting first in the row above it.
 *
 * AVAILABLE ONLY. Somebody out on a group, on a break, or not yet clocked in
 * is not somebody the desk can send, so naming them as "next" would be worse
 * than naming nobody. That makes this exactly the set of pills that wear a
 * clock — which is what lets the two read as one thing.
 */
export function nextUp(list: readonly CrewEntry[]): {
  next: CrewEntry | null;
  queued: CrewEntry[];
} {
  const free = list.filter((e) => e.state === "available");
  return { next: free[0] ?? null, queued: free.slice(1) };
}

export function buildCrewList(input: CrewInput): CrewEntry[] {
  const raceByUser = new Map<number, StaffRace>();
  for (const r of input.currentRaces) raceByUser.set(r.userId, r);

  const briefedByUser = new Map<number, BriefedCount>();
  for (const b of input.briefedByStaff) briefedByUser.set(b.userId, b);

  const rosterByUser = new Map<number, TrackOpsHolder>();
  for (const h of input.onShiftTrackOps ?? []) rosterByUser.set(h.userId, h);

  /** The union: the roster (minus whoever has gone home) plus every host. */
  const userIds = new Set<number>(raceByUser.keys());
  for (const [userId, holder] of rosterByUser) {
    if (hasGoneHome(holder, raceByUser.has(userId))) continue;
    userIds.add(userId);
  }

  const list: CrewEntry[] = [];
  for (const userId of userIds) {
    const race = raceByUser.get(userId) ?? null;
    const holder = rosterByUser.get(userId) ?? null;
    /**
     * NAME PREFERENCE. The briefing row's name was denormalised at the send and
     * is what every other briefing surface already prints; the host claim is
     * the same name from the same press; the roster's is the portal's. A person
     * with none of the three is dropped — an unnamed pill is unreadable, and
     * there is nothing useful to put in its place.
     */
    const firstName =
      briefedByUser.get(userId)?.firstName ?? race?.firstName ?? holder?.firstName ?? null;
    if (!firstName) continue;
    list.push({
      userId,
      firstName,
      briefed: briefedByUser.get(userId)?.briefed ?? 0,
      race: race ? { track: race.track, heatNumber: race.heatNumber } : null,
      freeSinceMs: briefedByUser.get(userId)?.freeSinceMs ?? null,
      state: crewState({
        presence: holder?.presence ?? null,
        hasPunchedToday: holder?.hasPunchedToday ?? false,
        hosting: race != null,
      }),
      top: false,
    });
  }

  // State, then who has been free longest, then name so the order is identical
  // between two polls a second apart.
  list.sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      freeSinceRank(a) - freeSinceRank(b) ||
      a.firstName.localeCompare(b.firstName),
  );

  const topCount = list.reduce((max, e) => Math.max(max, e.briefed), 0);
  if (topCount > 0) {
    const top = list.find((e) => e.briefed === topCount);
    if (top) top.top = true;
  }
  return list;
}

/**
 * The list plus the night's totals — what both surfaces are handed.
 *
 * THE TOTALS COUNT THE DAY, NOT THE LIST. Somebody who briefed four groups and
 * went home at six is off the list and still in the totals, which is why
 * "45 groups · 7 briefers" can name more people than the strip shows.
 */
export function buildCrewBoard(input: CrewInput): CrewBoard {
  return {
    list: buildCrewList(input),
    unattributed: input.unattributed,
    groups: input.briefedByStaff.reduce((n, b) => n + b.briefed, 0) + input.unattributed,
    briefers: input.briefedByStaff.filter((b) => b.briefed > 0).length,
    rosterAvailable: input.onShiftTrackOps != null,
  };
}
