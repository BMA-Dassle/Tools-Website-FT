/**
 * Combo itinerary engine — PURE chain feasibility over an ordered list of
 * legs. Generic by design (owner: "make sure this is usable for other
 * packages we might make in future"): it knows nothing about racing or
 * bowling, only about candidate events per leg and a transition buffer.
 *
 * The wizard supplies, per leg, the day's candidate events (race heats from
 * BMI, lane slots from QAMF — each reduced to a wall-clock start/end). For
 * every candidate of the FIRST leg (the customer's pickable start time) the
 * engine greedily assembles the EARLIEST feasible chain: each subsequent
 * leg's earliest candidate starting at/after the previous leg's end plus
 * the transition buffer. First-leg candidates with no full chain are
 * reported infeasible (the picker renders them disabled).
 *
 * ── Time normalization ──────────────────────────────────────────────
 * BMI heat ISOs are wall-clock-in-Z notation ("…T13:24:00Z" meaning ET wall
 * clock); QAMF bookedAt carries a real ET offset ("…T14:00:00-04:00"). Both
 * centers are ET, so the NAIVE datetime part of either form IS the ET wall
 * clock — `wallClockMs` strips the zone and parses the naive part, making
 * the two vendors' times directly comparable.
 */

export interface LegCandidate<P = unknown> {
  /** Wall-clock epoch ms (zone-stripped — see wallClockMs). */
  startMs: number;
  endMs: number;
  /** Original vendor ISO (kept verbatim for booking calls + display). */
  startIso: string;
  /** Caller's payload (heat block / QAMF slot / …) carried through. */
  payload: P;
}

export interface ChainResult<P = unknown> {
  /** The first-leg candidate this chain anchors on (the pickable start). */
  anchor: LegCandidate<P>;
  /** Full chain INCLUDING the anchor (one entry per leg), or null when no
   *  feasible chain exists from this anchor. */
  chain: LegCandidate<P>[] | null;
}

/** Strip a trailing Z or ±HH:MM offset and parse the naive part as local
 *  time — yields comparable ET wall-clock ms for both BMI and QAMF ISOs. */
export function wallClockMs(iso: string): number {
  const naive = iso.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  return new Date(naive).getTime();
}

/** Wall-clock "1:24 PM" label from either vendor's ISO. */
export function wallClockLabel(iso: string): string {
  const naive = iso.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  return new Date(naive).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Per-leg candidate filters for chain assembly — index-aligned with the legs
 * (entry 0, the anchor leg, is ignored). Lets the schedule-confirm modal
 * offer choices like "Blue or Red for your second race": pass a filter that
 * only admits that track's candidates and see whether a chain still fits.
 */
export type LegFilter<P> = ((c: LegCandidate<P>) => boolean) | null;

/**
 * Greedy-earliest chain from a GIVEN anchor, with optional per-leg filters
 * and per-leg maximum waits. `maxWaitMinutes[i]` (index-aligned with the
 * legs; entry 0 ignored) caps the idle gap before leg i: its pick must start
 * within [prevEnd + transition, prevEnd + maxWait] — e.g. "the lane must
 * start within 60 minutes of the first race" — else the chain is infeasible.
 * Returns the full chain (anchor included) or null when nothing fits.
 *
 * Greedy-earliest stays correct WITH max waits: a candidate inside one leg's
 * window only ever ENDS earlier than a later in-window pick, so it can never
 * push a later leg past its own window.
 */
export function buildChainFrom<P>(
  legCandidates: Array<Array<LegCandidate<P>>>,
  transitionMinutes: number,
  anchor: LegCandidate<P>,
  filters?: Array<LegFilter<P>>,
  maxWaitMinutes?: Array<number | null | undefined>,
): LegCandidate<P>[] | null {
  const transitionMs = transitionMinutes * 60_000;
  const chain: LegCandidate<P>[] = [anchor];
  let prevEnd = anchor.endMs;
  for (let leg = 1; leg < legCandidates.length; leg++) {
    const filter = filters?.[leg] ?? null;
    const maxWait = maxWaitMinutes?.[leg];
    const latestStart = maxWait != null ? prevEnd + maxWait * 60_000 : Number.POSITIVE_INFINITY;
    const next = [...legCandidates[leg]]
      .sort((a, b) => a.startMs - b.startMs)
      .find(
        (c) =>
          c.startMs >= prevEnd + transitionMs && c.startMs <= latestStart && (!filter || filter(c)),
      );
    if (!next) return null;
    chain.push(next);
    prevEnd = next.endMs;
  }
  return chain;
}

/**
 * Assemble the earliest feasible chain for every first-leg candidate.
 *
 * `legCandidates[i]` = the day's candidates for leg i (any order; sorted
 * internally). Greedy-earliest is optimal here: picking the earliest valid
 * candidate for leg i never eliminates a feasible chain that a later pick
 * would allow (all candidates of leg i+1 valid for a later pick are also
 * valid for an earlier one).
 */
export function buildChains<P>(
  legCandidates: Array<Array<LegCandidate<P>>>,
  transitionMinutes: number,
  maxWaitMinutes?: Array<number | null | undefined>,
): Array<ChainResult<P>> {
  if (legCandidates.length === 0) return [];
  const sorted = legCandidates.map((c) => [...c].sort((a, b) => a.startMs - b.startMs));
  return sorted[0].map((anchor) => ({
    anchor,
    chain: buildChainFrom(sorted, transitionMinutes, anchor, undefined, maxWaitMinutes),
  }));
}
