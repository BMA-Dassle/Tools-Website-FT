/**
 * Today's Crew — the server read (owner 2026-09-06).
 *
 * ZERO VENDOR CALLS, BY DESIGN. Pandora went down mid-day on 2026-09-05 and
 * the owner's first question about this feature was "this doesn't put much
 * stress on Pandora or anything, does it?". Everything the sheet shows comes
 * from Neon:
 *   - WHO: the other participants on the reservation rows this person is on
 *     today (`coBookedPeopleOnDate`, booking_metadata self-join);
 *   - NAMES: the booking's own name, upgraded to first + last from any
 *     check-in or group-waiver join we hold for that person;
 *   - WAIVER: `true` when our own waiver_signatures vouch (a captured,
 *     unexpired signature) or the booking marked them valid today; otherwise
 *     `null` — "we'll check when you add them". The kiosk then runs the
 *     ordinary ONE-person Pandora read only for someone actually added, which
 *     is the read every ordinary sign-in already performs.
 *
 * Ages are never known here (no booking row carries a birthday); the heat's
 * adult/junior class stands in for the party member's category.
 */
import { coBookedPeopleOnDate } from "@/lib/bowling-db";
import { personsWithUnexpiredCapturedWaiver } from "@/lib/waiver-signature-store";
import { todayET } from "~/features/daily-events/format";
import { formatPersonName } from "~/lib/helpers/name-format";
import { CENTER_CODES_FOR_SLUG, type CenterSlug } from "../checkin/centers";
import { listCheckinNamesByPersonIds } from "../data/kiosk-checkins-db";
import { listJoinNamesByPersonIds } from "../data/kiosk-waiver-joins-db";
import { dedupeCoBooked, splitName } from "./todays-crew";
import type { CrewSuggestion } from "./types";

type NameMap = Map<string, { firstName: string | null; lastName: string | null }>;

export async function readTodaysCrew(
  personId: string,
  center: CenterSlug,
  date: string = todayET(),
): Promise<CrewSuggestion[]> {
  const rows = await coBookedPeopleOnDate({
    personId,
    date,
    centerCodes: CENTER_CODES_FOR_SLUG[center],
  });
  const people = dedupeCoBooked(rows);
  if (people.length === 0) return [];
  const ids = people.map((p) => p.bmiPersonId);

  // All three enrichments are our own tables and independent of each other.
  const [checkinNames, joinNames, vouched] = await Promise.all([
    listCheckinNamesByPersonIds(ids),
    listJoinNamesByPersonIds(ids),
    personsWithUnexpiredCapturedWaiver(ids),
  ]);

  return people.map((p) => {
    const { first, last } = bestName(p.bmiPersonId, p.name, checkinNames, joinNames);
    return {
      id: p.bmiPersonId,
      firstName: formatPersonName(first),
      lastName: formatPersonName(last),
      age: null,
      category: p.category,
      waiverValid: vouched.has(p.bmiPersonId) || p.waiverValid === true ? true : null,
      bookedAt: p.slot,
      kind: p.kind,
    };
  });
}

/** Booking name, upgraded to first + last where we hold both. A source that
 *  knows the last name beats one that does not; the booking's own name is the
 *  floor (a karting heat records the first name only). */
function bestName(
  personId: string,
  bookingName: string,
  ...sources: NameMap[]
): { first: string; last: string } {
  const fromBooking = splitName(bookingName);
  for (const src of sources) {
    const n = src.get(personId);
    if (!n) continue;
    const first = (n.firstName ?? "").trim() || fromBooking.first;
    const last = (n.lastName ?? "").trim();
    if (last) return { first, last };
  }
  return fromBooking;
}
