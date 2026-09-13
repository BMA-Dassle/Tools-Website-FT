import redis from "@/lib/redis";
import { buildGrid, MAX_SESSION_MINUTES } from "~/features/lane-plan/grid.server";
import { CENTRES } from "~/features/crm/core/centres";
import { easternRangeToUtc } from "~/features/crm/core/dates";
import type { CentreCode } from "~/features/crm/core/types";
import {
  LANE_SECTIONS,
  clampBlocks,
  mergeAdjacent,
  type LaneBlock,
  type LaneOccupancy,
  type LaneSection,
  type OccupancyKind,
} from "./engine";

/**
 * The lane grid for one centre and one calendar day, read from QAMF and
 * projected into the shape the engine and the timeline speak.
 *
 * Why QAMF and not Neon (brief §1.8, `lane-plan/grid.server.ts`): our
 * `bowling_reservations` table only learns about a Conqueror front-desk booking
 * when its lane OPENS, so leagues, maintenance blocks and any walk-in that
 * never opened are invisible to us. Telling a planner that eight lanes are free
 * on a league night would be worse than telling them nothing.
 *
 * `buildGrid` is reused rather than re-implemented: it already widens the
 * search window's leading edge by `MAX_SESSION_MINUTES` (240) — QAMF's
 * `reservations/search` returns reservations whose lane STARTS in the range, so
 * a session already running when the window opens is otherwise missed entirely
 * — and it already merges the schedule read with `GET /lanes`, which is the
 * only way to see a lane opened straight in Conqueror with no reservation
 * behind it. This module adds nothing to that read; it classifies and clamps.
 *
 * READ ONLY. Nothing here writes to QAMF, and holding lanes is the builder's
 * job (C5), not this screen's.
 */

/** Redis key prefix, per the C4 brief: 60 seconds, per centre and date. */
export const AVAILABILITY_CACHE_PREFIX = "crm:avail";
export const AVAILABILITY_CACHE_SECONDS = 60;

export { MAX_SESSION_MINUTES };

export interface LaneGridProjection {
  centre: CentreCode;
  qamfCenterId: number;
  /** The ET calendar day, YYYY-MM-DD. */
  date: string;
  /** Every lane the centre reports, ascending. */
  lanes: number[];
  /** Per-lane occupancy in minutes from ET midnight, merged and clamped to the day. */
  occupancy: LaneOccupancy[];
  /** When the vendor was read, ISO. */
  readAt: string;
}

export interface LaneGridResult extends LaneGridProjection {
  /** True when this came out of Redis rather than off the wire. */
  cached: boolean;
}

/** Centres with a bowling grid. FastTrax is karting — it goes down `heats.ts`. */
export function laneSectionsFor(centre: CentreCode): readonly LaneSection[] | null {
  if (centre === "HPN") return LANE_SECTIONS.HPN;
  if (centre === "HPFM") return LANE_SECTIONS.HPFM;
  return null;
}

/**
 * Which colour a bar gets on the timeline, from QAMF's free-text
 * `Type.Description` ("Walk-in > Classic", "League", "Non - Bookable",
 * "Birthday Party" — configured per centre, spelling varies by centre, hence
 * the whitespace/hyphen squash).
 */
export function classifyKind(description: string): OccupancyKind {
  const d = description.toLowerCase().replace(/[\s-]+/g, "");
  if (d.includes("league")) return "league";
  if (d.includes("maintenance") || d.includes("nonbookable") || d.includes("closed"))
    return "maint";
  if (d.includes("party") || d.includes("birthday") || d.includes("group") || d.includes("event")) {
    return "party";
  }
  // Everything else — open play, web, kiosk, and a lane opened straight in
  // Conqueror with no reservation at all — draws as a walk-in.
  return "walkin";
}

/** What the bar says. The reservation title first, else its category. */
export function blockLabel(
  title: string,
  description: string,
  source: "schedule" | "floor",
): string {
  const t = title.trim();
  if (t) return t;
  const d = description.trim();
  if (d) return d;
  return source === "floor" ? "On the lane now" : "Reservation";
}

/** The ET day as a pair of instants, and the millisecond span of one minute. */
export function etDayBoundsMs(date: string): { startMs: number; endMs: number } {
  const { startUtc, endUtc } = easternRangeToUtc(date, date);
  return { startMs: Date.parse(startUtc), endMs: Date.parse(endUtc) };
}

/** Minutes from ET midnight on `date`, clamped into the drawn day. */
function minutesFromMidnight(ms: number, dayStartMs: number): number {
  return Math.round((ms - dayStartMs) / 60_000);
}

