/**
 * WHERE EVERY SESSION ON A TRACK IS, in order. PURE — facts in, six rows out.
 *
 * This started life inside ScenePitBoard as the empty-state of the pit
 * assignment wall (owner 2026-08-14: "when nothing is showing on pit assignment
 * boards I'd like to show where each session is. Like briefing 4 minutes
 * remaining"). It is lifted out here because a SECOND surface now asks the same
 * question: the in-room briefing tablet, whose staff member has to decide
 * whether to fetch the next group and cannot see the pit from where they stand
 * (owner 2026-08-16: "on the side of the tablet can we also show where each
 * group is for that track… sort of like the nothing to seat screens").
 *
 * ONE BUILDER, TWO SURFACES, and that is the point rather than tidiness: the
 * wall in front of the racers and the tablet in the staff member's hand must not
 * be able to describe the same night differently. A racer looking at "Session 61
 * — briefing" while the room says something else is a racer who trusts neither.
 *
 * THE RULES THAT LIVE HERE, none of them obvious, all of them paid for:
 *
 *  • A SESSION OCCUPIES EXACTLY ONE STAGE. Pandora keeps its called record for
 *    roughly twenty minutes after the call — long after the group has been
 *    briefed, seated and sent out — so rendered raw it puts one heat in two
 *    places at once (owner 2026-08-14, live: "it's showing GF starter called,
 *    they're already racing"). A heat that has demonstrably moved on is not
 *    still called, and blanking is the honest answer: the next call fills it.
 *  • ON A MEGA NIGHT BOTH ROOMS SERVE THE ONE CIRCUIT, so the Briefing row reads
 *    whichever of them holds a live timeline. Callers hand in the rooms that
 *    serve their track and this takes the first one that is not idle.
 *  • THE ON-TRACK HEAT MAY COME FROM THE TIMING FEED when the lane has no racing
 *    slot — but its LEVEL never does. The socket knows a heat name and nothing
 *    about levels, and a type printed beside a session the lane cannot vouch for
 *    would be a guess about the group in front of the screen.
 *
 * THE EXTRAS ARE OPTIONAL, AND THAT IS DELIBERATE. The tablet knows things the
 * wall does not — the desk's check-in count, how long the seats have been
 * occupied, the live countdown — and passes them in. Omit them and every row
 * reads exactly as the wall has always read it, so adopting this module changed
 * nothing a guest can see.
 */
import { briefingTimelineAt } from "./phase";
import type { BriefingRoomState } from "./types";
import type { PitLaneFeed } from "../pit/pit-board";

/** The six stages, in the order a group passes through them. */
export type StageLabel = "Called" | "Briefing" | "Holding" | "In karts" | "On track" | "Pit in";

export const STAGE_LABELS: readonly StageLabel[] = [
  "Called",
  "Briefing",
  "Holding",
  "In karts",
  "On track",
  "Pit in",
] as const;

export interface StageRow {
  label: StageLabel;
  /** "Session 61", or "—" when the stage is empty. */
  value: string;
  /** The session's own level, when a stage can vouch for it. */
  type?: string;
  /** What it is DOING — distinct from what it IS. */
  detail?: string;
  /**
   * The heat number behind `value`, for callers that need to match rather than
   * print — the tablet highlights the row its button acts on. Null when empty.
   */
  heatNumber: number | null;
  /**
   * Tone for the detail, decided here so two surfaces cannot colour the same
   * fact differently. `alert` is only ever a post-race announcement still owed.
   */
  tone: "none" | "good" | "warn" | "alert";
}

const EMPTY = "—";

export interface StageRailInput {
  /** The track's called record, as Pandora reports it. */
  called: { heatNumber: number | null; raceType: string | null } | null;
  /** The briefing rooms serving this track — both of them on a Mega night. */
  rooms: Array<BriefingRoomState | null>;
  lane: PitLaneFeed | null;
  nowMs: number;
  /**
   * The heat the timing feed says is out, used ONLY when the lane has no racing
   * slot. Its level is deliberately not taken from here — see the header.
   */
  liveHeatNumber?: number | null;
  /** Is that clock genuinely counting, as opposed to armed? */
  liveCounting?: boolean;
  /** Time left on the current race, when the caller has a clock. */
  liveRemainingMs?: number | null;
  /** How the caller renders a duration — the two surfaces format alike but
   *  neither owns the other's helper. */
  formatClock?: (ms: number) => string;
  /** The desk's count for the called heat, when the caller polls it. */
  checkedIn?: { checkedIn: number; total: number } | null;
}

function sessionLabel(heatNumber: number | null | undefined): string {
  return heatNumber != null ? `Session ${heatNumber}` : EMPTY;
}

