/**
 * Lane arrangement — placement scoring. Pure.
 *
 * The owner's rule, stated directly:
 *   "people hate being right next to each other, so single lanes when we're dead you
 *    might spread those out one per pair, but after you get 8 of those on 16 lanes you
 *    get limited supply, so you start backfilling and saving the other 8 for bigger
 *    reservations."
 *
 * Three terms carry that whole sentence:
 *   - MATE occupancy   — the real "next to each other" pain (shared settee + ball return)
 *   - WHOLE FREE PAIRS — the inventory a bigger reservation needs
 *   - SPREAD BIAS      — the dial between them, driven by FORECAST occupancy
 *
 * The pain is the pair-mate, not the numeric neighbour. Lane 5 with lane 6 busy means
 * sharing a settee with strangers. Lane 6 with lane 7 busy is a different pair entirely —
 * adjacent on the floor, but its own seating. So mate weight >> flank weight.
 */
import {
  freeLanes,
  gapFit,
  isLaneFree,
  isTruePair,
  mateOf,
  pairOf,
  projectedOccupancy,
  slivers,
  wholeFreePairs,
} from "./grid";
import type { LaneGrid, LanePolicy, Placement, PlanRequest } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * -1 … +1. Positive = spread out, negative = pack tight and preserve whole pairs.
 *
 * This is the owner's rule, and it is about PAIR INVENTORY, not an occupancy percentage:
 *
 *   "single lanes when we're dead you might spread those out one per pair, but after you
 *    get 8 of those on 16 lanes you get limited supply, so you start backfilling and
 *    saving the other 8 for bigger reservations."
 *
 * Spread while whole free pairs are plentiful; backfill as they run out. That much is
 * self-correcting from the observed board — once no fresh pair exists, no candidate can
 * offer one.
 *
 * The forecast's job is narrower than it first appears: stop us spending the LAST few
 * fresh pairs at 2pm on a session that will still be sitting there at 8pm when a bigger
 * group walks in. It contributes only a reserve — how many pairs to hold back for demand
 * that has not arrived yet — derived from how much more occupancy this weekday usually
 * gains beyond what is currently on the board.
 *
 * On a complete board (a retro backtest, or a same-day booking at 9pm) the forecast adds
 * nothing, because there is no unseen demand left. That is correct, and it means the
 * backtest measures the policy rather than the forecast.
 */
/**
 * Whole pairs this offer can actually be sold on.
 *
 * A pair counts only when BOTH its lanes are inside the offer's section — which is exactly
 * how `wholeFreePairs` counts the free ones, so supply and capacity are finally measured in
 * the same unit.
 */
export function sellablePairs(grid: LaneGrid, allowed: readonly number[] | null): number {
  const pool = allowed && allowed.length ? new Set(allowed) : new Set(grid.lanes);
  const seen = new Set<number>();
  let count = 0;
  for (const lane of pool) {
    const p = pairOf(lane);
    if (seen.has(p)) continue;
    seen.add(p);
    if (pool.has(mateOf(lane))) count++;
  }
  return count;
}

export function spreadBias(grid: LaneGrid, req: PlanRequest, policy: LanePolicy): number {
  // EVERYTHING HERE IS MEASURED IN THE OFFER'S SECTION, NOT THE WHOLE HOUSE.
  //
  // It used to mix the two: `fresh` counted free pairs inside `allowedLanes`, but the scale
  // it was divided by came from `grid.lanes.length` — all 28 lanes at Fort Myers, 14 pairs.
  // A Regular booking can only ever use 8 of those pairs and a VIP one 4, so the ratio was
  // a section's supply over the whole house's capacity: two different units.
  //
  // The effect is that the dial read LOW for any restricted offer — it behaved as though
  // the house were fuller than it was and backfilled sooner than the policy intends. At its
  // sharpest, a VIP booking at Fort Myers could NEVER see a full-spread signal even with the
  // entire VIP section empty: 4 free pairs over a span built from 14 tops out at 0.82.
  // Old Time (lanes 1-4, two pairs) is worse still.
  //
  // Invisible at FastTrax, where one offer covers every lane and section == house — which is
  // exactly why a single-section pilot could never have surfaced it.
  const totalPairs = Math.max(1, sellablePairs(grid, req.allowedLanes));
  const sectionLanes = req.allowedLanes?.length || grid.lanes.length;
  const fresh = wholeFreePairs(grid, req.startMs, req.endMs, req.reservationId, req.allowedLanes);

  // Demand this weekday historically still gains beyond what we can see, in lanes. Scaled to
  // the section on the same assumption the rest of the term makes — that unseen demand
  // arrives in roughly the proportion the sections are sized.
  const { peak, observedPeak } = projectedOccupancy(
    grid,
    req.startMs,
    req.endMs,
    req.reservationId,
  );
  const unseenLanes = Math.max(0, peak - observedPeak) * sectionLanes;
  // Only the multi-lane share of that demand actually needs a WHOLE pair.
  const reserve = Math.min(totalPairs, Math.round((unseenLanes * policy.multiLaneShare) / 2));

  const usable = fresh - reserve;
  // Full spread once a comfortable share of the house is still in whole pairs; the divisor
  // sets how fast the dial swings as they are spent.
  const span = Math.max(1, totalPairs * policy.spreadPairSpan);
  return clamp(usable / span, -1, 1);
}

