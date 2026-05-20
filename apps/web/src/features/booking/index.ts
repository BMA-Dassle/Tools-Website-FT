/**
 * Public surface of the booking feature.
 *
 * Route handlers / components / api routes import from "~/features/booking"
 * (NOT from individual subpaths) so the public API stays curated and
 * refactors inside the feature don't ripple out.
 */
export type { Activity, Brand, CenterCode, ContactInfo, BookingStatus } from "./types";

export {
  emptySession,
  getActiveItem,
  getItem,
  getPartyMember,
  hasKbfItem,
  newItem,
  newKbfIdentity,
  newPartyMember,
} from "./state/types";
export type {
  AttractionItem,
  BookingItem,
  BookingSession,
  BowlingItem,
  KbfIdentityState,
  KbfItem,
  PartyMember,
  RaceHeatAssignment,
  RaceItem,
  SessionItem,
} from "./state/types";

export { EMPTY_ENTRY_CONTEXT } from "./state/entry-context";
export type { EntryContext, KnownPartyMember, PromoContext } from "./state/entry-context";

export { reducer } from "./state/machine";
export type { Action } from "./state/machine";

export { STEP_REGISTRY } from "./state/steps";
export type { StepDef } from "./state/steps";

export { bookingKeys } from "./queries";
export { ActivitySchema, ContactInfoSchema } from "./schemas";
export type { ActivityInput } from "./schemas";

export { getService } from "./service";
export type { BookingService, BookingQuote } from "./service";

export {
  allOfferings,
  crossSellFor,
  effectiveBrand,
  findOffering,
  intersectCenters,
  offeringsAt,
  squareBookingActivity,
} from "./activities-catalog";
export type { ActivityOffering, OfferingBrand } from "./activities-catalog";

export { isMockMode, squareAdapter } from "./data";
export type { Vendor } from "./data/mock-mode";
export type { SquareAdapter, SquareOrder } from "./data/square";