export function buildStageRail(input: StageRailInput): StageRow[] {
  const { lane, nowMs } = input;
  const fmt = input.formatClock;
  const rows: StageRow[] = [];

  /**
   * WHICH HEATS HAVE DEMONSTRABLY MOVED ON — every stage past Called. A heat
   * found here is no longer "called" however long Pandora keeps saying it is.
   * Matched on heat number because that is what every stage displays.
   */
  const downstream = new Set<number>();
  for (const state of input.rooms) {
    if (state?.heatNumber != null && briefingTimelineAt(state, nowMs).phase !== "idle") {
      downstream.add(state.heatNumber);
    }
  }
  for (const slot of ["holding", "karts", "racing", "pitIn"] as const) {
    const h = lane?.[slot]?.heatNumber;
    if (typeof h === "number") downstream.add(h);
  }

  const called = input.called;
  const calledMovedOn = called?.heatNumber != null && downstream.has(called.heatNumber);
  const calledHeat = called?.heatNumber != null && !calledMovedOn ? called.heatNumber : null;
  const count = input.checkedIn;
  // A total of zero is a roster we could not read, NOT an empty heat — it must
  // never be allowed to read as "everybody is here".
  const allIn = !!count && count.total > 0 && count.checkedIn >= count.total;
  rows.push({
    label: "Called",
    value: sessionLabel(calledHeat),
    type: calledHeat != null ? (called?.raceType ?? undefined) : undefined,
    detail:
      calledHeat != null && count && count.total > 0
        ? `${count.checkedIn} of ${count.total} checked in`
        : undefined,
    heatNumber: calledHeat,
    tone: calledHeat != null && count && count.total > 0 ? (allIn ? "good" : "warn") : "none",
  });

  /**
   * THE BRIEFING ROW. The room's OWN level, never its tier: a Pro session with
   * no Pro film uploaded plays the Intermediate one, and `tier` would tell a Pro
   * grid they are in an Intermediate race.
   */
  let briefing: StageRow = {
    label: "Briefing",
    value: EMPTY,
    heatNumber: null,
    tone: "none",
  };
  for (const state of input.rooms) {
    if (!state?.sessionId) continue;
    const t = briefingTimelineAt(state, nowMs);
    if (t.phase === "idle") continue;
    briefing = {
      label: "Briefing",
      value: state.heatNumber != null ? sessionLabel(state.heatNumber) : "In a room",
      type: state.raceType ?? undefined,
      detail:
        t.phase === "video" && t.nextInMs != null
          ? `${Math.max(1, Math.ceil(t.nextInMs / 60_000))} min of film left`
          : t.phase === "helmet"
            ? "helmets — ready to send"
            : "waiting to start",
      heatNumber: state.heatNumber,
      tone: t.phase === "helmet" ? "good" : "none",
    };
    break;
  }
  rows.push(briefing);

  const holding = lane?.holding ?? null;
  // Only ever counted from a stamp we actually have; a missing or skewed atMs
  // prints nothing rather than "in the seats 0:00".
  const heldMs = holding && Number.isFinite(holding.atMs) ? nowMs - holding.atMs : null;
  rows.push({
    label: "Holding",
    value: sessionLabel(holding?.heatNumber),
    type: holding?.raceType ?? undefined,
    detail: holding
      ? heldMs != null && heldMs >= 0 && fmt
        ? `in the seats · ${fmt(heldMs)}`
        : "in the seats"
      : undefined,
    heatNumber: holding?.heatNumber ?? null,
    tone: "none",
  });

  const karts = lane?.karts ?? null;
  rows.push({
    label: "In karts",
    value: sessionLabel(karts?.heatNumber),
    type: karts?.raceType ?? undefined,
    detail: karts ? "seated — waiting on the green" : undefined,
    heatNumber: karts?.heatNumber ?? null,
    tone: karts ? "good" : "none",
  });

  const racing = lane?.racing ?? null;
  const onTrackHeat = racing?.heatNumber ?? input.liveHeatNumber ?? null;
  const remaining = input.liveRemainingMs;
  const trackDetail =
    onTrackHeat != null && remaining != null && remaining >= 0 && fmt
      ? `${fmt(remaining)} left${input.liveCounting ? " · racing" : ""}`
      : input.liveCounting
        ? "racing"
        : onTrackHeat != null
          ? undefined
          : "track clear";
  rows.push({
    label: "On track",
    value: sessionLabel(onTrackHeat),
    type: racing?.raceType ?? undefined,
    detail: trackDetail,
    heatNumber: onTrackHeat,
    tone: "none",
  });

  const pitIn = lane?.pitIn ?? null;
  const sinceFinishMs = pitIn ? nowMs - (pitIn.finishedAtMs ?? pitIn.atMs) : null;
  rows.push({
    label: "Pit in",
    value: sessionLabel(pitIn?.heatNumber),
    type: pitIn?.raceType ?? undefined,
    detail: pitIn
      ? sinceFinishMs != null && sinceFinishMs >= 0 && fmt
        ? `karts in — post-race owed · ${fmt(sinceFinishMs)}`
        : "karts in — waiting on post-race"
      : undefined,
    heatNumber: pitIn?.heatNumber ?? null,
    tone: pitIn ? "alert" : "none",
  });

  return rows;
}
