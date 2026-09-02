/**
 * Lane arrangement — deriving each web offer's Conqueror "Lane Group".
 *
 * A web offer is restricted to a lane group configured inside Conqueror, and **no API
 * endpoint returns it**. The only signal is a 409 `LanesNotCompatible` when you try to
 * place outside it. So we learn it the only way available: observe which lanes each offer
 * has actually landed on across a long history window.
 *
 * Verified real: at FM the VIP offers (155/159) only ever touch lanes 5-12, while the
 * general offers (152/154/158) span most of the house; at Naples VIP (119/125) sits on
 * 25-32. Those are genuine groups, not coincidence.
 *
 * This is INFERENCE, so it is used as a preference, never a guarantee — a 409 at write
 * time is expected and handled by trying the next candidate, then failing open.
 */
import type { Reservation } from "@/lib/qamf-bowling";

import { sectionForObservedLanes } from "./sections";

export interface LaneGroupEvidence {
  webOfferId: number;
  /** Lanes that survive the frequency filter — our best guess at the real group. */
  lanes: number[];
  /** Every lane ever seen, with its observation count. Kept so a rejected pin can be
   *  explained ("lane 6 was seen once in 316") rather than just failing. */
  counts: Map<number, number>;
  /** Lanes seen but discarded as noise. */
  outliers: number[];
  /** How many reservations contributed. */
  samples: number;
  /** True when we have enough evidence to restrict placement to these lanes. */
  confident: boolean;
}

/** Below this many observed reservations, an offer's lane set is not trustworthy as a
 *  restriction — we would fence ourselves into whatever lanes happened to get used. */
export const MIN_SAMPLES_FOR_CONFIDENCE = 25;

/**
 * A lane must carry at least this share of the offer's busiest lane to count as part of
 * the group.
 *
 * Presence alone is NOT membership. Verified the hard way 2026-08-25: the engine picked
 * lane 6 for offer 154 because history showed the offer there — and QAMF rejected the
 * create with `409 LanesNotCompatible`. Lane 6 had been seen ONCE in 316 observations,
 * against 9-36 for lanes 13-28. Those strays are reservations staff moved onto a lane
 * inside Conqueror, which does not enforce the web offer's lane group, so they are
 * evidence of a manual override rather than of what the offer may book.
 *
 * 0.10 cleanly separates every offer we have data for: 154 and 158 resolve to 13-28,
 * 155 and 159 to 5-12, each dropping only 1-2 observation strays.
 */
export const MIN_LANE_SHARE_OF_BUSIEST = 0.1;

/** …and an absolute floor, so a thinly-used offer cannot promote a single sighting. */
export const MIN_LANE_OBSERVATIONS = 3;

/**
 * offer -> lanes it has been observed using.
 *
 * Dead reservations are excluded: a canceled booking still tells us the offer was
 * *allowed* there, but including them adds noise from mis-bookings that were undone.
 */
export function deriveLaneGroups(
  reservations: readonly Reservation[],
): Map<number, LaneGroupEvidence> {
  const countsByOffer = new Map<number, Map<number, number>>();
  const samplesByOffer = new Map<number, number>();

  for (const r of reservations) {
    if (r.Status === "Canceled" || r.Status === "NoShow") continue;
    const offer = r.WebOffer?.Id;
    if (offer == null) continue;
    samplesByOffer.set(offer, (samplesByOffer.get(offer) ?? 0) + 1);
    let counts = countsByOffer.get(offer);
    if (!counts) {
      counts = new Map();
      countsByOffer.set(offer, counts);
    }
    for (const l of r.Lanes ?? []) {
      counts.set(l.LaneNumber, (counts.get(l.LaneNumber) ?? 0) + 1);
    }
  }

  const out = new Map<number, LaneGroupEvidence>();
  for (const [offer, counts] of countsByOffer) {
    const samples = samplesByOffer.get(offer) ?? 0;
    const busiest = Math.max(...counts.values(), 0);
    const floor = Math.max(MIN_LANE_OBSERVATIONS, busiest * MIN_LANE_SHARE_OF_BUSIEST);
    const lanes: number[] = [];
    const outliers: number[] = [];
    for (const [lane, n] of counts) (n >= floor ? lanes : outliers).push(lane);
    out.set(offer, {
      webOfferId: offer,
      lanes: lanes.sort((a, b) => a - b),
      counts,
      outliers: outliers.sort((a, b) => a - b),
      samples,
      confident: samples >= MIN_SAMPLES_FOR_CONFIDENCE && lanes.length > 0,
    });
  }
  return out;
}

/**
 * The lane set a placement may use for an offer.
 *
 * Returns `null` (= no restriction, let scoring range over the whole house) when evidence
 * is weak, because an under-observed group would wrongly fence a booking into a handful of
 * lanes. A wrong guess here costs a 409 we recover from; a wrong restriction silently
 * makes every arrangement worse.
 */
export function allowedLanesFor(
  groups: Map<number, LaneGroupEvidence>,
  webOfferId: number | null,
): number[] | null {
  if (webOfferId == null) return null;
  const g = groups.get(webOfferId);
  if (!g || !g.confident) return null;
  return g.lanes;
}

/**
 * Convert evidence into the plain map `sweepDay` takes.
 *
 * Pass a `centerId` and the owner-given SECTIONS take over: history only votes on which
 * section an offer belongs to, and the section's real boundaries become the allowed lanes.
 * That is strictly better than the frequency filter it replaces — a booking staff moved by
 * hand inside Conqueror can cost a vote, but it can no longer widen a group onto a lane the
 * offer cannot be sold on, which is what earned a live 409 on 2026-08-25.
 *
 * Without a centerId, or for an offer whose section cannot be told apart, it falls back to
 * the derived lanes exactly as before.
 */
export function toLaneGroupMap(
  groups: Map<number, LaneGroupEvidence>,
  centerId?: number,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [offer, g] of groups) {
    const section = centerId != null ? sectionForObservedLanes(centerId, g.counts) : null;
    if (section) {
      out.set(offer, [...section.lanes]);
      continue;
    }
    if (g.confident) out.set(offer, g.lanes);
  }
  return out;
}
