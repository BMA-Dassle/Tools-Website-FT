/**
 * Lane arrangement — the solver. Pure.
 *
 * Two entry points, ONE operation underneath: re-solve the board.
 *   - `chooseLanes`  — place one reservation (same-day create, or the live chooser)
 *   - `sweepDay`     — re-place every movable reservation on a day (morning + rolling cron)
 *
 * A create is just a sweep with one new reservation added, which is why they share the
 * scoring path rather than being two systems.
 */
import { byReservation, freeLanes, isMovable, pairOf, wholePairSets } from "./grid";
import { candidateLanes, explain, scorePlacement, spreadBias } from "./score";
import type {
  BusyInterval,
  LaneGrid,
  LanePolicy,
  Placement,
  PlanRequest,
  ProposedMove,
} from "./types";

/**
 * Candidate lane sets of size k, drawn from the lanes free for the window.
 *
 * A multi-lane set must be contiguous AND start on an odd lane, so it takes whole pairs.
 * See `wholePairSets` for why both halves of that are hard constraints rather than
 * preferences — one is a vendor 400, the other is the owner's rule.
 *
 * This used to fall back to non-contiguous sets "so a big group still gets placed rather
 * than refused". That was wrong on its own terms: a scattered set is not a placement, it
 * is a 400, and the group ends up fail-open anyway — three wasted round-trips later.
 */
export function enumerateCandidates(free: number[], k: number): number[][] {
  return wholePairSets(free, k);
}

/** Rank every viable placement for one request, best first. */
export function chooseLanes(
  grid: LaneGrid,
  req: PlanRequest,
  policy: LanePolicy,
): { best: Placement | null; ranked: Placement[]; reason: string } {
  const free = candidateLanes(grid, req);
  const candidates = enumerateCandidates(free, req.laneCount);
  if (!candidates.length) {
    return { best: null, ranked: [], reason: "no lane set free for the whole window" };
  }
  // One bias for the whole request — it depends on the window, not the candidate, and
  // recomputing it per candidate is the expensive part of scoring.
  const bias = spreadBias(grid, req, policy);
  const ranked = candidates
    .map((lanes) => scorePlacement(grid, req, lanes, policy, bias))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  return { best, ranked, reason: best ? explain(grid, req, best, policy) : "no candidate scored" };
}

/** A grid with a given set of reservations removed and a set of synthetic intervals added. */
function withBusy(grid: LaneGrid, busy: BusyInterval[]): LaneGrid {
  return { ...grid, busy };
}

/** Placement difficulty — hardest first, so big parties claim their runs before singles
 *  fragment the house. Ties break earliest-start so the day fills forward. */
function byDifficulty(a: BusyInterval[], b: BusyInterval[]): number {
  if (b.length !== a.length) return b.length - a.length;
  return a[0].startMs - b[0].startMs;
}

export interface SweepOptions {
  /** Only consider reservations starting inside this window. */
  fromMs: number;
  toMs: number;
  /** Lane group per web offer; missing entry = any lane. */
  laneGroups?: Map<number, number[]>;
  /** Wall clock for the sweep — reservations starting sooner than `freezeMinutes` are left
   *  alone so a move can't race the front desk setting a lane up. */
  nowMs?: number;
  freezeMinutes?: number;
  /**
   * BACKTEST ONLY. Ignore lifecycle state when deciding what is movable.
   *
   * A day that has already happened comes back with every lane `Completed`, so the normal
   * rules freeze the whole board and the sweep proposes nothing. Replaying "what would the
   * morning run have done?" needs those reservations treated as the bookings they were at
   * planning time. Blocks (league / maintenance / non-bookable) stay frozen either way —
   * they were never ours to move. Never set this on a live path.
   */
  replayHistoric?: boolean;
}

/**
 * Re-solve a day: propose moves that improve the board.
 *
 * Frozen occupancy (leagues, maintenance, running lanes, checked-in groups) is held fixed
 * and every movable reservation is re-placed hardest-first against it. A move is only
 * proposed when it beats staying put by more than `policy.moveCost`, so the sweep does not
 * churn the board for a rounding difference.
 */
