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
import { CENTRE_CODES, centreByCode } from "../../core/centres";
import { todayEasternYmd } from "../../core/dates";
import type { CentreCode } from "../../core/types";
import {
  type EventDayBand,
  type EventRowView,
  type EventFoodOut,
  type EventLeadLink,
  type EventsView,
} from "../contracts";
import { dayRange, makeBand, mergeEventRows, type BoardQuote } from "../projection";

/** Office answers at most four sockets at once; days go through in pairs. */
const DAY_CONCURRENCY = 2;

/**
 * Which centres the board is showing. Owner, 2026-09-14: "I'd like an 'all' in
 * top right also don't like how these look. Do we add a small pill with the
 * lcoation when in 'all' mode?"
 */
export type EventsCentreFilter = CentreCode | "all";

export interface EventsBoardInput {
  centre: EventsCentreFilter;
  view: EventsView;
  /** First day of the band, YYYY-MM-DD in ET. */
  date: string;
  includeCancelled: boolean;
}

export interface EventsBoardBody {
  centre: EventsCentreFilter;
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

/**
 * One centre's rows for a set of dates — the read that used to BE `eventsBoard`.
 *
 * Extracted so "All" is the same code three times rather than a second,
 * divergent path: a bug fixed for one centre is fixed for all of them, and the
 * per-day error handling (a day that throws keeps its own error and the band
 * still renders) is written once.
 */
async function eventsForCentre(
  code: CentreCode,
  dates: readonly string[],
  includeCancelled: boolean,
  deps: BoardDeps,
): Promise<{
  eventsByDate: Map<string, EventRowView[]>;
  errorByDate: Map<string, string>;
}> {
  const centre = centreByCode(code);

  const perDay = await mapWithConcurrency([...dates], DAY_CONCURRENCY, async (date) => {
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

  const [quotes, leads, foodOut] = await Promise.all([
    projectIds.length ? deps.listQuotes([...dates], [centre.centerCode]) : Promise.resolve([]),
    projectIds.length ? deps.listLeads(projectIds) : Promise.resolve([]),
    projectIds.length
      ? deps.listFoodOut(centre.locationId, [...dates])
      : Promise.resolve(new Map<string, EventFoodOut>()),
  ]);

  const quotesByProjectId = new Map<string, BoardQuote>();
  for (const q of quotes) quotesByProjectId.set(String(q.bmi_reservation_id), q);

  const leadsByProjectId = new Map<string, EventLeadLink>();
  for (const lead of leads) {
    if (lead.bmi.projectId) leadsByProjectId.set(lead.bmi.projectId, leadLink(lead));
  }

  const eventsByDate = new Map<string, EventRowView[]>();
  for (const date of dates) {
    eventsByDate.set(
      date,
      mergeEventRows({
        centre: code,
        reservations: reservationsByDate.get(date) ?? [],
        quotesByProjectId,
        leadsByProjectId,
        foodOutByProjectId: foodOut,
        includeCancelled,
      }),
    );
  }

  return { eventsByDate, errorByDate };
}

export async function eventsBoard(
  input: EventsBoardInput,
  deps: BoardDeps = defaultBoardDeps(),
): Promise<EventsBoardBody> {
  const today = todayEasternYmd(deps.now());
  const dates = dayRange(input.date, input.view);
  /**
   * ONE CENTRE OR ALL THREE, down the same path.
   *
   * "All" is a fan-out, not a different read: each centre is its own
   * `locationId` in Office (Fort Myers and FastTrax share a TENANT but not a
   * location), so there is no single call that returns them together. Each is
   * read exactly as it would be alone and the days are merged afterwards.
   *
   * COST, stated plainly because the owner asked about Office traffic: a week
   * in All is three times the day-reads of a week in one centre — 21 rather
   * than 7. They are Redis-cached for six minutes and only happen when someone
   * is looking, so this is a bounded, on-demand increase and not a new
   * background load.
   */
  const codes: CentreCode[] = input.centre === "all" ? [...CENTRE_CODES] : [input.centre];

  const perCentre = await Promise.all(
    codes.map((code) => eventsForCentre(code, dates, input.includeCancelled, deps)),
  );

  const days = dates.map((date) => {
    // Sorted by start time so an All board reads as one day rather than three
    // centres stacked; a row without a time sinks rather than jumping the queue.
    const events = perCentre
      .flatMap((c) => c.eventsByDate.get(date) ?? [])
      .sort((a, b) => (a.when || "~").localeCompare(b.when || "~"));
    // One centre's outage must not blank the day for the others: the band says
    // which centre could not be read and still shows what was.
    const errors = perCentre
      .map((c, n) => {
        const e = c.errorByDate.get(date);
        // Name the centre only when there is more than one to confuse.
        return e ? (codes.length > 1 ? `${codes[n]}: ${e}` : e) : null;
      })
      .filter((e): e is string => e !== null);
    return makeBand(date, today, events, errors.length ? errors.join(" · ") : null);
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
