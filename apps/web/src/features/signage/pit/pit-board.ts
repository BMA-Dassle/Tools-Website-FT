/**
 * The pit assignment board — the PURE half. Ordering, the rail state machine,
 * and the wire shapes. No Redis, no fetch, no React: everything here is
 * testable arithmetic, and the server module (lane.server.ts / service.ts) and
 * the scene both import from here so the two can never disagree about a rule.
 *
 * WHAT A "SPOT" IS (owner 2026-08-13): BMI's own grid position —
 * `raceInfo.startPosition` on the Pandora participants payload — which is
 * exactly the list the vendor AssignmentTV has been reading all along. When
 * BMI has minted positions, they are THE spots, verbatim, whatever order the
 * desk arranged; the board mirrors, never reinterprets.
 *
 * THE FALLBACK, for a roster BMI has not gridded yet, is derived from the one
 * ordering fact the operation runs on:
 *
 *   CHECKED-IN RACERS FILL THE LIST FROM THE FRONT, IN CHECK-IN ORDER.
 *   NO-SHOWS ALWAYS FILL THE LAST SLOTS (owner: "all not checked in racers
 *   must directly fill last slots").
 *
 * Derived means deterministic: the same roster always produces the same spots,
 * with no Redis state to drift and nothing to sweep — and the moment BMI's
 * positions appear on the payload they win, with no seam to flip.
 */

import type { CheckinRosterRow } from "../checkin-progress";
import { participantCheckedIn } from "../checkin-progress";

/** The roster fields the pit board reads. A superset of CheckinRosterRow —
 *  the participants payload carries all of these (lib/participant-contact.ts
 *  is the canonical contract; ids arrive as JSON strings from Pandora). */
export interface PitParticipantRow extends CheckinRosterRow {
  personId?: string | number | null;
  /** Stable per-participation id — survives a heat move, unlike personId
   *  which can legitimately appear on two bookings. */
  participantId?: string | number | null;
  firstName?: string | null;
  lastName?: string | null;
  /** ViewPoint POV credits from the deposit — nonzero means this racer has a
   *  video package, so a camera must be clipped on in the pit. */
  viewpointCredit?: number | null;
  /** BMI's grid data. `startPosition` IS the pit spot when present. */
  raceInfo?: { startPosition?: number | null } | null;
}

/** One card on the board. FULL NAMES AND A PHOTO KEY, deliberately — this
 *  screen's PII posture is the owner's 2026-08-13 decision (the vendor board
 *  it replaces has always shown both), distinct from the scan rail's
 *  first-names-only rule which still stands everywhere else. */
export interface PitRosterEntry {
  /** 1-based. Checked-in racers from the front, no-shows at the tail. */
  spot: number;
  name: string;
  /** TEXT, always — BMI ids exceed Number.MAX_SAFE_INTEGER (house rule). */
  personId: string;
  participantId: string | null;
  checkedIn: boolean;
  /** POV camera (system number) once one is clipped on. */
  camera: string | null;
  /** Has a video package but no camera yet — the amber "Cam needed" chip.
   *  Only meaningful once they are here; a no-show shows no camera state. */
  cameraDue: boolean;
  birthday: boolean;
  vip: boolean;
  /**
   * BACK-TO-BACK, and where they are going (owner 2026-08-14).
   *
   * `arriving` = out on track right now in an earlier heat and staged here, so
   * the empty card and the no-show ring are expected rather than something to
   * chase. `again` = racing again within the next two heats, so they go back to
   * holding when this race ends instead of out through check-in.
   *
   * Null for an ordinary racer. See pit/back-to-back.ts — a racer who is both
   * reads as `arriving`, because that is the one that changes what staff do now.
   */
  backToBack: { state: "arriving" | "again"; session: number | null; track: string } | null;
}

/** One roster row with the spot it holds. */
export interface OrderedPitRow {
  row: PitParticipantRow;
  spot: number;
}

/** BMI's grid position for a row, or null when the grid has not minted one. */
function startPositionOf(r: PitParticipantRow): number | null {
  const v = r.raceInfo?.startPosition;
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? v : null;
}

