/**
 * Public surface of the booking feature.
 *
 * Route handlers / components / api routes import from "~/features/booking"
 * (NOT from individual subpaths) so the public API stays curated and
 * refactors inside the feature don't ripple out.
 */
export { DEFAULT_ACTIVITY_BY_BRAND } from "./types";
export type { Activity, Brand, CenterCode, ContactInfo, BookingStatus } from "./types";

export { emptyDraft } from "./state/types";
export type {
  Draft,
  RaceDraft,
  RacePackDraft,
  AttractionDraft,
  BowlingDraft,
  KbfDraft,
} from "./state/types";

export { reducer } from "./state/machine";
export type { Action, BookingState } from "./state/machine";

export { STEP_REGISTRY } from "./state/steps";
export type { StepDef } from "./state/steps";

export { bookingKeys } from "./queries";
export { ActivitySchema, ContactInfoSchema } from "./schemas";
export type { ActivityInput } from "./schemas";

export { getService } from "./service";
export type { BookingService, BookingQuote } from "./service";

export { isMockMode, squareAdapter } from "./data";
export type { Vendor } from "./data/mock-mode";
export type { SquareAdapter, SquareOrder } from "./data/square";
