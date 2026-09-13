import redis from "@/lib/redis";
import {
  getMetadataLookups,
  getResourceIdsForLocation,
  officeGet,
} from "~/features/daily-events/data/bmi-office";
import { CENTRES } from "~/features/crm/core/centres";
import type { CentreCode } from "~/features/crm/core/types";
import { fmtMin, parseClockMinutes } from "./engine";

/**
 * Karting (and duckpin, and the sim) availability from BMI Office's
 * `dayPlanner`, which is where FastTrax's capacity actually lives — FastTrax has
 * no bowling grid in QAMF, so the lane engine has nothing to say about it.
 *
 * READ ONLY, and through `officeGet` alone (brief §1.8: `officeGet` parses with
 * `parseWithRawIds`; the bare-`JSON.parse` readers in `lib/bmi-office-actions.ts`
 * are off limits, and `officePost` is a READ verb on a shared session that must
 * never carry a mutation). Nothing here books a heat; that is C5's job.
 *
 * The payload shape was read live on 2026-09-13 against `headpinzftmyers`
 * location 467486:
 *
 *   { planning: [ { resourceId, date, blocks: [
 *       { start, stop, resourceId, styleId, capacity, freePlaces,
 *         bookedSpots, description } ] } ],
 *     reservations: { … } }
 *
 * `start` / `stop` are centre-local wall clock with NO offset
 * ("2026-09-13T15:15:00"), so they are read as minutes-from-midnight straight
 * off the string rather than through `Date` — which is also what keeps a UTC
 * Vercel function and a rep's laptop agreeing (R10).
 */

export const HEATS_CACHE_PREFIX = "crm:avail:heats";
export const HEATS_CACHE_SECONDS = 60;

/** Resources whose name reads like a racing track — the default selection. */
const TRACK_NAME = /track/i;

export interface HeatBlock {
  /** Minutes from midnight, centre-local. */
  start: number;
  stop: number;
  /** "4:12 PM" — what the heat button shows. */
  label: string;
  capacity: number;
  freePlaces: number;
  bookedSpots: number;
  description: string;
}

export interface HeatResource {
  resourceId: string;
  resourceName: string;
  /** The largest capacity any of its blocks reports; 0 when it has none. */
  capacity: number;
  /** True for Blue / Red / Mini Track — the karting resources a party books. */
  isTrack: boolean;
  blocks: HeatBlock[];
}

export interface HeatsProjection {
  centre: CentreCode;
  clientKey: string;
  locationId: number;
  date: string;
  resources: HeatResource[];
  readAt: string;
}

export interface HeatsResult extends HeatsProjection {
  cached: boolean;
}

interface DayPlannerBlock {
  start?: string;
  stop?: string;
  capacity?: number;
  freePlaces?: number;
  bookedSpots?: number;
  description?: string;
}

interface DayPlannerResourceDay {
  resourceId?: unknown;
  blocks?: DayPlannerBlock[];
}

interface DayPlannerPayload {
  planning?: DayPlannerResourceDay[];
}

/** Nobody books a party across more than this many back-to-back heats. */
export const MAX_CONSECUTIVE_HEATS = 8;

/**
 * The headline estimate: guests over the track's capacity, rounded up.
 *
 * An ESTIMATE on purpose. Office reports a `capacity` PER BLOCK and it varies
 * within a day (Blue Track read 14, 11 and 7 on three consecutive heats on
 * 2026-09-13), so the real answer depends on which heats you land on. The run
 * finder below works off each block's own `freePlaces` and is the number the
 * screen actually promises.
 */
export function heatsNeeded(guests: number, capacity: number): number {
  if (!Number.isFinite(capacity) || capacity <= 0) return 0;
  return Math.max(1, Math.ceil(guests / capacity));
}

/**
 * The first run of back-to-back heats with room for the whole party, or null.
 *
 * "Back to back" means each heat starts exactly where the previous one stopped:
 * a gap would split the group around somebody else's booking, which is not a
 * thing the front desk will sell. Seats are counted from each block's OWN
 * `freePlaces` rather than from the track's nominal capacity, because that is
 * the number Office will actually honour — and it is what stops the screen
 * promising a heat that is already half full.
 */
