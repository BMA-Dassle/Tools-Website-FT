/**
 * What time a browse row should show, and whether it belongs in the list at all.
 *
 * ── The time (live report 2026-08-07) ───────────────────────────────────────
 * The browse list showed `eventAt || bookedAt`. `eventAt` maps to a column —
 * `event_at` — that DOES NOT EXIST on bowling_reservations, so it is always
 * undefined and every racing row silently fell through to `bookedAt`: the
 * moment the guest BOOKED, presented as the time they race. Measured on 10
 * consecutive live rows, every one was wrong, by 22 minutes to 1h44m.
 *
 * A race's time is its HEAT. `booking_metadata.heats[].heatId` is
 * centre-local naive ET, the same convention the browse list renders in, and it
 * is kept true to BMI by the check-in sync. `bookedAt` survives only as a last
 * resort for a row with no heats at all (bowling/attraction legs), where it was
 * always the intended value.
 *
 * ── The bowling times were 4h late (live report 2026-08-19) ─────────────────
 * The heat-less fallback returned `bookedAt` VERBATIM, and Neon serializes that
 * TIMESTAMPTZ as a UTC instant (`...Z`). Every reader downstream — `timeKey`,
 * `fmtTime12` — treats the string as a naive ET wall-clock, so it strips the
 * `Z` and prints the UTC hour: a 9:00 PM lane advertised as 1:00 AM. Nobody saw
 * it while the list was racing-only (a race always has a heat, so the fallback
 * never reached the screen); HeadPinz bowling check-in (owner 2026-08-16) put
 * heat-less rows on the list and the whole board shifted four hours. The
 * fallback now goes through `toEtWallClock` — the one place that knows a `Z`
 * means "convert" — and normalizing BEFORE the sort keeps a group whose legs
 * disagree about zone ordering on the clock rather than on the suffix.
 *
 * ── Cancelled (live report 2026-08-07) ──────────────────────────────────────
 * The list filtered on Neon's `status`, so a reservation cancelled IN BMI still
 * appeared and could be opened — Neon simply had not heard. Status is OUR
 * record; the same class of staleness as the roster and the heat times. We
 * cannot ask BMI per row here (the list is built from one Neon query and a BMI
 * call per reservation would cost seconds), so this hardens what we can: any
 * cancelled-ish status on ANY leg of the bill removes the whole reservation,
 * rather than one leg's status speaking for the group.
 */

import { toEtWallClock } from "./itinerary";

/** Statuses that must never be offered for check-in. */
const DEAD_STATUSES = new Set(["cancelled", "canceled", "no_show", "refunded", "voided"]);

export interface BrowseLegLike {
  productKind?: string;
  status?: string | null;
  bookedAt?: string | null;
  bookingMetadata?: unknown;
}

/** True when this leg's status disqualifies the whole reservation. */
export function isDeadStatus(status: string | null | undefined): boolean {
  return DEAD_STATUSES.has(
    String(status ?? "")
      .trim()
      .toLowerCase(),
  );
}

/** Earliest heat start on a leg, or "" when it carries none. */
export function earliestHeatStart(leg: BrowseLegLike): string {
  const heats = (leg.bookingMetadata as { heats?: unknown } | undefined)?.heats;
  if (!Array.isArray(heats)) return "";
  const starts = heats
    .map((h) =>
      h && typeof h === "object" ? String((h as { heatId?: unknown }).heatId ?? "") : "",
    )
    .filter((s) => s.length >= 16)
    .sort();
  return starts[0] ?? "";
}

/**
 * The time to SHOW for a reservation, given all its legs.
 *
 * A heat always wins — that is the race. Only a reservation with no heat on any
 * leg falls back to `bookedAt`, which for bowling/attraction rows is what it
 * always meant.
 */
export function browseRowTime(legs: BrowseLegLike[]): { iso: string; source: "heat" | "booked" } {
  const heats = legs.map(earliestHeatStart).filter(Boolean).sort();
  if (heats.length > 0) return { iso: heats[0], source: "heat" };
  // ET WALL-CLOCK, NOT THE RAW STAMP. `bookedAt` arrives as Neon's UTC instant
  // ("2026-08-19T01:00:00.000Z") while every reader of this value treats it as
  // naive ET, so handing the stamp back verbatim printed 1:00 AM for a 9:00 PM
  // lane. Normalize first, then sort — otherwise legs that disagree about zone
  // order lexically on the suffix instead of chronologically.
  const booked = legs
    .map((l) => toEtWallClock(l.bookedAt))
    .filter(Boolean)
    .sort();
  return { iso: booked[0] ?? "", source: "booked" };
}

/**
 * Should this reservation appear in the check-in browse list?
 *
 * Fails CLOSED on death: one cancelled leg kills the group. A guest who cannot
 * check in is better served by "we can't find it, see the desk" than by opening
 * a reservation that no longer exists and being told so three screens later.
 */
export function browseRowIsOpen(legs: BrowseLegLike[]): boolean {
  if (legs.length === 0) return false;
  return !legs.some((l) => isDeadStatus(l.status));
}
