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

export interface LaneGroupEvidence {
  webOfferId: number;
  lanes: number[];
  /** How many reservations contributed. Low counts mean a narrow observed set that is
   *  probably narrower than the real group — treat as weak. */
  samples: number;
  /** True when we have enough evidence to restrict placement to these lanes. */
  confident: boolean;
}

/** Below this many observed reservations, an offer's lane set is not trustworthy as a
 *  restriction — we would fence ourselves into whatever lanes happened to get used. */
export const MIN_SAMPLES_FOR_CONFIDENCE = 25;

/**
 * offer -> lanes it has been observed using.
 *
 * Dead reservations are excluded: a canceled booking still tells us the offer was
 * *allowed* there, but including them adds noise from mis-bookings that were undone.
 */
export function deriveLaneGroups(
  reservations: readonly Reservation[],
): Map<number, LaneGroupEvidence> {
  const lanesByOffer = new Map<number, Set<number>>();
  const samplesByOffer = new Map<number, number>();

  for (const r of reservations) {
    if (r.Status === "Canceled" || r.Status === "NoShow") continue;
    const offer = r.WebOffer?.Id;
    if (offer == null) continue;
    samplesByOffer.set(offer, (samplesByOffer.get(offer) ?? 0) + 1);
    let set = lanesByOffer.get(offer);
    if (!set) {
      set = new Set();
      lanesByOffer.set(offer, set);
    }
    for (const l of r.Lanes ?? []) set.add(l.LaneNumber);
  }

  const out = new Map<number, LaneGroupEvidence>();
  for (const [offer, set] of lanesByOffer) {
    const samples = samplesByOffer.get(offer) ?? 0;
    out.set(offer, {
      webOfferId: offer,
      lanes: [...set].sort((a, b) => a - b),
      samples,
      confident: samples >= MIN_SAMPLES_FOR_CONFIDENCE,
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

/** Convert evidence into the plain map `sweepDay` takes. */
export function toLaneGroupMap(groups: Map<number, LaneGroupEvidence>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [offer, g] of groups) {
    if (g.confident) out.set(offer, g.lanes);
  }
  return out;
}
