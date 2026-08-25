/**
 * WHERE EVERY SESSION ON A TRACK IS, in order. PURE — facts in, one row per stage out.
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
 *  • ON A MEGA NIGHT BOTH ROOMS SERVE THE ONE CIRCUIT, so the Briefing row
 *    SPLITS — one row per room, each named and tinted for its own door. Callers
 *    hand in the rooms that serve their track; hand in one and the single
 *    "Briefing" row is unchanged, hand in two and you get both. Folding them
 *    into one row showed Red and hid Blue for the whole evening.
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
import { briefVerdict } from "./brief-verdict";
import type { SendWindow } from "./pull-to-room";
import type { BriefingRoom, BriefingRoomState } from "./types";
import type { PitLaneFeed } from "../pit/pit-board";

/**
 * The stages, in the order a group passes through them.
 *
 * "CHECKING IN", NOT "CALLED" — the word every wall in the estate already uses
 * for this stage (the camera boards' "CHECKING IN 6 / 14", the track board's
 * "Now checking in", the Mega tracker's own row). The desk keeps "Called" for
 * its box because a staff tool is naming the EVENT it is counting from, with a
 * "Checking in" clock inside it; a wall is naming what the group is DOING, and
 * this rail is a wall component that happens also to hang off a tablet.
 *
 * "Briefing" is ONE row on a night where one room feeds the track, and splits
 * into "Red room" / "Blue room" when two do — see buildStageRail's room block.
 */
export type StageLabel =
  | "Checking in"
  | "Briefing"
  | "Red room"
  | "Blue room"
  | "Holding"
  | "In karts"
  | "On track"
  | "Pit in";

export const STAGE_LABELS: readonly StageLabel[] = [
  "Checking in",
  "Briefing",
  "Holding",
  "In karts",
  "On track",
  "Pit in",
] as const;

/** The room rows' labels, in the order the rooms are always handed in. */
export const ROOM_STAGE_LABEL: Record<BriefingRoom, StageLabel> = {
  red: "Red room",
  blue: "Blue room",
};

/** A briefing room and whatever it is currently running — the identity travels
 *  WITH the state because a null room still has to be able to name itself. */
export interface RailRoom {
  room: BriefingRoom;
  state: BriefingRoomState | null;
}

export interface StageRow {
  label: StageLabel;
  /** "Session 61", or "—" when the stage is empty. */
  value: string;
  /** The session's own level, when a stage can vouch for it. */
  type?: string;
  /** What it is DOING — distinct from what it IS. */
  detail?: string;
  /**
   * The same fact for a screen with no room for it — the camera boards, whose
   * rail is 58% of a small panel (owner 2026-08-24: "these camera TVs are just
   * small"). Absent when the full form already fits.
   *
   * IT LIVES HERE, not in the renderer, so both densities take their words from
   * the one module. A view that abbreviated by string-slicing what it was given
   * would be a second author of the same sentence.
   */
  detailShort?: string;
  /**
   * The heat number behind `value`, for callers that need to match rather than
   * print — the tablet highlights the row its button acts on. Null when empty.
   */
  heatNumber: number | null;
  /**
   * Tone for the detail, decided here so two surfaces cannot colour the same
   * fact differently. `alert` means a deadline has been passed rather than
   * approached: a post-race announcement still owed, or a briefing that can no
   * longer finish before the race in front ends.
   */
  tone: "none" | "good" | "warn" | "alert";
  /**
   * THE ROOM THIS GROUP IS COMING BACK TO — the four lane stages only.
   *
   * A group welcomes back into the room it was briefed in
   * (briefing/welcome-back.ts), and the lane has carried that room on every
   * slot since the send. So from the seats to the pit it is knowable the whole
   * way through, and it is a fact about the FUTURE: on a Mega night one circuit
   * is fed by two rooms, and "which room does this race belong to" is the
   * question the tracker wall exists to answer (owner 2026-08-17).
   *
   * Null wherever it genuinely is not known: the desk stages (a called heat has
   * not been given a room yet), a heat the timing feed alone put on track with
   * no lane slot behind it, and a group placed by hand from Override with
   * nothing to copy from. A room is never inferred from a neighbouring slot —
   * the slots hold DIFFERENT groups on a busy night.
   */
  room?: "red" | "blue" | null;
  /**
   * THIS ROW *IS* A ROOM — set on the split "Red room" / "Blue room" rows only,
   * so a renderer can tint the label in the room's own colour without parsing
   * its own words back out of the label.
   *
   * Distinct from `room` above, which is the room a group on a LANE stage is
   * coming back to and earns a pill. A row whose label already names the room
   * never wears one — the pill would be the screen repeating itself.
   */
  labelTint?: BriefingRoom | null;
}