/** Score one candidate placement. Higher is better. */
export function scorePlacement(
  grid: LaneGrid,
  req: PlanRequest,
  lanes: number[],
  policy: LanePolicy,
  bias?: number,
): Placement {
  const sorted = [...lanes].sort((a, b) => a - b);
  const terms: Record<string, number> = {};
  const sb = bias ?? spreadBias(grid, req, policy);
  const occupied = new Set(sorted);
  const free = (l: number) =>
    grid.lanes.includes(l) &&
    !occupied.has(l) &&
    isLaneFree(grid, l, req.startMs, req.endMs, req.reservationId);

  // ── contiguity ──────────────────────────────────────────────────────────
  // A party's own lanes must sit together. Gaps are close to disqualifying.
  const span = sorted[sorted.length - 1] - sorted[0] + 1;
  terms.contiguity = -policy.contiguity * (span - sorted.length);

  // ── pair integrity ──────────────────────────────────────────────────────
  if (sorted.length === 1) {
    // The mate is the settee neighbour — the term that actually expresses the complaint.
    // Scaled by bias, so under pressure a busy mate becomes PREFERRED (backfill).
    const mate = mateOf(sorted[0]);
    const mateFree = free(mate);
    terms.mate = sb * policy.pairIntegrity * (mateFree ? 1 : -1);
  } else if (sorted.length === 2) {
    // Two lanes for one party belong on one settee. Never traded against pressure.
    terms.pair = isTruePair(sorted[0], sorted[1]) ? policy.pairIntegrity : -policy.pairIntegrity;
  } else {
    // Bigger blocks should start on an odd lane so they align to pair boundaries and
    // don't leave orphaned half-pairs at both ends.
    terms.pairAlign = sorted[0] % 2 === 1 ? policy.pairIntegrity * 0.5 : 0;
  }

  // ── flanks: cross-pair adjacency, the softer half of "not next to strangers" ──
  const left = sorted[0] - 1;
  const right = sorted[sorted.length - 1] + 1;
  let flanksFree = 0;
  if (!grid.lanes.includes(left) || free(left)) flanksFree++;
  if (!grid.lanes.includes(right) || free(right)) flanksFree++;
  terms.flanks = sb * policy.buffer * flanksFree;

  // ── whole free pairs left behind — inventory for bigger reservations ────
  // Weight rises with pressure: when the house is empty, spending a pair is cheap.
  const pairsAfter = wholeFreePairs(
    grid,
    req.startMs,
    req.endMs,
    req.reservationId,
    req.allowedLanes,
    occupied,
  );
  const pressureWeight = 0.3 + 0.7 * clamp(1 - (sb + 1) / 2, 0, 1);
  terms.wholePairs = policy.wholePairs * pressureWeight * pairsAfter;

  // ── time fit: keep some lanes clear long enough to sell a long session ──
  // Owner's rule: fill gaps hard, except when the house is dead. So the reward to sit
  // snug against an existing booking rises as the spread bias falls. On a genuinely quiet
  // afternoon (bias ~1) this contributes nothing and guests still get their space.
  // Quadratic ramp: near zero while there are fresh pairs to spread into, rising sharply
  // as they run out. A linear `(1 - sb) / 2` packed guests together on a quiet afternoon
  // and measurably worsened privacy without buying long-session capacity; `-sb` overshot
  // the other way and only fired when the forecast reserve exceeded free pairs, leaving
  // the term inert on any board without forecast history.
  const fillWeight = clamp(1 - sb, 0, 1) ** 2;
  let touches = 0;
  let stranded = 0;
  for (const lane of sorted) {
    const fit = gapFit(grid, lane, req.startMs, req.endMs, req.reservationId);
    if (fit.before === 0) touches++;
    if (fit.after === 0) touches++;
    stranded += slivers(fit, policy.minSellableMinutes).length;
  }
  terms.timeFit = touches ? policy.timeFit * fillWeight * touches : 0;
  // Stranding a gap nothing fits into is always wrong, at any pressure — a 25-minute hole
  // is dead whether the house is empty or full.
  terms.sliver = stranded ? -policy.sliverPenalty * stranded : 0;

  // ── never place on a lane under maintenance ─────────────────────────────
  terms.errorLanes = sorted.some((l) => grid.errorLanes.has(l)) ? -1e6 : 0;

  const score = Object.values(terms).reduce((a, b) => a + b, 0);
  return { lanes: sorted, score, terms };
}

/**
 * Human-readable reason for a placement — what staff see next to a proposed move.
 * Reports the dominant term rather than dumping the whole vector.
 */
export function explain(
  grid: LaneGrid,
  req: PlanRequest,
  p: Placement,
  policy: LanePolicy,
): string {
  const sb = spreadBias(grid, req, policy);
  const mode = sb > 0.15 ? "spread" : sb < -0.15 ? "backfill" : "balanced";
  const bits: string[] = [];
  if (p.lanes.length === 1) {
    const mateFree = isLaneFree(
      grid,
      mateOf(p.lanes[0]),
      req.startMs,
      req.endMs,
      req.reservationId,
    );
    bits.push(mateFree ? "pair-mate free" : "backfills a used pair");
  } else if (p.lanes.length === 2) {
    bits.push(isTruePair(p.lanes[0], p.lanes[1]) ? "true pair" : "straddles two pairs");
  }
  const pairsLeft = wholeFreePairs(
    grid,
    req.startMs,
    req.endMs,
    req.reservationId,
    req.allowedLanes,
    new Set(p.lanes),
  );
  bits.push(`${pairsLeft} whole pairs left`);
  return `${mode}: ${bits.join(", ")}`;
}

/** Lanes free for the window, restricted to the offer's lane group. */
export function candidateLanes(grid: LaneGrid, req: PlanRequest): number[] {
  return freeLanes(grid, req.startMs, req.endMs, req.reservationId, req.allowedLanes);
}

/** Pair index of each lane in a placement — used by the day view. */
export function placementPairs(lanes: number[]): number[] {
  return [...new Set(lanes.map(pairOf))];
}
