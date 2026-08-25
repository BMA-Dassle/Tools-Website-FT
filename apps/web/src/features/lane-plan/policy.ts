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
import { byReservation, isMovable, pairOf } from "./grid";
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
 * For k > 1 only contiguous sets are offered — a party's lanes must sit together — and
 * we fall back to non-contiguous sets only when nothing contiguous exists, so a big group
 * still gets placed rather than refused.
 */
export function enumerateCandidates(free: number[], k: number): number[][] {
  if (k <= 0) return [];
  if (k === 1) return free.map((l) => [l]);

  const contiguous: number[][] = [];
  for (let i = 0; i + k <= free.length; i++) {
    const window = free.slice(i, i + k);
    if (window[k - 1] - window[0] === k - 1) contiguous.push(window);
  }
  if (contiguous.length) return contiguous;

  // Nothing contiguous — offer the tightest spans available so the group at least lands
  // near itself. Bounded so a fragmented house can't blow up the search.
  const loose: number[][] = [];
  for (let i = 0; i + k <= free.length && loose.length < 200; i++) {
    loose.push(free.slice(i, i + k));
  }
  return loose;
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

/** Pairs touched by a set of moves — the blast radius of applying them. */
export function affectedPairs(moves: ProposedMove[]): number[] {
  const pairs = new Set<number>();
  for (const m of moves) {
    for (const l of [...m.from, ...m.to]) pairs.add(pairOf(l));
  }
  return [...pairs].sort((a, b) => a - b);
}
