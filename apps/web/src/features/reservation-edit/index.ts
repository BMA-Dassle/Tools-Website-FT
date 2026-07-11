/**
 * Reservation-edit engine — public surface.
 * Spec: tasks/future/reservation-editing-plan.md (approved 2026-07-11).
 */

export * from "./types";
export { selectPhase, assertEditable } from "./guards";
export type { PhaseFacts, EditabilityFacts, SquareOrderState } from "./guards";
export { canonicalJson, planHash } from "./hash";
export {
  resolveBookedPricing,
  repriceBowling,
  repriceKbfExtras,
  repriceRaceDelta,
  repriceComboRacers,
} from "./reprice";
export type {
  ResolvedBookedPricing,
  BowlingRepriceResult,
  RaceRepriceDelta,
  ComboRepriceResult,
} from "./reprice";