const EMPTY = "—";

export interface StageRailInput {
  /** The track's called record, as Pandora reports it. */
  called: { heatNumber: number | null; raceType: string | null } | null;
  /**
   * The briefing rooms serving this track — both of them on a Mega night, and
   * HAND THEM IN EVEN WHEN IDLE: it is the count of rooms, not the count of
   * live ones, that decides whether this rail splits into a row per room. A
   * Mega night with only Red briefing still has to show Blue as empty, or the
   * screen cannot be read as "nobody is in Blue" rather than "Blue is hidden".
   */
  rooms: RailRoom[];
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
  /**
   * HOW LONG THE CALLED HEAT HAS BEEN CHECKING IN — now minus the call, the
   * same anchor every other check-in clock in the estate counts from (owner
   * 2026-08-24: "missing how many are checked in out of how many, how long they
   * have been checking in for").
   *
   * Null when the call carried no usable stamp: the row then shows progress
   * with no clock rather than a made-up one.
   */
  calledForMs?: number | null;
  /** The venue's check-in window, so the verdict knows when a short grid stops
   *  being a wait and becomes PULL TO BRIEFING NOW. 0 = no deadline. */
  checkinWindowMins?: number;
  /**
   * WHEN THE CALLED GROUP SHOULD BE BRIEFED — the `sendWindow()` verdict the
   * check-in board's Send button and the room tablets' pull band already wear
   * (owner 2026-08-24: "make sure we honor what check in board and briefing
   * tablets honor"). Passed in rather than computed here so there is exactly
   * one engine behind all three surfaces and no second opinion to drift.
   *
   * Omit it and the Called row reads as it always has.
   */
  brief?: SendWindow | null;
}

/**
 * A LEVEL, SHORT ENOUGH FOR A SMALL SCREEN. "Junior Intermediate" is 19
 * characters beside a session number on a panel that is 58% of a camera board
 * (owner 2026-08-24: "junior intermediate is just way too book for no reason").
 *
 * These are the forms staff already say out loud, and the mapping lives here
 * with every other word this rail prints so the two densities cannot end up
 * abbreviating differently. Anything unrecognised is returned untouched — a new
 * level should read oddly rather than be silently mangled.
 */
export function shortLevel(raceType: string | null | undefined): string | undefined {
  const t = (raceType ?? "").trim();
  if (!t) return undefined;
  return t
    .replace(/\bJunior\b/gi, "Jr")
    .replace(/\bIntermediate\b/gi, "Inter")
    .replace(/\bBeginner\b/gi, "Begin");
}

function sessionLabel(heatNumber: number | null | undefined): string {
  return heatNumber != null ? `Session ${heatNumber}` : EMPTY;
}

/** The four pit stages a heat can be sitting in once it is past the desk. */
const LANE_SLOTS = ["holding", "karts", "racing", "pitIn"] as const;

/**
 * THE HEATS THIS LANE CAN VOUCH FOR AS PAST THE DESK — in the seats, in the
 * karts, out on track, or back in the pit.
 *
 * SEPARATE FROM THE BRIEFING ROOMS ON PURPOSE, because the two facts are used
 * differently. The rail below folds both together (a heat in a room is no longer
 * "called" either), but the room tablet needs the lane alone: "Session 37 is
 * already in the red room" is a TRUE and useful thing to tell the staff member
 * while the group is standing in it, and a lie the moment they have gone out.
 *
 * WHY IT IS THE LANE THAT DECIDES. Pandora keeps its called record for ~20
 * minutes, and our own Redis carry keeps it for up to six hours or until the
 * next heat is called — whichever is longer (races-current.server /
 * current-race-freshness). On a track whose next heat is not called for a while,
 * "checking in" therefore outlives the race itself. The lane is the feed that
 * watches groups physically move, so it is the one that can say they have.
 */
export function laneHeats(lane: PitLaneFeed | null | undefined): Set<number> {
  const heats = new Set<number>();
  for (const slot of LANE_SLOTS) {
    const h = lane?.[slot]?.heatNumber;
    if (typeof h === "number") heats.add(h);
  }
  return heats;
}

