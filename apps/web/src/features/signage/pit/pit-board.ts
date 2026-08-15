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
 * `racing` is the group out on track — and once its finish marker lands the
 * lane is LIVE (karts rolling back in) until staff explicitly mark it pitted.
 * Both halves are per-session facts; the resolution from stored state +
 * start/finish markers happens server-side in lane.server.ts.
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
  racing: {
    sessionId: string;
    heatNumber: number | null;
    /** The venue's own end signal (race-finish marker). Null while racing. */
    finishedAtMs: number | null;
    /** Staff pressed "race returned" — the karts are fully back in the pit.
     *  THIS is what releases the hold, never a timer (owner 2026-08-13). */
    pittedAtMs: number | null;
  } | null;
}

export type PitLanes = Record<"blue" | "red" | "mega", PitLaneFeed>;

export const EMPTY_PIT_LANE: PitLaneFeed = { holding: null, racing: null };

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
  /** The racing group's finish marker, if their race has ended. */
  racingFinishedAtMs: number | null;
  /** When staff last marked the lane pitted. */
  pittedAtMs: number | null;
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
  const holdLive =
    input.racingFinishedAtMs != null &&
    (input.pittedAtMs == null || input.pittedAtMs < input.racingFinishedAtMs);
  if (holdLive) return "hold";
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
