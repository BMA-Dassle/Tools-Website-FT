/**
 * The CLIENT-SAFE door into this sub.
 *
 * `index.ts` is a SERVER barrel: it re-exports `readLaneGrid` (→ `@/lib/redis`
 * → ioredis) and `readHeats` / `findLeadForAvailability` (→ bmi-office →
 * `node:crypto`, → `@ft/db`). One barrel import from a `"use client"` module is
 * enough to drag that whole graph into the browser bundle, and the production
 * build then dies with "Module not found: Can't resolve 'dns' / 'fs' / 'net' /
 * 'tls'" — which is exactly what happened to this branch at `fbfc8a7`
 * (2026-09-13 15:11, brief §5.7b). `tsc`, vitest, eslint and the a11y gate all
 * pass through that error without noticing; only `next build` traces the client
 * graph.
 *
 * So every client component in `components/features/crm/availability/` imports
 * THIS file (or `./contracts`, `./schemas`, `./queries` by path) and never
 * `~/features/crm/availability`. Nothing re-exported here may import a
 * transport, Redis, Neon or `node:*` — `engine.ts` and `request.ts` are pure by
 * construction and `pure.build.test.ts` pins that they stay that way.
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
  DEFAULT_CENTRE,
  DEFAULT_DURATION_MIN,
  DEFAULT_GUESTS,
  DEFAULT_START_MIN,
  resolveRequest,
  snapToSlot,
  type RequestQuery,
} from "./service/request";