export function sweepDay(
  grid: LaneGrid,
  policy: LanePolicy,
  opts: SweepOptions,
): { moves: ProposedMove[]; considered: number; frozen: number } {
  const groups = byReservation(grid);
  const freezeMs = (opts.freezeMinutes ?? 90) * 60_000;
  const nowMs = opts.nowMs ?? Date.now();

  const movable: BusyInterval[][] = [];
  const fixed: BusyInterval[] = [];
  let frozen = 0;

  for (const intervals of groups.values()) {
    const start = Math.min(...intervals.map((i) => i.startMs));
    const inWindow = start >= opts.fromMs && start < opts.toMs;
    const staffPlaced = intervals[0].reservationId.startsWith("C");
    const tooSoon = start - nowMs < freezeMs;
    const lifecycleOk = opts.replayHistoric
      ? !intervals.some((i) => i.isBlock)
      : isMovable(intervals, grid);
    const eligible =
      inWindow && lifecycleOk && !tooSoon && (policy.moveConquerorBookings || !staffPlaced);
    if (eligible) movable.push(intervals);
    else {
      fixed.push(...intervals);
      if (inWindow) frozen++;
    }
  }

  movable.sort(byDifficulty);

  /**
   * Everyone starts where they already are, and each reservation is re-placed against a
   * board holding every OTHER reservation's latest position (`chooseLanes` drops the one
   * being placed via `req.reservationId`).
   *
   * Seeding with only the frozen set instead would let an early reservation claim a lane
   * that a later, un-processed one is sitting on — and if that later one then decided to
   * stay put, two guests would end up on the same lane. Staying put has to be safe by
   * construction, because it is the default and the fallback.
   */
  const placedBusy: BusyInterval[] = [...fixed, ...movable.flat()];
  const indexOfReservation = (id: string) => {
    const idx: number[] = [];
    for (let i = 0; i < placedBusy.length; i++) if (placedBusy[i].reservationId === id) idx.push(i);
    return idx;
  };
  const moves: ProposedMove[] = [];

  for (const intervals of movable) {
    const working = withBusy(grid, placedBusy);
    const head = intervals[0];
    const req: PlanRequest = {
      reservationId: head.reservationId,
      laneCount: intervals.length,
      startMs: Math.min(...intervals.map((i) => i.startMs)),
      endMs: Math.max(...intervals.map((i) => i.endMs)),
      players: intervals.reduce((n, i) => n + i.players, 0),
      webOfferId: head.webOfferId,
      allowedLanes: (head.webOfferId != null && opts.laneGroups?.get(head.webOfferId)) || null,
    };

    const bias = spreadBias(working, req, policy);
    const current = intervals.map((i) => i.laneNumber);
    const currentScore = scorePlacement(working, req, current, policy, bias).score;
    const { best } = chooseLanes(working, req, policy);

    // Staying put is always an option — and the default when nothing clearly beats it.
    const target = best && best.score - currentScore > policy.moveCost ? best.lanes : current;

    if (target.join(",") !== current.join(",")) {
      moves.push({
        reservationId: head.reservationId,
        title: head.title,
        kind: head.kind,
        startMs: req.startMs,
        endMs: req.endMs,
        from: current,
        to: target,
        gain: Math.round(((best?.score ?? 0) - currentScore) * 10) / 10,
        reason: best ? explain(working, req, best, policy) : "",
      });
    }

    // Commit in place — later reservations must see where this one landed, and it must
    // still be exactly one entry per lane so the board never gains phantom occupancy.
    const slots = indexOfReservation(head.reservationId);
    for (let i = 0; i < slots.length; i++) {
      placedBusy[slots[i]] = {
        ...placedBusy[slots[i]],
        laneNumber: target[i] ?? placedBusy[slots[i]].laneNumber,
      };
    }
  }

  return { moves, considered: movable.length, frozen };
}

/**
 * BACKTEST: replay a real day as if we had pinned every one of OUR bookings at create time.
 *
 * The sweep repairs a board that was already built badly; pin-at-create stops it being
 * built badly in the first place. Those are very different amounts of value, and only this
 * replay measures the second one.
 *
 * Honest simulation rules:
 *  - Reservations are placed in the order they were actually CREATED, because at create
 *    time you only know the bookings that came before you. Placing them hardest-first
 *    would be cheating — it uses knowledge of the whole day.
 *  - Front-desk bookings, leagues and maintenance are fixed obstacles from the start.
 *    Slightly pessimistic for us (we avoid lanes that were not yet taken when we booked),
 *    which is the safe direction for a claim about how much better we could have done.
 *  - No `moveCost`: nothing is being moved, every lane is a fresh choice.
 */
