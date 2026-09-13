import { CENTRES } from "~/features/crm/core/centres";
import type { CentreSummary } from "~/features/crm/core/contracts";
import { todayEasternYmd } from "~/features/crm/core/dates";
import { withCrmRoute } from "~/features/crm/core/http";
import {
  AvailabilityQuerySchema,
  boundsFor,
  evaluate,
  findLeadForAvailability,
  laneSectionsFor,
  occupancyMap,
  readLaneGrid,
  resolveRequest,
  ticksBetween,
  type AvailabilityAlternate,
  type AvailabilityLead,
  type AvailabilityPlacement,
  type AvailabilitySection,
  type LaneOccupancy,
} from "~/features/crm/availability";

/**
 * `GET /api/admin/crm/availability?centre&date&start&dur&guests[&lead][&refresh]`
 *
 * Lane availability for one request: the sections, the contiguous free runs,
 * the verdict, and the nearest windows that work when it does not fit. Every
 * parameter is in the query because the URL is the screen's source of truth —
 * the link a planner pastes into a text has to reproduce exactly what they saw.
 *
 * READ ONLY. No QAMF write, no BMI write, no Neon write. `lead` is read through
 * this sub's own small lookup because B3 (which owns `crm_leads`) is landing in
 * parallel; a lead that is not there comes back as `leadMissing: true` and the
 * screen asks for the request by hand rather than inventing one.
 *
 * FastTrax has no bowling grid — it answers `source: "heats"` and the screen
 * reads `/api/admin/crm/heats` instead.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function centreSummary(code: keyof typeof CENTRES): CentreSummary {
  const c = CENTRES[code];
  return { code: c.code, name: c.name, short: c.short, clientKey: c.clientKey };
}

/**
 * What a vendor failure is allowed to say out loud.
 *
 * The detail (hostname, status, body snippet) goes to the server log; a
 * planner's banner gets one sentence. Same reasoning as `withCrmRoute`'s fixed
 * 500 code — an upstream error body is the wrong thing to paint on a screen.
 */
const VENDOR_UNAVAILABLE =
  "Lane availability could not be read from the centre just now. Try Refresh in a moment.";

export const GET = withCrmRoute(AvailabilityQuerySchema, async ({ input, user }) => {
  const lead: AvailabilityLead | null = input.lead
    ? await findLeadForAvailability(input.lead)
    : null;
  const request = resolveRequest(input, lead, todayEasternYmd());
  const centre = centreSummary(request.centre);
  const bounds = boundsFor({ start: request.start, dur: request.dur });
  const base = {
    centre,
    request,
    lead,
    leadMissing: Boolean(input.lead) && lead === null,
    bounds: { ...bounds, ticks: ticksBetween(bounds) },
  };

  const sections = laneSectionsFor(request.centre);
  if (!sections) {
    // FastTrax: karting, no lanes. The heats route answers for this centre.
    return {
      ...base,
      source: "heats" as const,
      need: 0,
      fits: false,
      placement: null,
      alternates: [] as AvailabilityAlternate[],
      sections: [] as AvailabilitySection[],
      lanes: [] as LaneOccupancy[],
      readAt: new Date().toISOString(),
      cached: false,
    };
  }

  let grid;
  try {
    grid = await readLaneGrid(request.centre, request.date, { refresh: input.refresh === true });
  } catch (err) {
    console.error("[crm] availability read failed", {
      centre: request.centre,
      date: request.date,
      actor_email: user.email,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...base,
      source: "unavailable" as const,
      error: VENDOR_UNAVAILABLE,
      need: 0,
      fits: false,
      placement: null,
      alternates: [] as AvailabilityAlternate[],
      sections: [] as AvailabilitySection[],
      lanes: [] as LaneOccupancy[],
      readAt: new Date().toISOString(),
      cached: false,
    };
  }

  const occupancy = occupancyMap(grid);
  const verdict = evaluate({
    sections,
    occupancy,
    window: { start: request.start, dur: request.dur },
    guests: request.guests,
    bounds,
  });

  const placement: AvailabilityPlacement | null = verdict.best
    ? {
        section: verdict.best.section.name,
        lanes: verdict.best.lanes,
        run: verdict.best.run,
        startsOdd: verdict.best.startsOdd,
      }
    : null;

  return {
    ...base,
    source: "lanes" as const,
    need: verdict.need,
    fits: verdict.fits,
    placement,
    alternates: verdict.alternates.map((a) => ({
      start: a.window.start,
      dur: a.window.dur,
      placement: {
        section: a.best.section.name,
        lanes: a.best.lanes,
        run: a.best.run,
        startsOdd: a.best.startsOdd,
      },
    })),
    sections: verdict.sections.map((s) => ({
      name: s.section.name,
      lanes: s.section.lanes,
      free: s.free,
      runs: s.runs,
    })),
    // Only the lanes this centre's sections actually contain, in section order.
    lanes: sections.flatMap((s) =>
      s.lanes.map((lane) => ({ lane, blocks: occupancy.get(lane) ?? [] })),
    ),
    readAt: grid.readAt,
    cached: grid.cached,
  };
});
