/**
 * Race Sims scheduling rules — the SAME rule engine racing runs, applied to a
 * sim session (owner 2026-08-26: "make sure we apply all of our scheduling
 * rules"). Pure functions shared by the kiosk time grid (greys a card) and
 * the reserve guard (refuses the charge), so the two can never disagree.
 *
 * Racing's rules and how a sim maps onto them:
 *   - SPACING (conflict.ts heatsConflict): same-track heats must skip a slot;
 *     cross-track needs 30 min to walk over and check in. All three sim
 *     tracks run on the SAME rigs, so sim-vs-sim is same-track — one shared
 *     conflict label, which heatsConflict resolves to its 20-min "skip at
 *     least one session" fallback — and sim-vs-kart is cross-track (30 min).
 *   - CROSS-RESERVATION (findCrossBookingConflict): the same rider's bookings
 *     in OTHER reservations today, matched by bmiPersonId — served by
 *     raceHeatsForPersonsOnDate, which reads karting heats AND prior sim
 *     sessions (booking_metadata.racesims[].participants).
 *   - GROUP EVENTS (lib/group-events): full-day private event blocks the
 *     screen; a morning-only buyout greys sessions before the public reopen;
 *     an event-window reservation greys overlapping sessions (karting-track
 *     extensions don't apply to sims — raceWindowAppliesToTrack with null).
 *   - CAPACITY and LEAD TIME live in the grid (freeSpots vs party, 10 min).
 *   Karting-only rules (tier/category restrictions, cross-category collision,
 *   pack caps) have no sim analog and are deliberately not applied.
 */
import type { PartyMember, RaceSimItem, SessionItem } from "~/features/booking/state/types";
import {
  heatsConflict,
  heatClockLabel,
  type BookedPersonHeat,
} from "~/features/booking/service/conflict";
import {
  getGroupEventForDate,
  getPublicReopenMinutes,
  getRaceBlockWindowsForDate,
  raceWindowAppliesToTrack,
} from "@/lib/group-events";

/** The conflict "track" every sim session carries — one label for all three
 *  sim tracks because they share the rigs (see header). Normalizes to
 *  "race sim", never colliding with red/blue/mega. */
export const RACE_SIM_CONFLICT_TRACK = "Race Sim";

/** Wall-clock ISO ("2026-08-26T15:00:00", optional trailing Z) → epoch ms,
 *  the same parse racing's grid and conflict helpers use. */
export function wallClockMs(iso: string): number {
  return new Date(iso.replace(/Z$/, "")).getTime();
}

export interface TimedBooking {
  startMs: number;
  /** Racing track name for heats, RACE_SIM_CONFLICT_TRACK for sims, null for
   *  attractions/bowling (null = always the 30-min cross-track rule). */
  track: string | null;
}

/** Every timed booking in the cart EXCEPT `excludeItemId`, labelled the way
 *  heatsConflict expects. Broader than racing's own grid (which only checks
 *  the race item's heats) — a sim rider can't be in two places, so the whole
 *  cart counts, like the attraction grid does. */
export function cartTimedBookings(items: SessionItem[], excludeItemId: string): TimedBooking[] {
  const out: TimedBooking[] = [];
  for (const other of items) {
    if (other.id === excludeItemId) continue;
    if (other.kind === "race") {
      for (const h of other.heats) {
        if (h.heatId) out.push({ startMs: wallClockMs(h.heatId), track: h.track ?? null });
      }
    } else if (other.kind === "racesim") {
      if (other.slot)
        out.push({ startMs: wallClockMs(other.slot), track: RACE_SIM_CONFLICT_TRACK });
    } else if (other.kind === "attraction") {
      if (other.slot) out.push({ startMs: wallClockMs(other.slot), track: null });
    } else if (other.kind === "bowling" || other.kind === "kbf") {
      if (other.bookedAt) out.push({ startMs: wallClockMs(other.bookedAt), track: null });
    }
  }
  return out.filter((b) => Number.isFinite(b.startMs));
}

/** Racing's spacing rule, sim-side: is a candidate sim session too close to
 *  any of `others`? */
export function raceSimSlotConflicts(candidateStartMs: number, others: TimedBooking[]): boolean {
  return others.some((o) =>
    heatsConflict(o.startMs, o.track, candidateStartMs, RACE_SIM_CONFLICT_TRACK),
  );
}

/** Racing's "Reserved for event" rule: the session overlaps an event-window
 *  reservation on this date. Karting-track-scoped extensions never apply to a
 *  sim (raceWindowAppliesToTrack with a null track), exactly as they never
 *  apply to a heat on a track outside the extension. */
