/**
 * The reservations board's GRID view — the vendor read. SERVER ONLY.
 *
 * Reuses the availability sub's transports rather than re-reading QAMF and BMI
 * Office itself (`~/features/crm/availability` is the sanctioned door — §3.2 of
 * the CRM brief). That is not just tidiness: both readers sit behind the SAME
 * 60-second Redis cache (`crm:avail:*`), so a planner with the availability
 * screen open and a manager with this grid open share one vendor read per
 * centre per minute instead of two. Adding a second reader would have doubled
 * the load on the one integration we are least able to retry against.
 *
 * READ ONLY. Nothing here writes to QAMF, Office, or Neon.
 */
import {
  LANE_SECTIONS,
  laneSectionsFor,
  readHeats,
  readLaneGrid,
  type LaneOccupancy,
} from "~/features/crm/availability";
import { CENTRES } from "~/features/crm/core/centres";
import type { CentreCode } from "~/features/crm/core/types";
import {
  boundsForSections,
  coalesceByReservation,
  trackKeyOf,
  type GridBar,
  type GridSection,
  type ReservationGridData,
} from "./grid";

/**
 * The board holds Square location codes; the availability sub speaks
 * `CentreCode`. `CENTRES[x].pandoraLocationId` IS the Square code, so this is a
 * re-index of one existing map rather than a fifth copy of the centre table
 * (`crm/core/centres.ts` documents the other four, and a test pins them equal).
 */
const CENTRE_BY_LOCATION: Record<string, CentreCode> = Object.fromEntries(
  (Object.keys(CENTRES) as CentreCode[]).map((code) => [CENTRES[code].pandoraLocationId, code]),
);

/** Slugs the board also stores in `center_code` for race/attraction rows. */
const CENTRE_BY_SLUG: Record<string, CentreCode> = Object.fromEntries(
  (Object.keys(CENTRES) as CentreCode[]).map((code) => [CENTRES[code].centerCode, code]),
);

export function centreCodeFor(center: string): CentreCode | null {
  return CENTRE_BY_LOCATION[center] ?? CENTRE_BY_SLUG[center] ?? null;
}

/**
 * What a vendor failure is allowed to say out loud — one sentence, no hostname,
 * no status line, no upstream body. The detail belongs in the server log.
 * Same reasoning as the availability route's `VENDOR_UNAVAILABLE`.
 */
export const GRID_UNAVAILABLE =
  "The lane grid could not be read from the centre just now. The list view still works.";

function unavailable(centre: CentreCode, date: string, error: string): ReservationGridData {
  return {
    source: "unavailable",
    error,
    centre,
    centreShort: CENTRES[centre].short,
    date,
    bounds: boundsForSections([]),
    sections: [],
    readAt: new Date().toISOString(),
    cached: false,
  };
}

/** Lane occupancy → one section per lane section, one row per lane. */
export function laneSectionsFromOccupancy(
  centre: "HPFM" | "HPN",
  occupancy: readonly LaneOccupancy[],
): GridSection[] {
  const byLane = new Map<number, LaneOccupancy>();
  for (const row of occupancy) byLane.set(row.lane, row);

  return LANE_SECTIONS[centre].map((section) => ({
    name: section.name,
    rows: section.lanes.map((lane) => {
      const blocks = byLane.get(lane)?.blocks ?? [];
      const bars: GridBar[] = blocks.map((b, i) => ({
        key: `lane-${lane}-${b.start}-${b.end}-${i}`,
        start: b.start,
        end: b.end,
        kind: b.kind,
        label: b.label,
        ...(b.reservationId ? { reservationId: b.reservationId } : {}),
      }));
      return { id: String(lane), label: String(lane), bars: coalesceByReservation(bars) };
    }),
  }));
}

/**
 * Heat blocks → one row per Office resource.
 *
 * Only blocks with somebody in them are drawn. An empty heat is capacity, not
 * an event; painting all of them would bury the six that matter tonight under a
 * day's worth of identical empty boxes — and capacity is the availability
 * screen's question, not this board's.
 */
export function heatSectionFromResources(
  centreShort: string,
  resources: readonly {
    resourceId: string;
    resourceName: string;
    blocks: readonly { start: number; stop: number; bookedSpots: number; description: string }[];
  }[],
): GridSection[] {
  const rows = resources.map((resource) => {
    const trackKey = trackKeyOf(resource.resourceName);
    const bars: GridBar[] = resource.blocks
      .filter((b) => b.bookedSpots > 0)
      .map((b, i) => ({
        key: `heat-${resource.resourceId}-${b.start}-${i}`,
        start: b.start,
        end: b.stop,
        kind: "heat" as const,
        label: b.description.trim() || resource.resourceName,
        ...(trackKey ? { trackKey } : {}),
      }));
    return { id: resource.resourceId, label: resource.resourceName, bars };
  });
  // A resource with nothing booked all day is a row of empty space; drop it so
  // the grid is the evening, not the equipment list.
  const busy = rows.filter((r) => r.bars.length > 0);
  return busy.length > 0 ? [{ name: centreShort, rows: busy }] : [];
}

/**
 * One centre's grid for one ET day.
 *
 * Bowling centres answer with lanes; FastTrax has no bowling grid at all and
 * answers with Office heat blocks — the same fork the availability screen takes
 * (`laneSectionsFor` returns null for FT).
 */
export async function readReservationGrid(
  centre: CentreCode,
  date: string,
  opts: { refresh?: boolean } = {},
): Promise<ReservationGridData> {
  const centreShort = CENTRES[centre].short;
  const sections = laneSectionsFor(centre);

  if (!sections) {
    try {
      const heats = await readHeats(centre, date, opts);
      const built = heatSectionFromResources(centreShort, heats.resources);
      return {
        source: "heats",
        centre,
        centreShort,
        date,
        bounds: boundsForSections(built),
        sections: built,
        readAt: heats.readAt,
        cached: heats.cached,
      };
    } catch (err) {
      console.error("[reservations-grid] heats read failed", { centre, date, err });
      return unavailable(centre, date, GRID_UNAVAILABLE);
    }
  }

  try {
    const grid = await readLaneGrid(centre, date, opts);
    const built = laneSectionsFromOccupancy(centre as "HPFM" | "HPN", grid.occupancy);
    return {
      source: "lanes",
      centre,
      centreShort,
      date,
      bounds: boundsForSections(built),
      sections: built,
      readAt: grid.readAt,
      cached: grid.cached,
    };
  } catch (err) {
    console.error("[reservations-grid] lane grid read failed", { centre, date, err });
    return unavailable(centre, date, GRID_UNAVAILABLE);
  }
}
