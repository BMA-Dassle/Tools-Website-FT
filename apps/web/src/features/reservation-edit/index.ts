/**
 * Reservation-edit engine — public surface.
 * Spec: tasks/future/reservation-editing-plan.md (approved 2026-07-11).
 */

// BROWSER-SAFE surface only: types + pure logic. The admin modal imports
// types through this barrel, so nothing here may pull in Neon/Redis/node
// crypto. Server modules are imported BY PATH:
//   ~/features/reservation-edit/plan      (buildEditPlan — DB + Square reads)
//   ~/features/reservation-edit/service   (executeEditCascade — the executor)
//   ~/features/reservation-edit/hash      (planHash — node crypto)
//   ~/features/reservation-edit/pay-link  (HMAC links — node crypto)
export * from "./types";
export {
  selectPhase,
  assertEditable,
  isPreDecreaseOnlyPlan,
  isRefundOnlyPlan,
  managerWarningCodes,
  missingAcknowledgements,
  PRE_DECREASE_FLAG,
} from "./guards";
export type { PhaseFacts, EditabilityFacts, SquareOrderState } from "./guards";
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
