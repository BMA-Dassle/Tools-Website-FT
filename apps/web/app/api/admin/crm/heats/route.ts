import { CENTRES } from "~/features/crm/core/centres";
import type { CentreSummary } from "~/features/crm/core/contracts";
import { todayEasternYmd } from "~/features/crm/core/dates";
import { withCrmRoute } from "~/features/crm/core/http";
import {
  DEFAULT_GUESTS,
  HeatsQuerySchema,
  findLeadForAvailability,
  firstRunOfHeats,
  heatsNeeded,
  readHeats,
  type AvailabilityLead,
  type HeatBlock,
  type HeatResource,
} from "~/features/crm/availability";

/**
 * `GET /api/admin/crm/heats?centre&date&guests[&resourceId][&lead][&refresh]`
 *
 * Karting (and duckpin, and the sim) capacity from BMI Office's `dayPlanner`,
 * which is where FastTrax's availability actually lives — there is no QAMF lane
 * grid for it. Answers the same question the lane route does, in the units
 * karting uses: how many consecutive heats this party needs, and the first run
 * of heats with room for them.
 *
 * READ ONLY. Office is read through `officeGet` and nothing else; booking a
 * heat is the builder's job (C5), and Office refuses an overbooking with a 403
 * that C5 renders as "heat full".
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function centreSummary(code: keyof typeof CENTRES): CentreSummary {
  const c = CENTRES[code];
  return { code: c.code, name: c.name, short: c.short, clientKey: c.clientKey };
}

const VENDOR_UNAVAILABLE =
  "Heat availability could not be read from the centre just now. Try Refresh in a moment.";

/** The track a party books by default: the first racing resource with capacity. */
function pickResource(resources: HeatResource[], wanted?: string): HeatResource | null {
  if (wanted) return resources.find((r) => r.resourceId === wanted) ?? null;
  return resources.find((r) => r.isTrack && r.capacity > 0) ?? resources[0] ?? null;
}

export const GET = withCrmRoute(HeatsQuerySchema, async ({ input, user }) => {
  const lead: AvailabilityLead | null = input.lead
    ? await findLeadForAvailability(input.lead)
    : null;
  const centreCode = input.centre ?? lead?.centre ?? "FT";
  const date = input.date ?? lead?.eventDate ?? todayEasternYmd();
  const guests = input.guests ?? lead?.guests ?? DEFAULT_GUESTS;
  const base = {
    centre: centreSummary(centreCode),
    date,
    guests,
    lead,
    leadMissing: Boolean(input.lead) && lead === null,
  };

  let read;
  try {
    read = await readHeats(centreCode, date, { refresh: input.refresh === true });
  } catch (err) {
    console.error("[crm] heats read failed", {
      centre: centreCode,
      date,
      actor_email: user.email,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...base,
      source: "unavailable" as const,
      error: VENDOR_UNAVAILABLE,
      resources: [] as HeatResource[],
      selectedResourceId: null,
      heatsNeeded: 0,
      firstRun: null as HeatBlock[] | null,
      readAt: new Date().toISOString(),
      cached: false,
    };
  }

  const selected = pickResource(read.resources, input.resourceId);
  const need = selected ? heatsNeeded(guests, selected.capacity) : 0;
  const firstRun = selected ? firstRunOfHeats(selected.blocks, guests) : null;

  return {
    ...base,
    source: "heats" as const,
    resources: read.resources,
    selectedResourceId: selected?.resourceId ?? null,
    heatsNeeded: need,
    firstRun,
    readAt: read.readAt,
    cached: read.cached,
  };
});
