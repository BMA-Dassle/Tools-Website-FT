/**
 * The wire contract for the availability routes (C4), beside the sub rather
 * than appended to `core/contracts.ts` so parallel PRs never race on one file's
 * tail. Dependency-free apart from types; client components import it directly.
 *
 * Every time on this wire is MINUTES FROM MIDNIGHT in the centre's own day. No
 * instant crosses this boundary, so nothing downstream can re-interpret an
 * evening in UTC and land it on the next day (memory
 * `project_bookedat_utc_wallclock_sweep`).
 */

import type { ApiOk, CentreSummary } from "~/features/crm/core/contracts";
import type { CentreCode } from "~/features/crm/core/types";
import type { HeatBlock, HeatResource } from "./service/heats";
import type { LaneBlock, LaneOccupancy, OccupancyKind } from "./service/engine";

export type { HeatBlock, HeatResource, LaneBlock, LaneOccupancy, OccupancyKind };

/** The lead a request was seeded from, when the URL named one. */
export interface AvailabilityLead {
  publicId: string;
  title: string;
  centre: CentreCode;
  eventDate: string;
  eventTime: string | null;
  guests: number;
  statusId: string;
}

/** What the request bar is asking for right now. */
export interface AvailabilityRequest {
  centre: CentreCode;
  date: string;
  /** Minutes from midnight, centre-local. */
  start: number;
  dur: number;
  guests: number;
}

export interface AvailabilitySection {
  name: string;
  lanes: number[];
  /** Free lanes for the requested window. */
  free: number;
  /** Contiguous free runs, in lane order. */
  runs: number[][];
}

export interface AvailabilityPlacement {
  section: string;
  /** Exactly `need` lanes, first one odd. */
  lanes: number[];
  /** The whole contiguous run they came from. */
  run: number[];
  startsOdd: boolean;
}

export interface AvailabilityAlternate {
  start: number;
  dur: number;
  placement: AvailabilityPlacement;
}

/** The drawn day, and the hourly ticks on its axis. */
export interface AvailabilityBounds {
  openMin: number;
  closeMin: number;
  ticks: number[];
}

/**
 * `source`:
 *   `lanes`       — a QAMF grid was read and the verdict is real
 *   `heats`       — FastTrax; karting capacity, no lane grid exists
 *   `unavailable` — the vendor could not be reached; `error` says so and the
 *                   screen shows a banner rather than an empty, cheerful grid
 */
export type AvailabilitySource = "lanes" | "heats" | "unavailable";

export type AvailabilityResponse = ApiOk<{
  centre: CentreSummary;
  request: AvailabilityRequest;
  lead: AvailabilityLead | null;
  /** Set when the URL named a lead that no longer exists (or B3 has not landed). */
  leadMissing: boolean;
  source: AvailabilitySource;
  error?: string;
  /** Lanes needed: guests ÷ 6, rounded up. */
  need: number;
  fits: boolean;
  placement: AvailabilityPlacement | null;
  alternates: AvailabilityAlternate[];
  sections: AvailabilitySection[];
  /** Occupancy per lane, already CLAMPED to `bounds` — see the route's note. */
  lanes: LaneOccupancy[];
  bounds: AvailabilityBounds;
  /**
   * How many of the lanes we believe the centre has it actually reported on
   * this read. When they disagree the missing lanes are treated as unavailable
   * and the screen says so, rather than counting the difference as free space.
   */
  lanesReported: number;
  lanesExpected: number;
  /** ISO instant the vendor was read, and whether it came from the 60 s cache. */
  readAt: string;
  cached: boolean;
}>;

export type HeatsResponse = ApiOk<{
  centre: CentreSummary;
  date: string;
  guests: number;
  lead: AvailabilityLead | null;
  leadMissing: boolean;
  source: "heats" | "unavailable";
  error?: string;
  resources: HeatResource[];
  /** The resource the screen is showing, when one was picked or defaulted. */
  selectedResourceId: string | null;
  /** Consecutive heats this party needs on the selected resource. */
  heatsNeeded: number;
  /** The first run of consecutive heats with room, or null. */
  firstRun: HeatBlock[] | null;
  readAt: string;
  cached: boolean;
}>;

/** DOM test ids for the availability screen. */
export const AVAILABILITY_TEST_IDS = {
  requestBar: "crm-availability-request",
  verdict: "crm-availability-verdict",
  timeline: "crm-availability-timeline",
  card: "crm-availability-card",
  heats: "crm-availability-heats",
} as const;

/** The prototype's "Hold these lanes in BMI" lands on the builder (C5). */
export const AVAILABILITY_HOLD_LABEL = "Hold these lanes in BMI";
