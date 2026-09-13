/**
 * Turning a URL (plus, optionally, a lead) into the request the engine answers.
 * PURE — no clock of its own, no database, no vendor.
 *
 * Precedence is the brief's, and it is deliberate: the QUERY wins wherever it
 * says something, because the URL is the screen's source of truth and a link
 * has to be a saved view. The lead only fills the blanks. That is what lets a
 * planner open `/availability/L-1042`, drag the start to 7 PM, send the link to
 * Jacob and have him see 7 PM rather than the lead's original 6.
 */

import { SLOT_MINUTES, parseClockMinutes } from "./engine";
import type { AvailabilityLead, AvailabilityRequest } from "../contracts";
import type { CentreCode } from "~/features/crm/core/types";

/** Where the request bar starts when neither the URL nor a lead says. */
export const DEFAULT_CENTRE: CentreCode = "HPFM";
export const DEFAULT_START_MIN = 18 * 60;
export const DEFAULT_DURATION_MIN = 120;
export const DEFAULT_GUESTS = 24;

export interface RequestQuery {
  centre?: CentreCode;
  date?: string;
  start?: number;
  dur?: number;
  guests?: number;
}

/**
 * Snap to the half hour the request bar can actually show.
 *
 * Down, not to nearest: a 6:15 PM enquiry is a 6:00 PM block as far as the
 * front desk is concerned, and rounding it UP would quietly answer a question
 * nobody asked — the half hour the guest wanted would be the one we never
 * checked.
 */
export function snapToSlot(minutes: number): number {
  return Math.max(0, Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES);
}

export function resolveRequest(
  query: RequestQuery,
  lead: AvailabilityLead | null,
  todayYmd: string,
): AvailabilityRequest {
  const leadStart = parseClockMinutes(lead?.eventTime);
  return {
    centre: query.centre ?? lead?.centre ?? DEFAULT_CENTRE,
    date: query.date ?? lead?.eventDate ?? todayYmd,
    start: snapToSlot(query.start ?? leadStart ?? DEFAULT_START_MIN),
    dur: query.dur ?? DEFAULT_DURATION_MIN,
    guests: query.guests ?? lead?.guests ?? DEFAULT_GUESTS,
  };
}
