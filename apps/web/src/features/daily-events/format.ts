/**
 * Display formatters for the daily-events board.
 *
 * Time rendering: the portal parsed BMI's ISO strings with the browser-local
 * Date — correct only for viewers in ET. BMI `when`/`start`/`stop` strings are
 * naive ET wall-clock, so we use the same hasZone guard as the reservations
 * board (`fmtClock`): naive strings print their literal wall time, zoned
 * strings convert to ET. Same times staff saw in the portal, now viewer-TZ
 * independent.
 */
import { fmtClock, todayET } from "~/features/reservations-admin/format";

export { todayET };

/** "5:00 PM" from a BMI ISO string (portal formatTime). */
export function fmtEventTime(iso: string | undefined | null): string {
  if (!iso) return "";
  return fmtClock(iso);
}

/** "Jul 12, 2026, 5:00 PM"-style stamp for detail fields. */
export function fmtEventDateTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (!hasZone && m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
    const datePart = d.toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${datePart}, ${fmtClock(iso)}`;
  }
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

/** "Saturday, July 12, 2026" header label (portal dateLabel). */
export function fmtDateLabelLong(dateStr: string): string {
  return new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

/** "First Last" from a BMI person profile (portal pattern). */
export function personDisplayName(p: { firstName?: string; name?: string }): string {
  return `${p.firstName || ""} ${p.name || ""}`.trim();
}

/**
 * YYYY-MM-DD event date for the metadata API, from a BMI `when` string.
 *
 * PORTAL-EXACT keying — local parse → UTC date (ReservationDetailPage.tsx
 * ~1036), which rolls evening events (>= 8 PM EDT) onto the NEXT calendar
 * day. Looks wrong, but every existing event_metadata row (including the
 * migrated portal rows) is keyed this way, and the BMI note sync reads the
 * same table — "fixing" it to the wall date would orphan every evening
 * event's saved food-out time. Do not change without rekeying the table.
 */
export function eventDateOf(when: string | undefined | null): string {
  if (!when) return "";
  const d = new Date(when);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().substring(0, 10);
}