/**
 * HAS THIS HEAT LEFT THE DESK BEHIND? The one question the "checking in" band
 * and the pull button both have to ask before they name a heat — see laneHeats.
 * An unnumbered heat (a group event, a custom race) can never be matched, so it
 * is never claimed to have moved: failing open leaves the pull available, which
 * is the direction that costs a walk rather than a missed race.
 */
export function heatIsPastTheDesk(
  heatNumber: number | null | undefined,
  lane: PitLaneFeed | null | undefined,
): boolean {
  return heatNumber != null && laneHeats(lane).has(heatNumber);
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
  const downstream = laneHeats(lane);
  for (const { state } of input.rooms) {
    if (state?.heatNumber != null && briefingTimelineAt(state, nowMs).phase !== "idle") {
      downstream.add(state.heatNumber);
    }
  }

  const called = input.called;
  const calledMovedOn = called?.heatNumber != null && downstream.has(called.heatNumber);
  const calledHeat = called?.heatNumber != null && !calledMovedOn ? called.heatNumber : null;
  const count = input.checkedIn;
  // A total of zero is a roster we could not read, NOT an empty heat — it must
  // never be allowed to read as "everybody is here".
  const allIn = !!count && count.total > 0 && count.checkedIn >= count.total;
  /**
   * THE BRIEFING VERDICT — decided in brief-verdict.ts, not here.
   *
   * This block used to read the send window alone, which is how a wall came to
   * print BRIEF NOW over a half-checked-in grid (owner 2026-08-24). The roster,
   * the check-in deadline and the film all belong to one decision; the rail's
   * job is to render it.
   */
  const brief =
    input.brief === undefined
      ? null
      : briefVerdict({
          called: calledHeat != null,
          window: input.brief,
          checkedIn: count ?? null,
          calledForMs: input.calledForMs ?? null,
          checkinWindowMins: input.checkinWindowMins ?? 0,
          formatClock: fmt,
        });
  const briefPhrase =
    brief && brief.kind !== "quiet" ? { text: brief.phrase, tone: brief.tone } : null;

  const countText =
    calledHeat != null && count && count.total > 0
      ? `${count.checkedIn} of ${count.total} checked in`
      : null;
  /** How long they have been at it. Only ever from a real stamp, and never a
   *  negative one — a clock skew is not a group that checked in tomorrow. */
  const waitedText =
    calledHeat != null && input.calledForMs != null && input.calledForMs >= 0 && fmt
      ? `${fmt(input.calledForMs)} checking in`
      : null;
  rows.push({
    label: "Checking in",
    value: sessionLabel(calledHeat),
    type: calledHeat != null ? (called?.raceType ?? undefined) : undefined,
    detail: [countText, waitedText, briefPhrase?.text].filter(Boolean).join(" · ") || undefined,
    heatNumber: calledHeat,
    // THE HARDER FACT WINS THE COLOUR. A complete grid is good news, but a
    // briefing that can no longer fit outranks it — green beside "no time"
    // would be the screen contradicting itself.
    tone:
      briefPhrase && briefPhrase.tone === "alert"
        ? "alert"
        : countText
          ? allIn
            ? (briefPhrase?.tone ?? "good")
            : "warn"
          : (briefPhrase?.tone ?? "none"),
  });

  /**
   * WHAT ONE ROOM IS DOING. The room's OWN level, never its tier: a Pro session
   * with no Pro film uploaded plays the Intermediate one, and `tier` would tell
   * a Pro grid they are in an Intermediate race.
   *
   * `null` when the room is idle, so the two callers below can tell "nothing
   * here" from "here is what is happening" without re-deriving the phase.
   */
  const roomRow = (label: StageLabel, entry: RailRoom): StageRow | null => {
    const state = entry.state;
    if (!state?.sessionId) return null;
    const t = briefingTimelineAt(state, nowMs);
    if (t.phase === "idle") return null;
    return {
      label,
      value: state.heatNumber != null ? sessionLabel(state.heatNumber) : "In a room",
      type: state.raceType ?? undefined,
      detail:
        t.phase === "video" && t.nextInMs != null
          ? // A REAL CLOCK, NOT A ROUNDED MINUTE (owner 2026-08-24: "instead of
            // saying 3 minutes left of film, 4 minutes etc, why don't we show
            // real timer there?"). "4 min left" sat unchanged for a minute at a
            // time and read as stale on a wall where every other number moves —
            // and it is the number a staff member is timing their walk against.
            // A caller with no formatter keeps the old wording rather than
            // printing raw milliseconds.
            fmt
            ? `${fmt(t.nextInMs)} of film left`
            : `${Math.max(1, Math.ceil(t.nextInMs / 60_000))} min of film left`
          : t.phase === "helmet"
            ? "helmets — ready to send"
            : "waiting to start",
      heatNumber: state.heatNumber,
      tone: t.phase === "helmet" ? "good" : "none",
    };
  };

  /**
   * ONE ROW PER ROOM WHEN TWO ROOMS FEED ONE TRACK — the shape of a Mega night
   * (owner 2026-08-25: "we have two briefing rooms one track on mega, did we
   * account for that on the new board?").
   *
   * The folded Briefing row took the FIRST room holding a live timeline, which
   * is honest on a split night — one room, one track — and a lie on a Mega one,
   * where both rooms brief into the single circuit all evening. Red is always
   * handed in first, so what the walls actually did was show Red and silently
   * drop Blue: a staff member reading "Briefing — Session 62" had no way to know
   * a second group was thirty seconds off walking out of the other door. The
   * session tracker was the only surface that ever split them, in a renderer of
   * its own (ScenePitBoard's trackerRoomStage) — which is the drift this module
   * exists to stop, so the split belongs HERE and every surface inherits it.
   *
   * One room in, one Briefing row out, exactly as before: a split night's rail
   * is untouched, and so is the room tablet's on a non-Mega day.
   */
  if (input.rooms.length > 1) {
    for (const entry of input.rooms) {
      const label = ROOM_STAGE_LABEL[entry.room];
      rows.push(
        roomRow(label, entry) ?? {
          label,
          value: EMPTY,
          heatNumber: null,
          tone: "none",
        },
      );
      // The label IS the room, so it wears the room's colour rather than a pill.
      rows[rows.length - 1].labelTint = entry.room;
    }
  } else {
    const only = input.rooms[0];
    rows.push(
      (only ? roomRow("Briefing", only) : null) ?? {
        label: "Briefing",
        value: EMPTY,
        heatNumber: null,
        tone: "none",
      },
    );
  }

  const holding = lane?.holding ?? null;
  // Only ever counted from a stamp we actually have; a missing or skewed atMs
  // prints nothing rather than "in the seats 0:00".
  const heldMs = holding && Number.isFinite(holding.atMs) ? nowMs - holding.atMs : null;
  rows.push({
    label: "Holding",
    value: sessionLabel(holding?.heatNumber),
    type: holding?.raceType ?? undefined,
    // "In holding", not "in the seats" (owner 2026-08-24). The row is already
    // labelled HOLDING, and the seats are only where holding happens to put
    // them — a group standing at the fence is in holding too.
    detail: holding
      ? heldMs != null && heldMs >= 0 && fmt
        ? `in holding · ${fmt(heldMs)}`
        : "in holding"
      : undefined,
    heatNumber: holding?.heatNumber ?? null,
    tone: "none",
    room: holding?.room ?? null,
  });

  const karts = lane?.karts ?? null;
  rows.push({
    label: "In karts",
    value: sessionLabel(karts?.heatNumber),
    type: karts?.raceType ?? undefined,
    detail: karts ? "seated — waiting on the green" : undefined,
    heatNumber: karts?.heatNumber ?? null,
    tone: karts ? "good" : "none",
    room: karts?.room ?? null,
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
    // THE LANE'S ROOM, NEVER THE FEED'S HEAT. `onTrackHeat` may have come from
    // the timing socket alone, which knows a heat name and nothing about where
    // that group was briefed — the same rule the level above already follows.
    room: racing?.room ?? null,
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
    // The row is labelled PIT IN; "karts in" says it a second time, and the
    // number is the part a small screen needs.
    detailShort: pitIn
      ? sinceFinishMs != null && sinceFinishMs >= 0 && fmt
        ? `post owed · ${fmt(sinceFinishMs)}`
        : "post owed"
      : undefined,
    heatNumber: pitIn?.heatNumber ?? null,
    tone: pitIn ? "alert" : "none",
    room: pitIn?.room ?? null,
  });

  return rows;
}
