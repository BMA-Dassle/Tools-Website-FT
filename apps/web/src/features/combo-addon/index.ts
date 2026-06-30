/**
 * combo-addon — public surface. Post-booking "add more guests" to a completed
 * combo special (confirmation-page self-service). Registry-driven; gated by
 * `combo.addon.enabled` + the NEXT_PUBLIC_COMBO_ADDON_ENABLED flag.
 */
export type {
  AddGuest,
  AddOnContext,
  AddOnCapacity,
  AddOnQuote,
  AddOnOrderGroup,
  AddOnResult,
  AddOnRaceLeg,
  AddOnBowlingAnchor,
} from "./types";
export { buildAddOnQuote, addonOrderGroups } from "./pricing";
export { checkAddOnCapacity, lanePlan, seatsOnExistingLanes, type CapacityDeps } from "./capacity";
export {
  addGuestSchema,
  addOnQuoteRequestSchema,
  addOnPurchaseRequestSchema,
  type AddOnQuoteRequest,
  type AddOnPurchaseRequest,
} from "./schemas";