export function raceSimSlotEventReserved(date: string, startIso: string, stopIso: string): boolean {
  const start = wallClockMs(startIso);
  const stop = wallClockMs(stopIso);
  return getRaceBlockWindowsForDate(date).some((w) => {
    if (!raceWindowAppliesToTrack(w, null)) return false;
    return start < wallClockMs(w.stopIso) && stop > wallClockMs(w.startIso);
  });
}

/** Racing's morning-buyout rule: the session starts before the public reopen. */
export function raceSimSlotBeforeReopen(date: string, startIso: string): boolean {
  const reopenMins = getPublicReopenMinutes(date);
  if (reopenMins == null) return false;
  const d = new Date(startIso.replace(/Z$/, ""));
  return d.getHours() * 60 + d.getMinutes() < reopenMins;
}

/** Racing's full-day private-event guard: the event title when the whole
 *  date is closed to public booking, else null. */
export function raceSimPrivateEventTitle(date: string): string | null {
  if (getPublicReopenMinutes(date) != null) return null;
  return getGroupEventForDate(date)?.eventTitle ?? null;
}

/**
 * The sim item's riders as per-person timed bookings — racing's
 * raceHeatsMetadata shape, for findCrossBookingConflict. One entry per rider
 * with a BMI person id (riders without one have no identity to match, same
 * as racing). Roster = assignedTo, falling back to participants, then the
 * whole party (the kiosk stamps the whole party — racing's "everyone races").
 */
export function raceSimCartPersonHeats(
  item: RaceSimItem,
  party: PartyMember[],
): BookedPersonHeat[] {
  if (!item.slot) return [];
  const ids =
    item.assignedTo.length > 0
      ? item.assignedTo
      : item.participants && item.participants.length > 0
        ? item.participants
        : party.map((m) => m.id);
  const byId = new Map(party.map((m) => [m.id, m]));
  const out: BookedPersonHeat[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m?.bmiPersonId) continue;
    out.push({
      heatId: item.slot,
      track: RACE_SIM_CONFLICT_TRACK,
      bmiPersonId: m.bmiPersonId,
      racer: m.firstName ?? null,
    });
  }
  return out;
}

/**
 * Cart-internal kart↔sim spacing — the one case neither grid catches alone:
 * racing's heat grid checks only its own heats, so a kart heat picked AFTER a
 * held sim never sees it. The whole party rides the sim, so ANY kart heat in
 * the cart is the same person's booking; every (sim slot, kart heat) pair is
 * checked with racing's rule (cross-track: 30 min). Returns the first
 * offending pair, or null. Used by the reserve guard (fail-closed) and
 * mirrored on racing's grid by including cart sims in its cart-conflict set.
 */
export function findCartKartSimConflict(
  items: SessionItem[],
): { simSlot: string; heatId: string; track: string | null } | null {
  const sims = items.filter((i): i is RaceSimItem => i.kind === "racesim" && !!i.slot);
  if (sims.length === 0) return null;
  for (const other of items) {
    if (other.kind !== "race") continue;
    for (const h of other.heats) {
      if (!h.heatId) continue;
      const heatMs = wallClockMs(h.heatId);
      for (const sim of sims) {
        if (
          heatsConflict(wallClockMs(sim.slot!), RACE_SIM_CONFLICT_TRACK, heatMs, h.track ?? null)
        ) {
          return { simSlot: sim.slot!, heatId: h.heatId, track: h.track ?? null };
        }
      }
    }
  }
  return null;
}

/** Rejection copy for a cart-internal kart↔sim conflict. */
export function cartKartSimConflictMessage(c: { simSlot: string; heatId: string }): string {
  return `Your ${heatClockLabel(c.heatId)} race is too close to your ${heatClockLabel(c.simSlot)} sim session — racing and sims need 30 minutes between them. Please pick a different time.`;
}

/** Rejection copy for a sim cross-reservation conflict — racing's
 *  existingBookingConflictMessage, worded for a session. */
export function raceSimBookingConflictMessage(conflict: {
  cart: { heatId: string | null; racer?: string | null };
  existing: { heatId: string; track: string | null };
}): string {
  const who = conflict.cart.racer || "One of your riders";
  const what = conflict.existing.track === RACE_SIM_CONFLICT_TRACK ? "a sim session" : "a race";
  const cartLabel = conflict.cart.heatId ? heatClockLabel(conflict.cart.heatId) : "the selected";
  return `${who} already has ${what} booked at ${heatClockLabel(conflict.existing.heatId)} — too close to the ${cartLabel} session. Please pick a different time.`;
}