export function replayGreenfield(
  grid: LaneGrid,
  policy: LanePolicy,
  opts: Omit<SweepOptions, "replayHistoric">,
): { placed: Map<string, number[]>; unplaced: string[] } {
  const groups = byReservation(grid);
  const ours: BusyInterval[][] = [];
  const fixed: BusyInterval[] = [];

  for (const intervals of groups.values()) {
    const start = Math.min(...intervals.map((i) => i.startMs));
    const inWindow = start >= opts.fromMs && start < opts.toMs;
    const staffPlaced = intervals[0].reservationId.startsWith("C");
    const isBlock = intervals.some((i) => i.isBlock);
    if (inWindow && !isBlock && (policy.moveConquerorBookings || !staffPlaced))
      ours.push(intervals);
    else fixed.push(...intervals);
  }

  // Arrival order — the information we would actually have had.
  ours.sort((a, b) => {
    const ca = a[0].createdAtMs ?? a[0].startMs;
    const cb = b[0].createdAtMs ?? b[0].startMs;
    return ca - cb || a[0].startMs - b[0].startMs;
  });

  const placedBusy: BusyInterval[] = [...fixed];
  const placed = new Map<string, number[]>();
  const unplaced: string[] = [];

  for (const intervals of ours) {
    const working = withBusy(grid, placedBusy);
    const head = intervals[0];
    const req: PlanRequest = {
      reservationId: head.reservationId,
      laneCount: intervals.length,
      startMs: Math.min(...intervals.map((i) => i.startMs)),
      endMs: Math.max(...intervals.map((i) => i.endMs)),
      players: intervals.reduce((n, i) => n + i.players, 0),
      webOfferId: head.webOfferId,
      allowedLanes: (head.webOfferId != null && opts.laneGroups?.get(head.webOfferId)) || null,
    };
    const { best } = chooseLanes(working, req, policy);
    // No candidate means the house was genuinely full for that window — in production this
    // is the fail-open case where we send no `Lanes` and let QAMF decide.
    const target = best?.lanes ?? intervals.map((i) => i.laneNumber);
    if (!best) unplaced.push(head.reservationId);
    placed.set(head.reservationId, target);
    for (let i = 0; i < intervals.length; i++) {
      placedBusy.push({ ...intervals[i], laneNumber: target[i] ?? intervals[i].laneNumber });
    }
  }

  return { placed, unplaced };
}

export interface DaySimulation {
  /** Final lane assignment for every reservation the simulation moved or placed. */
  placed: Map<string, number[]>;
  /** Moves the morning sweep proposed over the pre-booked set. */
  sweepMoves: ProposedMove[];
  /** Reservations pinned at create because they were booked the same day. */
  pinned: string[];
  /** Reservations left exactly where QAMF put them — booked in advance. */
  leftToQamf: string[];
  /**
   * Same-day bookings the policy rejected, seated on whatever was genuinely free — the
   * fail-open path, where production drops `Lanes` and lets QAMF choose.
   */
  failedOpen: string[];
  /**
   * Same-day bookings that could not be seated at all, because the arrangement had already
   * committed every lane free for their window. Excluded from the simulated board entirely —
   * a booking is never stacked onto an occupied lane to keep the tally looking complete.
   */
  unplaced: string[];
}

/**
 * BACKTEST: replay a day the way the system is ACTUALLY designed to run.
 *
 * `replayGreenfield` re-places every booking at create time, which models "pin everything"
 * — an architecture we deliberately rejected, because a lane chosen fourteen days out is
 * optimised against a board that is essentially empty and bears no relation to the day that
 * eventually happens. Measuring that and calling it "pin at create" flatters or maligns the
 * real design depending entirely on how much of the book was advance-booked.
 *
 * What actually runs:
 *   1. Anything booked for a FUTURE date keeps whatever lane QAMF gave it. No pin.
 *   2. A morning sweep re-solves the board that is known at open.
 *   3. Same-day bookings are pinned as they arrive, in creation order, against the board as
 *      it stood at that moment — which is all the information the real system would have.
 *
 * Only reservations created during the operating day count as same-day. `dayStartMs` is
 * that boundary.
 */
