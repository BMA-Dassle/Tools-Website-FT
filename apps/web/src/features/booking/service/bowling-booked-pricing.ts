/**
 * Booked-pricing stamp for bowling/KBF reservations.
 *
 * bowling_reservations rows historically persist only the priced LINES plus
 * player_count — not HOW the primary line's quantity was derived (per-lane vs
 * per-person × durationMultiplier). That derivation lives in the wizard
 * (BowlingOfferStep.buildLineItems: `isPerLane = exp.kind === "hourly" ||
 * exp.slug.startsWith("pizza-bowl")`), which makes later REPRICING (the
 * reservation-edit flow) ambiguous whenever laneCount === playerCount.
 *
 * This module stamps the answer into booking_metadata.bowling AT CAPTURE so
 * the edit repricer never has to guess. The predicate here must stay in
 * lockstep with BowlingOfferStep.buildLineItems and combo-booking.ts.
 */

import type { BowlingItem, KbfItem } from "~/features/booking/state/types";

export type BowlingPricingMode = "per_lane" | "per_person";

/** Shape persisted at booking_metadata.bowling. */
export interface BowlingBookedPricingStamp {
  experienceSlug: string | null;
  laneCount: number;
  /** Square line-item multiplier for the primary bowling product (hourly 2h = 2). */
  durationMultiplier: number;
  pricingMode: BowlingPricingMode;
}

/**
 * The one predicate — same truth as BowlingOfferStep.tsx / combo-booking.ts:
 * hourly rentals and Pizza Bowl price per LANE; everything else (Fun 4 All,
 * KBF, VIP per-person experiences) prices per PERSON.
 */
export function bowlingPricingMode(params: {
  /** Experience kind ("hourly") or the item's variant — either signals hourly. */
  hourly: boolean;
  experienceSlug: string | null | undefined;
}): BowlingPricingMode {
  return params.hourly || (params.experienceSlug ?? "").startsWith("pizza-bowl")
    ? "per_lane"
    : "per_person";
}

/** Build the stamp from a v2 session item (unified-reserve path). */
export function bowlingBookedPricingStamp(item: BowlingItem | KbfItem): BowlingBookedPricingStamp {
  const hourly = item.kind === "bowling" && item.variant === "hourly";
  return {
    experienceSlug: item.experienceSlug ?? null,
    laneCount: item.laneCount,
    durationMultiplier: item.durationMultiplier,
    pricingMode:
      item.kind === "kbf"
        ? "per_person"
        : bowlingPricingMode({ hourly, experienceSlug: item.experienceSlug }),
  };
}
