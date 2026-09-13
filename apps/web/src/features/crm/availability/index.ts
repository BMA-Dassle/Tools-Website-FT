/**
 * `~/features/crm/availability` — lane and heat availability (C4).
 *
 * The only door into this sub: routes and other subs import THIS file, never a
 * deep path (§3.2). Read-only end to end — the engine decides, the transports
 * read QAMF and Office, and nothing here books anything. Holding lanes is the
 * builder's job (C5) and arrives as a link, not a write.
 */

export {
  ALTERNATE_MAX_OFFSET_MIN,
  ALTERNATE_STEP_MIN,
  EVENING_CLOSE_MIN,
  EVENING_OPEN_MIN,
  GUESTS_PER_LANE,
  LANE_SECTIONS,
  MAX_ALTERNATES,
  SLOT_MINUTES,
  VIP_SECTION_NAME,
  alternateWindows,
  bestRun,
  blockAtSlot,
  boundsFor,
  clampBlocks,
  evaluate,
  fmtMin,
  laneFreeIn,
  lanesNeeded,
  mergeAdjacent,
  parseClockMinutes,
  pctOf,
  sectionRuns,
  slotsBetween,
  ticksBetween,
  type Alternate,
  type BestRun,
  type DayBounds,
  type LaneBlock,
  type LaneOccupancy,
  type LaneSection,
  type OccupancyKind,
  type RequestWindow,
  type SectionRuns,
  type Verdict,
} from "./service/engine";

export {
  AVAILABILITY_CACHE_PREFIX,
  AVAILABILITY_CACHE_SECONDS,
  MAX_SESSION_MINUTES,
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

export {
  DEFAULT_CENTRE,
  DEFAULT_DURATION_MIN,
  DEFAULT_GUESTS,
  DEFAULT_START_MIN,
  resolveRequest,
  snapToSlot,
  type RequestQuery,
} from "./service/request";

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