export function firstRunOfHeats(
  blocks: readonly HeatBlock[],
  guests: number,
  opts: { fromMinute?: number; maxRun?: number } = {},
): HeatBlock[] | null {
  if (guests <= 0) return null;
  const maxRun = opts.maxRun ?? MAX_CONSECUTIVE_HEATS;
  const usable = blocks.filter((b) => b.start >= (opts.fromMinute ?? 0));
  for (let i = 0; i < usable.length; i += 1) {
    if (usable[i].freePlaces <= 0) continue;
    const run: HeatBlock[] = [];
    let seated = 0;
    for (let j = i; j < usable.length && run.length < maxRun; j += 1) {
      if (j > i && usable[j].start !== usable[j - 1].stop) break;
      if (usable[j].freePlaces <= 0) break;
      run.push(usable[j]);
      seated += usable[j].freePlaces;
      if (seated >= guests) return run;
    }
  }
  return null;
}

/** dayPlanner payload → resources with their heat blocks, ascending by time. */
export function projectPlanning(
  payload: DayPlannerPayload,
  resourceNames: Record<string, string>,
): HeatResource[] {
  const byResource = new Map<string, HeatBlock[]>();
  for (const day of payload.planning ?? []) {
    const rid = String(day.resourceId ?? "");
    if (!rid) continue;
    const list = byResource.get(rid) ?? [];
    for (const b of day.blocks ?? []) {
      const start = parseClockMinutes(b.start?.slice(11));
      const stop = parseClockMinutes(b.stop?.slice(11));
      if (start == null || stop == null || stop <= start) continue;
      list.push({
        start,
        stop,
        label: fmtMin(start),
        capacity: Number(b.capacity ?? 0) || 0,
        freePlaces: Number(b.freePlaces ?? 0) || 0,
        bookedSpots: Number(b.bookedSpots ?? 0) || 0,
        description: String(b.description ?? ""),
      });
    }
    byResource.set(rid, list);
  }
  return [...byResource.entries()]
    .map(([resourceId, blocks]) => {
      const sorted = [...blocks].sort((a, b) => a.start - b.start);
      const resourceName = resourceNames[resourceId] ?? `Resource ${resourceId}`;
      return {
        resourceId,
        resourceName,
        capacity: sorted.reduce((a, b) => Math.max(a, b.capacity), 0),
        isTrack: TRACK_NAME.test(resourceName),
        blocks: sorted,
      };
    })
    .sort(
      (a, b) =>
        Number(b.isTrack) - Number(a.isTrack) || a.resourceName.localeCompare(b.resourceName),
    );
}

function cacheKey(locationId: number, date: string): string {
  return `${HEATS_CACHE_PREFIX}:${locationId}:${date}`;
}

async function readCache(key: string): Promise<HeatsProjection | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    // Resource ids are Office ids and stay STRINGS end to end (R1); nothing
    // here is re-parsed into a number, so a round trip cannot round one.
    return JSON.parse(raw) as HeatsProjection;
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: HeatsProjection): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "EX", HEATS_CACHE_SECONDS);
  } catch {
    // A cold cache is not an outage.
  }
}

/**
 * Read one centre's heat capacity for one day, through the same 60-second cache
 * the lane grid uses.
 *
 * `showAll=false` because the planner only wants the resources this location
 * actually runs; `daily-events` passes `true` for its debug board.
 */
export async function readHeats(
  centre: CentreCode,
  date: string,
  opts: { refresh?: boolean } = {},
): Promise<HeatsResult> {
  const { clientKey, locationId } = CENTRES[centre];
  const key = cacheKey(locationId, date);

  if (!opts.refresh) {
    const hit = await readCache(key);
    if (hit) return { ...hit, cached: true };
  }

  const resourceIds = await getResourceIdsForLocation(clientKey, locationId);
  if (resourceIds.length === 0) {
    const empty: HeatsProjection = {
      centre,
      clientKey,
      locationId,
      date,
      resources: [],
      readAt: new Date().toISOString(),
    };
    return { ...empty, cached: false };
  }

  const params = resourceIds.map((id) => `resourceIds=${id}`).join("&");
  const [payload, meta] = await Promise.all([
    officeGet<DayPlannerPayload>(
      clientKey,
      `dayPlanner?${params}&from=${date}&till=${date}&showAll=false`,
    ),
    getMetadataLookups(clientKey),
  ]);

  const projection: HeatsProjection = {
    centre,
    clientKey,
    locationId,
    date,
    resources: projectPlanning(payload, meta.resourceNames),
    readAt: new Date().toISOString(),
  };
  await writeCache(key, projection);
  return { ...projection, cached: false };
}