export function simulateDay(
  grid: LaneGrid,
  policy: LanePolicy,
  opts: Omit<SweepOptions, "replayHistoric"> & {
    dayStartMs: number;
    /** Re-solve the pre-booked board at open. Default true. `false` = same-day pins only,
     *  which is the FastTrax pilot: nothing already booked is ever moved. */
    sweepAdvance?: boolean;
  },
): DaySimulation {
  const groups = byReservation(grid);
  const advance: BusyInterval[][] = [];
  const sameDay: BusyInterval[][] = [];
  const fixed: BusyInterval[] = [];

  for (const intervals of groups.values()) {
    const start = Math.min(...intervals.map((i) => i.startMs));
    const inWindow = start >= opts.fromMs && start < opts.toMs;
    const staffPlaced = intervals[0].reservationId.startsWith("C");
    const isBlock = intervals.some((i) => i.isBlock);
    if (!inWindow || isBlock || (!policy.moveConquerorBookings && staffPlaced)) {
      fixed.push(...intervals);
      continue;
    }
    const created = intervals[0].createdAtMs;
    // No creation stamp means we cannot tell when it was booked — treat it as advance and
    // leave it alone rather than claiming a pin we could not have made.
    if (created != null && created >= opts.dayStartMs) sameDay.push(intervals);
    else advance.push(intervals);
  }

  // ── 1 + 2. The board at open is the advance bookings, then the morning sweep. ──
  //
  // `sweepAdvance: false` is the FastTrax pilot shape (owner decision 2026-08-25): pin the
  // same-day bookings and never touch anything already on the books. It is strictly less
  // invasive — no `moveReservationLanes` call, so no guest's lane changes after they booked,
  // nothing to write back to Neon for a move, and the kiosk-freeze question does not arise.
  const sweepAdvance = opts.sweepAdvance !== false;
  const preBoard = withBusy(grid, [...fixed, ...advance.flat()]);
  const sweep = sweepAdvance
    ? sweepDay(preBoard, policy, { ...opts, replayHistoric: true })
    : { moves: [] as ProposedMove[], considered: 0, frozen: 0 };
  const placed = new Map<string, number[]>();
  const moveById = new Map(sweep.moves.map((m) => [m.reservationId, m.to]));

  const board: BusyInterval[] = [...fixed];
  for (const intervals of advance) {
    const target = moveById.get(intervals[0].reservationId);
    if (target) placed.set(intervals[0].reservationId, target);
    intervals.forEach((b, i) => board.push({ ...b, laneNumber: target?.[i] ?? b.laneNumber }));
  }

  // ── 3. Same-day arrivals, in the order they actually came in. ──
  sameDay.sort((a, b) => (a[0].createdAtMs ?? 0) - (b[0].createdAtMs ?? 0));
  const pinned: string[] = [];
  const failedOpen: string[] = [];
  const unplaced: string[] = [];

  for (const intervals of sameDay) {
    const head = intervals[0];
    const working = withBusy(grid, board);
    const req: PlanRequest = {
      reservationId: head.reservationId,
      laneCount: intervals.length,
      startMs: Math.min(...intervals.map((i) => i.startMs)),
      endMs: Math.max(...intervals.map((i) => i.endMs)),
      players: intervals.reduce((n, i) => n + i.players, 0),
      webOfferId: head.webOfferId,
      allowedLanes: (head.webOfferId != null && opts.laneGroups?.get(head.webOfferId)) || null,
    };
    const { best } = chooseLanes(working, req, policy);
    if (best) {
      pinned.push(head.reservationId);
      placed.set(head.reservationId, best.lanes);
      intervals.forEach((b, i) => board.push({ ...b, laneNumber: best.lanes[i] ?? b.laneNumber }));
      continue;
    }

    // FAIL OPEN, modelled honestly. The policy liked nothing, so production sends no `Lanes`
    // and QAMF seats the party wherever it is genuinely free. Its HISTORIC lane is not
    // automatically available any more — our own sweep may have moved somebody onto it — so
    // falling back to that lane unconditionally scores a board that cannot exist. Two parties
    // on one lane is the exact defect this simulation is meant to expose, not to manufacture.
    const open = freeLanes(working, req.startMs, req.endMs, head.reservationId, req.allowedLanes);
    const historic = intervals.map((i) => i.laneNumber);
    const target = historic.every((l) => open.includes(l))
      ? historic
      : open.slice(0, intervals.length);

    if (target.length < intervals.length) {
      // Genuinely nowhere to seat them: the arrangement has over-committed the house. Leave
      // the booking OFF the board rather than double-booking a lane to keep the tally whole.
      unplaced.push(head.reservationId);
      continue;
    }

    failedOpen.push(head.reservationId);
    placed.set(head.reservationId, target);
    intervals.forEach((b, i) => board.push({ ...b, laneNumber: target[i] ?? b.laneNumber }));
  }

  return {
    placed,
    sweepMoves: sweep.moves,
    pinned,
    leftToQamf: advance.map((i) => i[0].reservationId),
    failedOpen,
    unplaced,
  };
}

/** Pairs touched by a set of moves — the blast radius of applying them. */
export function affectedPairs(moves: ProposedMove[]): number[] {
  const pairs = new Set<number>();
  for (const m of moves) {
    for (const l of [...m.from, ...m.to]) pairs.add(pairOf(l));
  }
  return [...pairs].sort((a, b) => a - b);
}
