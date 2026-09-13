/**
 * Pure view helpers for the Events board — the strings and the row tint,
 * separated from the components so they can be tested without a DOM.
 *
 * Every date here is a YYYY-MM-DD handled as CALENDAR text (`dateParts`), never
 * `new Date(ymd)`: an event on the 16th must read "Wed, Sep 16" on a laptop in
 * any timezone (R10).
 */

import { fTime } from "~/features/crm/core/dates";
import { money } from "~/features/crm/core/format";
import type { EventDayBand, EventRowView } from "~/features/crm/events/contracts";
import { isPastUnpaid } from "~/features/crm/events/projection";
import { DOW, MON, dateParts } from "../primitives/DateBlock";

/** `Wed, Sep 16` — and the prototype's " — Today" suffix on the current day. */
export function bandTitle(band: Pick<EventDayBand, "date" | "isToday">): string {
  const p = dateParts(band.date);
  const label = p ? `${p.weekday}, ${p.month} ${p.day}` : band.date;
  return band.isToday ? `${label} — Today` : label;
}

/** `Wed Sep 16 – Tue Sep 22`, or the single day for the day view. */
export function rangeLabel(dates: readonly string[]): string {
  const first = dateParts(dates[0] ?? "");
  const last = dateParts(dates[dates.length - 1] ?? "");
  if (!first) return "";
  const head = `${first.weekday} ${first.month} ${first.day}`;
  if (!last || dates.length < 2) return head;
  return `${head} – ${last.weekday} ${last.month} ${last.day}`;
}

/** `3 events · 64 persons` — or the prototype's "no group events". */
export function bandSummary(band: EventDayBand): string {
  if (band.error) return "BMI could not be read for this day";
  if (band.events.length === 0) return "no group events";
  const n = band.events.length;
  const persons = band.events.reduce((a, e) => a + e.persons, 0);
  return `${n} event${n > 1 ? "s" : ""} · ${persons} person${persons === 1 ? "" : "s"}`;
}

/** `$1,004 / $2,390` — collected over booked, the band's money line. */
export function bandMoney(band: EventDayBand): string {
  return `${money(band.collectedCents)} / ${money(band.totalCents)}`;
}

/**
 * The meta line under a row's title, in the prototype's order: time,
 * registered/persons, the rep, and the food-out line when there is one.
 */
export function eventMetaParts(row: EventRowView): string[] {
  const out: string[] = [];
  if (row.when) out.push(fTime(row.when));
  out.push(`${row.registered ?? 0}/${row.persons} registered`);
  if (row.lead?.repName) out.push(row.lead.repName);
  else if (row.responsible) out.push(row.responsible);
  if (row.foodOut.time) out.push(`Food out ${row.foodOut.time}`);
  return out;
}

/**
 * `.row.urg-warn` for a contract still out, `.row.urg-crit` for a past event
 * left unpaid ("Past events left unpaid turn red" — the board's own footer).
 */
export function rowTint(row: EventRowView, todayYmd: string): "" | "urg-warn" | "urg-crit" {
  if (isPastUnpaid(row, todayYmd)) return "urg-crit";
  if (row.pill.kind === "unsigned") return "urg-warn";
  return "";
}

/** What the pill's tooltip says — the GF vocabulary's own help text. */
export const PILL_TITLE: Record<string, string> = {
  paid: "Balance settled and the day-of order funded",
  deposit: "Signed and the deposit is in; the balance auto-charges at T-72h",
  unsigned: "The guest has the signing page; nothing signed yet",
  none: "No group-function contract for this event",
};

/** `Sep 16` etc. for the toast after a create. */
export function eventShortDate(ymd: string): string {
  const p = dateParts(ymd);
  return p ? `${p.month} ${p.day}` : ymd;
}

export { DOW, MON };