/**
 * A lane QAMF reports with `Status: "Error"` is under maintenance and cannot be
 * opened at all. `lane-plan` treats one as never free; so does this screen.
 *
 * It is drawn as a whole-day `maint` bar rather than quietly dropped, because
 * "the grid shows nothing on lane 27" and "lane 27 is out of service" are very
 * different sentences to a planner about to promise it.
 */
export const OUT_OF_SERVICE_LABEL = "Lane out of service";

function outOfServiceBlock(): LaneBlock {
  return { kind: "maint", label: OUT_OF_SERVICE_LABEL, start: 0, end: 24 * 60 };
}

/**
 * `LaneGrid.busy` → per-lane blocks. Exported so a test can drive it with a
 * fixture grid instead of the network.
 *
 * `errorLanes` comes straight off `LaneGrid.errorLanes`. A lane in it is busy
 * ALL DAY and nothing else about it matters, so its own reservations are
 * replaced rather than drawn underneath an out-of-service bar.
 */
export function projectBusy(
  busy: readonly {
    source: "schedule" | "floor";
    laneNumber: number;
    startMs: number;
    endMs: number;
    kind: string;
    title: string;
  }[],
  lanes: readonly number[],
  dayStartMs: number,
  errorLanes: ReadonlySet<number> = new Set<number>(),
): LaneOccupancy[] {
  const byLane = new Map<number, LaneBlock[]>();
  for (const lane of lanes) byLane.set(lane, []);
  for (const lane of errorLanes) byLane.set(lane, [outOfServiceBlock()]);
  for (const b of busy) {
    if (errorLanes.has(b.laneNumber)) continue;
    const start = minutesFromMidnight(b.startMs, dayStartMs);
    const end = minutesFromMidnight(b.endMs, dayStartMs);
    if (!(end > start)) continue;
    const block: LaneBlock = {
      kind: classifyKind(b.kind),
      label: blockLabel(b.title, b.kind, b.source),
      start,
      end,
    };
    const list = byLane.get(b.laneNumber);
    if (list) list.push(block);
    else byLane.set(b.laneNumber, [block]);
  }
  const dayBounds = { openMin: 0, closeMin: 24 * 60 };
  return [...byLane.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lane, blocks]) => ({ lane, blocks: mergeAdjacent(clampBlocks(blocks, dayBounds)) }));
}

function cacheKey(qamfCenterId: number, date: string): string {
  return `${AVAILABILITY_CACHE_PREFIX}:${qamfCenterId}:${date}`;
}

/** A cached projection, or null when Redis is cold, absent or unparseable. */
async function readCache(key: string): Promise<LaneGridProjection | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    // Nothing in this payload is a BMI or Pandora id — lane numbers, minutes
    // and labels only — so plain JSON is safe here (R1 is about 17-digit ids).
    return JSON.parse(raw) as LaneGridProjection;
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: LaneGridProjection): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "EX", AVAILABILITY_CACHE_SECONDS);
  } catch {
    // A cache that is down must not take the screen down with it.
  }
}

/**
 * Read one centre's lane grid for one ET day, through a 60-second Redis cache.
 *
 * The cache is keyed by centre and date ALONE, so changing the start, the
 * length or the guest count re-runs the engine against the same read instead of
 * hammering QAMF while a planner drags the time around.
 */
export async function readLaneGrid(
  centre: CentreCode,
  date: string,
  opts: { refresh?: boolean } = {},
): Promise<LaneGridResult> {
  const sections = laneSectionsFor(centre);
  if (!sections) {
    throw new Error(`${centre} has no bowling grid — read karting heats instead`);
  }
  const qamfCenterId = CENTRES[centre].qamfCenterId;
  const key = cacheKey(qamfCenterId, date);

  if (!opts.refresh) {
    const hit = await readCache(key);
    if (hit) return { ...hit, cached: true };
  }

  const { startMs, endMs } = etDayBoundsMs(date);
  const grid = await buildGrid(qamfCenterId, startMs, endMs);
  const projection: LaneGridProjection = {
    centre,
    qamfCenterId,
    date,
    lanes: [...grid.lanes].sort((a, b) => a - b),
    occupancy: projectBusy(grid.busy, grid.lanes, startMs, grid.errorLanes),
    readAt: new Date(grid.readAtMs).toISOString(),
  };
  await writeCache(key, projection);
  return { ...projection, cached: false };
}

/** The projection as the engine wants it: lane → blocks. */
export function occupancyMap(projection: LaneGridProjection): Map<number, LaneBlock[]> {
  const map = new Map<number, LaneBlock[]>();
  for (const row of projection.occupancy) map.set(row.lane, row.blocks);
  return map;
}