/**
 * Order a roster into spots.
 *
 * BMI FIRST: rows carrying `raceInfo.startPosition` wear that number verbatim
 * and sort by it — that IS the assignment, including the desk having moved a
 * no-show to the bottom in BMI itself. Rows the grid has not placed yet
 * follow, numbered past the highest assigned spot, in the derived order:
 * checked-in racers first as they came through the desk (a group check-in
 * stamps every racer the same millisecond — observed live 2026-08-12 — so
 * ties, and the no-show tail, fall back to participantId, which is stable
 * where the payload's own array order carries no guarantee). The same roster
 * therefore always yields the same spots: a board that reshuffles between two
 * polls would read as staff moving people.
 */
export function orderPitRoster(rows: PitParticipantRow[]): OrderedPitRow[] {
  const stamp = (r: PitParticipantRow): number => {
    const v = r.checkedIn;
    if (typeof v !== "string") return Number.POSITIVE_INFINITY;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  // participantId is numeric-as-string today; compare numerically when both
  // parse so "9" sorts before "10", falling back to string compare.
  const pid = (r: PitParticipantRow): string =>
    r.participantId == null ? "" : String(r.participantId);
  const byId = (a: PitParticipantRow, b: PitParticipantRow): number => {
    const ap = pid(a);
    const bp = pid(b);
    const an = /^\d+$/.test(ap) ? Number(ap) : NaN;
    const bn = /^\d+$/.test(bp) ? Number(bp) : NaN;
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return ap.localeCompare(bp);
  };

  const gridded = rows.filter((r) => startPositionOf(r) != null);
  const ungridded = rows.filter((r) => startPositionOf(r) == null);
  gridded.sort(
    (a, b) => (startPositionOf(a) as number) - (startPositionOf(b) as number) || byId(a, b),
  );

  const here = ungridded.filter(participantCheckedIn);
  const away = ungridded.filter((r) => !participantCheckedIn(r));
  here.sort((a, b) => stamp(a) - stamp(b) || byId(a, b));
  away.sort(byId);

  const out: OrderedPitRow[] = gridded.map((row) => ({
    row,
    spot: startPositionOf(row) as number,
  }));
  // The ungridded continue past the highest real spot rather than restarting
  // at 1 — two racers wearing the same number would read as a double booking.
  let next = out.reduce((max, r) => Math.max(max, r.spot), 0);
  for (const row of [...here, ...away]) out.push({ row, spot: ++next });
  return out;
}

/** What TvFeed.pitBoard carries — declared HERE, in the pure module, so the
 *  client-imported types.ts never has to touch the server-only service. */
export interface PitBoardInfo {
  track: "blue" | "red" | "mega";
  session: {
    /** TEXT — BMI ids exceed Number.MAX_SAFE_INTEGER (house rule). */
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    /** Where (and whether) this group was briefed — the rail's "info" copy. */
    briefedRoom: "red" | "blue" | null;
    briefedAtMs: number | null;
    /** Staff sent them to the seats. */
    inHolding: boolean;
    /** Their own green flag has been seen — the board is about to roll. */
    startedAtMs: number | null;
    /** When this group's PRE-RACE PA cue played (pit/audio.server.ts), null
     *  until it has — the wall's small "pre-race ✓ / due" indicator. */
    preRaceAtMs: number | null;
    /** The clip's length, as the PLAYER reported it when the cue fired. This is
     *  what lets the board say "playing" and then stop saying it — without it we
     *  would be guessing a duration, which is how the pre pill got stuck
     *  (owner 2026-08-15: "the pre-playing never changed to played"). Null on a
     *  legacy stamp, and then the board treats the cue as simply played. */
    preRaceDurationS: number | null;
  } | null;
  /** Null when the roster could not be read — the board shows the session
   *  alone rather than an empty grid pretending to be a heat of nobody. */
  roster: PitRosterEntry[] | null;
}

/* ── the fast roster, as it travels on the pulse ──────────────────────── */

/**
 * The lean, fast-changing slice of a roster — who is on the session, whether
 * they are checked in, and BMI's grid position. Rides the 2-second pulse via
 * a short Redis cache (pit/fast-roster.server.ts) so the board tracks the
 * desk in seconds; everything slow (cameras, birthdays, VIP, photos) stays on
 * the 15s feed and is joined back in by mergePitRoster below.
 */
export interface FastPitRow {
  participantId: string | null;
  personId: string;
  /** Full name — this board's PII posture (owner 2026-08-13). */
  name: string;
  /** Verbatim from Pandora: a timestamp string, `true`, or absent. */
  checkedIn: string | boolean | null;
  startPosition: number | null;
}

export interface FastPitRoster {
  sessionId: string;
  rows: FastPitRow[];
}

/**
 * Overlay the fast roster onto the last full build.
 *
 * THE FAST ROWS ARE THE ROSTER — membership, order and check-in state all
 * come from them, so a racer added at the desk or re-gridded in BMI appears
 * within a pulse or two. The slow build contributes the joins that cannot
 * change that fast (camera, birthday, VIP), matched by personId; a racer the
 * slow build has not seen yet simply carries no badges until the next 15s
 * poll names their flags.
 */
export function mergePitRoster(fast: FastPitRow[], slow: PitRosterEntry[]): PitRosterEntry[] {
  const extras = new Map(slow.map((e) => [e.personId, e]));
  const rows: PitParticipantRow[] = fast.map((f) => ({
    participantId: f.participantId,
    personId: f.personId,
    // The full name rides `firstName` through the ordering — orderPitRoster
    // never reads names, it just carries the row.
    firstName: f.name,
    checkedIn: f.checkedIn,
    raceInfo: { startPosition: f.startPosition },
  }));
  return orderPitRoster(rows).map(({ row, spot }) => {
    const pid = row.personId == null ? "" : String(row.personId);
    const known = extras.get(pid);
    return {
      spot,
      name: String(row.firstName ?? "").trim() || known?.name || "Racer",
      personId: pid,
      participantId: row.participantId == null ? null : String(row.participantId),
      checkedIn: participantCheckedIn(row),
      camera: known?.camera ?? null,
      cameraDue: known?.cameraDue ?? false,
      birthday: known?.birthday ?? false,
      vip: known?.vip ?? false,
      backToBack: known?.backToBack ?? null,
    };
  });
}

/* ── the lane, as it travels on the wire ──────────────────────────────── */

/**
 * One track's pit lane, resolved to what is true RIGHT NOW.
 *
 * `holding` is the group staff sent to the seats after their briefing;
 * `karts` is that same group once they have climbed into the karts but before
 * the green flag; `racing` is the group out on track — and once its finish
 * marker lands the lane is LIVE (karts rolling back in) until staff explicitly
 * mark it pitted. All three are per-session facts; the resolution from stored
 * state + start/finish markers happens server-side in lane.server.ts.
 *
 * IN KARTS IS A WAYPOINT, NOT A GATE (owner 2026-08-14: "session can go from
 * holding to race or holding to karts"). A group may pass through it or skip it
 * entirely, and the promotion out of it is the SAME predicate that promotes out
 * of holding — see resolveLane, which reads `karts ?? holding` as its one
 * source. So a night where nothing ever fills this slot behaves exactly as the
 * two-slot lane did.
 *
 * Why a slot of its own rather than a flag on `holding`: the seats and the karts
 * are different places, and the whole point of the stage is that the SEATS ARE
 * FREE once a group is in the karts. A flag would have left them occupying the
 * seats on every board that reads this.
 */
export interface PitLaneFeed {
  holding: {
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    /** Which briefing room they came from — the room this send freed. */
    room: "red" | "blue" | null;
    atMs: number;
  } | null;
  /** Seated in the karts, waiting on the green. Same shape as `holding` so
   *  every consumer can treat the two as one "staged" group. */
  karts: {
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    room: "red" | "blue" | null;
    /** When they got into the karts — the pre-race call, not the send. */
    atMs: number;
  } | null;
  /**
   * ON TRACK, AND ONLY ON TRACK (owner 2026-08-15: "on track only is when
   * they're really out on track").
   *
   * It used to carry `finishedAtMs` and `pittedAtMs` — a group stayed here after
   * their chequered flag and the two stamps described how far through coming
   * back they were. That is what made the lane destroy them: there is one of
   * this slot, and the next group green-flagging overwrote it, taking with it
   * the only record that a post announcement was still owed. Those two facts
   * live on `pitIn` now, where they describe a group that is actually in the pit.
   */
  racing: {
    sessionId: string;
    heatNumber: number | null;
    /** The level they are running, same vocabulary as every other slot. Null
     *  only for a group promoted from a lane written before this field existed,
     *  or placed on track by hand from Override with nothing to copy from. */
    raceType: string | null;
  } | null;
  /**
   * BACK IN THE PIT, WAITING ON THE POST ANNOUNCEMENT (owner 2026-08-15: "the
   * inbound race that is still sitting in karts waiting for post announcements
   * gets cleared by the race that is sent to track… finishing race goes to a new
   * state type of Pit In. So then post race becomes the item that clears pit in
   * status").
   *
   * A SLOT OF ITS OWN BECAUSE TWO GROUPS ARE GENUINELY AT THE PIT AT ONCE: one
   * rolling in under the chequered flag, one already seated in their karts
   * waiting on the green. That overlap is the normal shape of a busy night, and
   * a lane with a single racing slot could not hold both — so the returning
   * group was silently overwritten the moment the next one went out.
   *
   * DISTINCT FROM `karts`, which is the same physical position at the opposite
   * end of the race: karts is pre-flag and clears on the green, pitIn is
   * post-flag and clears on the post announcement.
   */
  pitIn: {
    sessionId: string;
    heatNumber: number | null;
    raceType: string | null;
    room: "red" | "blue" | null;
    /** The venue's own end signal, or the socket's first sighting of it. Null
     *  when they were succeeded onto the track without any witness at all. */
    finishedAtMs: number | null;
    /** When they entered this stage — the finish when we have one, else the
     *  moment the next group took the track. */
    atMs: number;
    /** The post announcement's stamp and clip length, so the board can say
     *  due -> playing -> played instead of the group simply vanishing when the
     *  cue fires (owner 2026-08-15, the split rail). */
    postRaceAtMs: number | null;
    postRaceDurationS: number | null;
  } | null;
  /**
   * THE PRE-RACE DEBT, and whether the next group may be seated (owner
   * 2026-08-16: "if we go green and still haven't played pre, we should put up a
   * full screen stop sending flash on that pit monitor").
   *
   * WHY THIS IS A GATE AND NOT A REMINDER. A group that goes green without its
   * pre can still be paid — playPreRace falls back to the racing group when
   * nothing is staged. But `staged` WINS that choice, so the moment the next
   * group is seated the PA belongs to their cycle and the owed announcement
   * becomes unplayable by any control that exists. Seating the next group does
   * not delay the debt, it destroys it. Hence "stop sending" rather than
   * "remember to play the pre".
   *
   * THE RAW FACTS TRAVEL, NOT THE VERDICT. The window below is a clock
   * comparison and the wall owns its own clock — same split as `pitIn`'s post
   * stamps and `pitRailState`. Read for whichever group the lane is furthest
   * along with, since that is exactly who playPreRace would target.
   */
  preGate: {
    sessionId: string;
    heatNumber: number | null;
    /** Phase one of the two-phase start — karts rolling out. Null until the
     *  broadcast stamps it, which is the whole "have they gone yet" question. */
    startedAtMs: number | null;
    /** The pre cue's stamp. Written by claimAndPlay BEFORE the play request
     *  goes out, so it appears the instant the button is pressed — and is
     *  DELETED again if the play fails, which is what makes the banner clear
     *  on the press and come back if the PA never sounded. */
    preRaceAtMs: number | null;
    preRaceDurationS: number | null;
  } | null;
}

export type PitLanes = Record<"blue" | "red" | "mega", PitLaneFeed>;

export const EMPTY_PIT_LANE: PitLaneFeed = {
  holding: null,
  karts: null,
  racing: null,
  pitIn: null,
  preGate: null,
};

/* ── may the next group be seated? ────────────────────────────────────── */

/**
 * `pre-required`   a group has gone green and their pre never played. The debt
 *                  is still payable, but ONLY until somebody is seated — so the
 *                  wall says stop, in red, full screen, until the cue fires.
 * `clear-to-send`  the pre has finished sounding (owner 2026-08-16: "once pre
 *                  finished, you could put a flash of green clear to send").
 *                  Transient: an acknowledgement, not a state to live in.
 * `none`           nothing to say — including WHILE the pre is sounding, which
 *                  is the gap between the two: the red is already gone (staff
 *                  pressed it) and the green has not been earned yet.
 */
export type PreSendGate = "none" | "pre-required" | "clear-to-send";

/**
 * How long CLEAR TO SEND holds after the cue ends.
 *
 * DELIBERATELY BRIEF, and shorter than it first wants to be. The red state can
 * own the screen for as long as it likes — while it is up, nobody should be
 * seating anyone, so the roster underneath is not wanted. The green is the
 * opposite: it fires at exactly the moment staff turn to the board to seat the
 * next group, so a generous window would hide the spot list precisely when it
 * is needed. Four beats of the 1.4s pulse — long enough to catch from the
 * fence, gone before it is in the way.
 */
export const CLEAR_TO_SEND_MS = 5_600;

/** Assumed pre length when the player never reported one — the same 60s
 *  audio.server.ts assumes in its stay-seated guard, and for the same reason:
 *  over-estimating delays a green flash, under-estimating tells staff to send
 *  while the announcement is still sounding. */
const PRE_CLIP_NOMINAL_MS = 60_000;

/* ── may the pre-race cue play? ───────────────────────────────────────── */

/**
 * ARE THE KARTS FREE FOR THIS GROUP? PURE — a lane slot and a session in, a
 * verdict out. Same split as holdingAvailability, and for the same reason: the
 * pit station has to decide whether to offer the button, and the sentence on the
 * disabled button must be the sentence the server would have returned.
 *
 * WHY THE CUE NEEDS A GATE AT ALL (owner 2026-08-16, live: blue 17 in the seats,
 * blue 16 strapped into their karts). The pre-race announcement is what walks
 * the seated group into their karts, so it cannot be owed while somebody else is
 * still sitting in them. Playing it would call 17 to karts that are not free —
 * and `markInKarts`, which the press triggers, writes the karts slot with no
 * occupancy check, so 16 would have been overwritten and vanished off the lane.
 *
 * That is the third instance of one bug: a single slot written without asking
 * who is in it. The other two cost six groups their post announcement on
 * 2026-08-16.
 *
 * DRAWN IS NOT ENFORCED. The pit station is a long-lived kiosk nobody reloads —
 * the same device class that defeated the send-to-holding film gate on 8/15 by
 * serving JS from before the fix. So this verdict is enforced in playPreRace and
 * again in markInKarts; the button merely reads the same answer.
 */
export type KartsAvailability = { ok: true } | { ok: false; error: string };

export function kartsAvailability(args: {
  karts: { sessionId: string; heatNumber?: number | null } | null | undefined;
  sessionId: string;
}): KartsAvailability {
  const occupant = args.karts ?? null;
  // Empty karts, or a repeat press for the group already in them — the second
  // is a refresh, not a displacement, and playPreRace relies on it.
  if (!occupant || occupant.sessionId === args.sessionId) return { ok: true };
  const who = occupant.heatNumber != null ? `Session ${occupant.heatNumber}` : "another group";
  return {
    ok: false,
    error: `${who} is still in the karts — the pre-race call frees the seats when they take the green.`,
  };
}

/* ── the pre-race pill ────────────────────────────────────────────────── */

/**
 * The pre-race cue's verdict — the pill on the wall, and the whole left box it
 * sits in (owner 2026-08-15: "i want the whole box").
 *
 *   no cue yet, group seated    → "Pre-race due"      amber, the cue is owed
 *   cue fired, race not armed   → "Pre-race playing"  the announcement is out
 *   cue fired AND race armed    → "Ready to send"     green, both gates cleared
 *   nothing owed                → "Pre-race ✓"
 *
 * IT FLIPS ON THE PRESS, NOT ON THE SOUND (owner 2026-08-16: "the pit pill that
 * says pre-due can change to now play on press"). The board has no view of the
 * PA's own playing state — Q-SYS knows it, this payload does not carry it — but
 * the press is what stamps `preRaceAtMs`, so the stamp's existence IS the press.
 *
 * WHAT WAS BROKEN. "Playing" required a REPORTED clip length, and claimAndPlay
 * writes the stamp with `durationS: null` first, filling the real length in only
 * once the player answers. So the pill skipped "playing" for the second in
 * between — and skipped it FOR EVER whenever the player reported no length at
 * all, jumping from "due" straight to "✓" on the press. The prose above this
 * function had described the correct behaviour ("rather than guess a clip length
 * we hold 'playing' until the race arms") since the day it was written; only the
 * code disagreed.
 *
 * So an unknown length HOLDS at playing until the race arms, which is the next
 * thing that actually happens. A known length is still preferred and still
 * exact — the stamp carries it, and nothing has to guess.
 *
 * Lives here rather than in the scene so it is testable arithmetic, like every
 * other rule on this board.
 */
export type PreTone = "due" | "playing" | "ready" | "done";

export function preRaceTone(
  session: {
    inHolding: boolean;
    preRaceAtMs: number | null;
    preRaceDurationS: number | null;
  } | null,
  armed: boolean,
  nowMs: number,
): { label: string; tone: PreTone } | null {
  if (!session) return null;
  const played = session.preRaceAtMs != null;
  if (!played && !session.inHolding) return null;
  if (!played) return { label: "Pre-race due", tone: "due" };

  const stillPlaying =
    session.preRaceDurationS != null
      ? // The clip's OWN reported length — exact, nothing guessed.
        nowMs < session.preRaceAtMs! + session.preRaceDurationS * 1000
      : // No length reported. Hold at playing until the race arms rather than
        // declaring a cue finished that we never saw start.
        !armed;
  if (stillPlaying) return { label: "Pre-race playing", tone: "playing" };
  // No cue means "due" even once the race arms: the announcement is what sends
  // the group to the karts, so an armed race with no cue waits on the cue.
  if (armed) return { label: "Ready to send", tone: "ready" };
  return { label: "Pre-race ✓", tone: "done" };
}

export function preSendGateAt(
  gate: PitLaneFeed["preGate"],
  nowMs: number,
): { state: PreSendGate; heatNumber: number | null } {
  if (!gate) return { state: "none", heatNumber: null };
  const heatNumber = gate.heatNumber;

  // NOT PLAYED. Only a problem once they have actually gone — a group still in
  // the seats owes nothing yet, and shouting at the wall through every ordinary
  // briefing would train staff to ignore this.
  if (gate.preRaceAtMs == null) {
    return { state: gate.startedAtMs != null ? "pre-required" : "none", heatNumber };
  }

  /**
   * GREEN ONLY EVER ANSWERS A RED (owner 2026-08-16, live: "the clear to send
   * blink of green came up even if we never got the red stop").
   *
   * It fired on every ordinary turnover, because the first cut greened whenever
   * a cue finished. That is noise on a wall whose job is showing spots — and it
   * covered the roster at exactly the moment staff turned to it to seat the next
   * group, which is the one thing the short window was chosen to avoid.
   *
   * CLEAR TO SEND is the RESOLUTION of STOP SENDING, not a receipt for a cue.
   * The red is raised only when a group has gone green with the pre unplayed, so
   * the green belongs only to the same case: a cue stamped AFTER the flag, i.e.
   * the late payment the banner demanded. A pre played while the group was still
   * in the seats — the healthy night, every time — was never red and must never
   * go green.
   */
  const paidLate = gate.startedAtMs != null && gate.preRaceAtMs > gate.startedAtMs;
  if (!paidLate) return { state: "none", heatNumber };

  const endsAtMs =
    gate.preRaceAtMs +
    (gate.preRaceDurationS != null ? gate.preRaceDurationS * 1000 : PRE_CLIP_NOMINAL_MS);
  if (nowMs < endsAtMs) return { state: "none", heatNumber };
  return {
    state: nowMs - endsAtMs <= CLEAR_TO_SEND_MS ? "clear-to-send" : "none",
    heatNumber,
  };
}

/* ── the rail state machine ───────────────────────────────────────────── */

/**
 *  info   the display session has not reached the seats yet (checking in, or
 *         watching the film) — the rail reports rather than instructs
 *  seat   the lane is safe and the group is theirs to seat: steady green
 *  hold   a race has finished and its karts are in (or rolling into) the
 *         lane, and staff have not yet marked it returned: the amber flash
 *  racing the display session itself has green-flagged — the board is about
 *         to roll to the next session and says so quietly
 */
export type PitRailKind = "info" | "seat" | "hold" | "racing";

export interface PitRailInput {
  /** The display session has been sent to holding. */
  stagedInHolding: boolean;
  /** The display session's own green flag has been seen (start marker). */
  stagedStartedAtMs: number | null;
  /**
   * IS A GROUP IN THE PIT WAITING ON ITS POST ANNOUNCEMENT — the lane's `pitIn`
   * slot, occupied.
   *
   * This was `racingFinishedAtMs` + `pittedAtMs`, a pair the caller had to
   * compare to work out whether the hold was live. The comparison now happens
   * once, server-side, when the lane resolves: a group is in `pitIn` until their
   * post announcement clears them, so the slot being occupied IS the hold. One
   * fact instead of two, and no way for a caller to compare them wrongly.
   */
  pitInOccupied: boolean;
}

/**
 * Which rail shows.
 *
 * THE HOLD OUTRANKS EVERYTHING EXCEPT THE GREEN FLAG: karts in motion in the
 * lane is a safety fact, so it suppresses "seat" even for a group that is
 * fully staged — and it clears on the staff "pitted" call ONLY, never on
 * elapsed time. A pitted stamp older than the finish it answers is a stale
 * stamp from the previous cycle and does not clear the new hold.
 */
export function pitRailState(input: PitRailInput): PitRailKind {
  if (input.stagedStartedAtMs != null) return "racing";
  if (input.pitInOccupied) return "hold";
  if (!input.stagedInHolding) return "info";
  return "seat";
}

/* ── the arrival call ─────────────────────────────────────────────────── */

/**
 * How long the arrival instruction flashes after staff send a group to holding.
 *
 * A group walks from the briefing room to the pit in well under a minute, and
 * the instruction is only useful while they are arriving and looking for where
 * to stand. After that it is a flashing thing on a wall that no longer means
 * anything, which is how a board teaches people to ignore it.
 *
 * A multiple of the 1.4s beat, so the window closes ON a beat rather than
 * cutting a flash in half.
 */
export const PIT_ARRIVAL_NOTICE_MS = 42_000; // 30 beats

/**
 * Whether the board should be shouting "find your name, stand on your square".
 *
 * Fires on ARRIVAL, not on the whole of holding: the trigger is the send stamp
 * (`holding.atMs`), so it starts the moment staff press send and ages out on its
 * own. Deliberately pure and clock-driven rather than a mounted timer — this
 * screen runs for weeks, two boards must agree without talking, and a board that
 * reboots mid-window rejoins the window instead of restarting it.
 *
 * It survives the HOLD rail (karts rolling in) on purpose: the squares are
 * exactly where a group waits while that clears, so "stand on your square" is
 * MORE useful then, not less. It stops at the green flag, when the group is in
 * the karts and the instruction is finished.
 */
export function pitArrivalNoticeVisible(input: {
  /** `holding.atMs` — when staff sent them. Null when nobody is in holding. */
  holdingAtMs: number | null;
  nowMs: number;
  /** The rail's own verdict, so this can never contradict the rail. */
  rail: PitRailKind;
}): boolean {
  if (input.holdingAtMs == null) return false;
  if (input.rail === "racing" || input.rail === "info") return false;
  const age = input.nowMs - input.holdingAtMs;
  // A negative age means the send stamp is in this screen's future — a clock
  // skew, not an arrival. Showing it would flash for the whole skew.
  if (age < 0) return false;
  return age < PIT_ARRIVAL_NOTICE_MS;
}
