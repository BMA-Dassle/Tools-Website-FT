/**
 * Kiosk first-available engine.
 *
 * The kiosk's prime directive (owner): "book now" — selecting an activity
 * auto-targets TODAY and surfaces the first bookable time, with "later
 * today" as the secondary path. NO artificial minimum lead time (owner
 * 2026-07-17: ASAP is fine — the next bookable slot per vendor
 * availability is the right answer).
 *
 * This module is pure selection logic over already-fetched availability;
 * fetching stays in the existing adapters (bmiAdapter.getAvailability,
 * bowling availability-client) so the kiosk inherits every precision and
 * clientKey rule. Race auto-pick must additionally pass the web's
 * restriction rules — that lands with the kiosk race step (the engine here
 * exposes the seam via the `blocked` predicate).
 */
import { businessDayYmdET } from "@/lib/race-business-day";

export interface CandidateSlot {
  /** BMI block start — ISO local wall-clock (as the adapters return it). */
  start: string;
  /** Remaining capacity for the slot. */
  freeSpots: number;
}

/** The "soonest opening" a tile can advertise: when the earliest bookable block
 *  today starts and how many are left. `freeSpots` reads as remaining lanes/
 *  tables for per-slot attractions, or remaining seats for per-person ones. */
export interface FirstOpen {
  /** BMI block start — zone-less ET wall-clock (format the adapters return);
   *  render with {@link slotLabel} on the ET kiosk. */
  start: string;
  freeSpots: number;
}

export interface PickFirstSlotOptions {
  /** Current time in ms (caller supplies — keeps this pure/testable). */
  nowMs: number;
  /** Seats/spots the party needs. */
  quantity: number;
  /**
   * Extra exclusion predicate (cart conflicts, restriction rules, buyout
   * windows). Return true to skip the slot.
   */
  blocked?: (start: string) => boolean;
}

/** Parse the adapters' zone-less ISO ("2026-07-17T16:15:00") as wall-clock. */
export function slotStartMs(start: string): number {
  return new Date(start.replace(/Z$/, "")).getTime();
}

/**
 * Earliest slot that is in the future, has capacity for the party, and
 * isn't excluded. Returns null when nothing today qualifies (caller shows
 * the "all booked today" state + cross-sell).
 */
export function pickFirstSlot(
  slots: CandidateSlot[],
  opts: PickFirstSlotOptions,
): CandidateSlot | null {
  const sorted = [...slots].sort((a, b) => slotStartMs(a.start) - slotStartMs(b.start));
  for (const slot of sorted) {
    const ms = slotStartMs(slot.start);
    if (Number.isNaN(ms) || ms <= opts.nowMs) continue;
    if (slot.freeSpots < opts.quantity) continue;
    if (opts.blocked?.(slot.start)) continue;
    return slot;
  }
  return null;
}

/** "4:15 PM" label for hero cards. */
export function slotLabel(start: string): string {
  return new Date(start.replace(/Z$/, "")).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * The kiosk's OPERATING day (YYYY-MM-DD). Uses the venue "business day" that
 * rolls over at 2 AM ET (lib/race-business-day) — the SAME convention the rest
 * of the app uses for a night that runs past midnight — NOT the calendar
 * midnight. Before 2 AM this is the PREVIOUS calendar date, so a post-midnight
 * guest still sees (and books) the session that's still on the floor instead of
 * an empty next-day search, and BMI's business-day dayplanner keeps those
 * late-night heats under that date.
 */
export function todayYmd(now: Date = new Date()): string {
  return businessDayYmdET(now);
}
