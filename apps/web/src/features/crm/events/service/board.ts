/**
 * THE EVENTS BOARD — the old Daily Events board, folded into the CRM.
 *
 * READ-ONLY, and deliberately so. It rides `listDailyEvents(locationId, date)`
 * exactly as the v2 board does, so it shares the `de:res:*` cache (360 s, four
 * readers plus the warm cron) through THAT function and nothing here ever
 * touches the key itself. A second writer of `de:res:*` would freeze BMI truth
 * for every screen in the building.
 *
 * Three sources, layered in this order:
 *   1. BMI — what is actually booked that day (`listDailyEvents`), group
 *      functions only (`isOnlineReservation` is the same split the v2 board's
 *      "group" view makes, so the two lists can be diffed row for row).
 *   2. `group_function_quotes` — what the guest has signed and paid
 *      (`listQuotesByEventDates`, joined on `bmi_reservation_id`).
 *   3. `crm_leads` — who owns it (joined on `bmi_project_id`), so a row can
 *      open the deal drawer on the Event tab. An event with no lead row is a
 *      legacy booking and renders read-only with "Create lead from event".
 *
 * One day's BMI read failing does not empty the week: that band carries its
 * own `error` and the others render.
 */

import { listQuotesByEventDates } from "@/lib/group-function-db";
import { listEventMetadataForDates } from "~/features/daily-events/data/event-metadata-db";
import { isOnlineReservation } from "~/features/daily-events/logic";
import { listDailyEvents } from "~/features/daily-events/service";
import type { Reservation } from "~/features/daily-events/types";
import { mapWithConcurrency } from "~/features/crm/bmi";
import { listLeadsByProjectIds } from "~/features/crm/leads";
import type { LeadView } from "~/features/crm/leads/contracts";
import { centreByCode } from "../../core/centres";
import { todayEasternYmd } from "../../core/dates";
import type { CentreCode } from "../../core/types";
import {
  type EventDayBand,
  type EventFoodOut,
  type EventLeadLink,
  type EventsView,
} from "../contracts";
import { dayRange, makeBand, mergeEventRows, type BoardQuote } from "../projection";

/** Office answers at most four sockets at once; days go through in pairs. */
const DAY_CONCURRENCY = 2;

export interface EventsBoardInput {
  centre: CentreCode;
  view: EventsView;
  /** First day of the band, YYYY-MM-DD in ET. */
  date: string;
  includeCancelled: boolean;
}

export interface EventsBoardBody {
  centre: CentreCode;
  view: EventsView;
  date: string;
  today: string;
  includeCancelled: boolean;
  days: EventDayBand[];
}

export interface BoardDeps {
  listDailyEvents: (locationId: number, date: string) => Promise<{ reservations: Reservation[] }>;
  listQuotes: (
    dates: string[],
    centerCodes: string[],
  ) => Promise<Array<BoardQuote & { event_day: string }>>;
  listLeads: (projectIds: string[]) => Promise<LeadView[]>;
  listFoodOut: (locationId: number, dates: string[]) => Promise<Map<string, EventFoodOut>>;
  now: () => Date;
}

export function defaultBoardDeps(): BoardDeps {
  return {
    listDailyEvents: (locationId, date) => listDailyEvents(locationId, date),
    listQuotes: (dates, centerCodes) =>
      listQuotesByEventDates(dates, centerCodes) as unknown as Promise<
        Array<BoardQuote & { event_day: string }>
      >,
    listLeads: listLeadsByProjectIds,
    listFoodOut: async (locationId, dates) => {
      const rows = await listEventMetadataForDates(locationId, dates);
      const out = new Map<string, EventFoodOut>();
      for (const [projectId, m] of rows) {
        out.set(projectId, {
          time: m.foodOutTime,
          source: m.foodOutSource,
          confidence: m.foodOutConfidence,
          reasoning: m.foodOutReasoning,
          updatedAt: m.updatedAt,
        });
      }
      return out;
    },
    now: () => new Date(),
  };
}

/** `crm_leads` row → the compact link the board row carries. */
export function leadLink(lead: LeadView): EventLeadLink {
  return {
    publicId: lead.publicId,
    id: lead.id,
    status: lead.status,
    repName: lead.repName,
    repSlug: lead.repSlug,
    guestPhone: lead.guest.phone,
  };
}

export function resolveBoardDate(date: string | undefined, now: Date): string {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayEasternYmd(now);
}

export async function eventsBoard(
  input: EventsBoardInput,
  deps: BoardDeps = defaultBoardDeps(),
): Promise<EventsBoardBody> {
  const centre = centreByCode(input.centre);
  const today = todayEasternYmd(deps.now());
  const dates = dayRange(input.date, input.view);

  // 1. BMI, day by day. A day that throws keeps its own error; the band still
  //    renders so the week is never silently short.
  const perDay = await mapWithConcurrency(dates, DAY_CONCURRENCY, async (date) => {
    const res = await deps.listDailyEvents(centre.locationId, date);
    return (res.reservations || []).filter((r) => !isOnlineReservation(r));
  });

  const reservationsByDate = new Map<string, Reservation[]>();
  const errorByDate = new Map<string, string>();
  dates.forEach((date, i) => {
    const slot = perDay[i];
    if (slot && slot.ok) reservationsByDate.set(date, slot.value);
    else errorByDate.set(date, slot ? slot.error : "no answer");
  });

  const projectIds = [...reservationsByDate.values()].flat().map((r) => r.id);

  // 2 + 3. One quote read and one lead read for the whole band.
  const [quotes, leads, foodOut] = await Promise.all([
    projectIds.length ? deps.listQuotes(dates, [centre.centerCode]) : Promise.resolve([]),
    projectIds.length ? deps.listLeads(projectIds) : Promise.resolve([]),
    projectIds.length
      ? deps.listFoodOut(centre.locationId, dates)
      : Promise.resolve(new Map<string, EventFoodOut>()),
  ]);

  const quotesByProjectId = new Map<string, BoardQuote>();
  for (const q of quotes) quotesByProjectId.set(String(q.bmi_reservation_id), q);

  const leadsByProjectId = new Map<string, EventLeadLink>();
  for (const lead of leads) {
    if (lead.bmi.projectId) leadsByProjectId.set(lead.bmi.projectId, leadLink(lead));
  }

  const days = dates.map((date) => {
    const error = errorByDate.get(date) ?? null;
    const events = mergeEventRows({
      centre: input.centre,
      reservations: reservationsByDate.get(date) ?? [],
      quotesByProjectId,
      leadsByProjectId,
      foodOutByProjectId: foodOut,
      includeCancelled: input.includeCancelled,
    });
    return makeBand(date, today, events, error);
  });

  return {
    centre: input.centre,
    view: input.view,
    date: input.date,
    today,
    includeCancelled: input.includeCancelled,
    days,
  };
}
