/**
 * `~/features/crm/availability` — lane and heat availability (C4).
 *
 * The only door into this sub: routes and other subs import THIS file, never a
 * deep path (§3.2). Read-only end to end — the engine decides, the transports
 * read QAMF and Office, and nothing here books anything. Holding lanes is the
 * builder's job (C5) and arrives as a link, not a write.
 */

/**
 * The pure engine and request helpers, in one place so `pure.ts` (what the
 * client components import) and this server barrel cannot drift apart.
 */
export * from "./pure";

export {
  AVAILABILITY_CACHE_PREFIX,
  AVAILABILITY_CACHE_SECONDS,
  MAX_SESSION_MINUTES,
  OUT_OF_SERVICE_LABEL,
  classifyKind,
  blockLabel,
  etDayBoundsMs,
  laneSectionsFor,
  occupancyMap,
  projectBusy,
  readLaneGrid,
  type LaneGridProjection,
  type LaneGridResult,
} from "./service/qamf-grid";

export {
  HEATS_CACHE_PREFIX,
  HEATS_CACHE_SECONDS,
  MAX_CONSECUTIVE_HEATS,
  firstRunOfHeats,
  heatsNeeded,
  projectPlanning,
  readHeats,
  type HeatBlock,
  type HeatResource,
  type HeatsProjection,
  type HeatsResult,
} from "./service/heats";

export { findLeadForAvailability } from "./data/lead-lookup";

export {
  AvailabilityQuerySchema,
  DURATIONS,
  HeatsQuerySchema,
  type AvailabilityQuery,
  type HeatsQuery,
} from "./schemas";

export {
  AVAILABILITY_HOLD_LABEL,
  AVAILABILITY_TEST_IDS,
  type AvailabilityAlternate,
  type AvailabilityBounds,
  type AvailabilityLead,
  type AvailabilityPlacement,
  type AvailabilityRequest,
  type AvailabilityResponse,
  type AvailabilitySection,
  type AvailabilitySource,
  type HeatsResponse,
} from "./contracts";

export { availabilityKeys, type AvailabilityKeyParts } from "./queries";
