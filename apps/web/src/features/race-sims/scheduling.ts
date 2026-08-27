/**
 * Race Sims scheduling rules — shared by the kiosk time grid (greys a card /
 * gates Continue) and the reserve guard (refuses the charge), so the two can
 * never disagree.
 *
 * A sim item carries MANY sessions (RaceSimItem.sessions — racing's heats[]),
 * each on a track, and picks accumulate across tracks like karting's
 * "add another race or track". The rules (owner 2026-08-26):
 *   - SIM vs SIM: the SAME time slot on any track is the same four rigs — a
 *     10:00 on Track A blocks 10:00 on B and C — and that is the ONLY sim-vs-sim
 *     rule: back-to-back sessions (10:00 then 10:15) are allowed, no gap.
 *   - SIM vs KART HEAT (and attractions / bowling): racing's cross-activity
 *     spacing, heatsConflict — 30 minutes to finish, walk over and check in.
 *   - CROSS-RESERVATION: the same rider's bookings in OTHER reservations today
 *     (raceHeatsForPersonsOnDate: karting heats + prior sim sessions), same two
 *     rules per rider.
 *   - GROUP EVENTS (lib/group-events): full-day private event, morning buyout
 *     reopen, event windows (karting-track extensions don't apply to sims).
 *   - CAPACITY and LEAD TIME live in the grid.
 *   Karting-only rules (tier/category, cross-category, pack caps, same-track
 *   skip-a-slot) deliberately do NOT apply to sims.
 */
import type {
  PartyMember,
  RaceSimItem,
  RaceSimSession,
  SessionItem,
} from "~/features/booking/state/types";
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
import { RACE_SIM_TRACKS, getRaceSimTrack } from "./products";

/** Fallback conflict label when a session has no resolvable track. */
export const RACE_SIM_TRACK_FALLBACK = "Race Sim";

/** The label a sim session carries in every conflict list AND in
 *  booking_metadata.racesims[].track — the track's display name ("Track A").
 *  Distinct from red/blue/mega, so heatsConflict treats sim-vs-kart as
 *  cross-track; isRaceSimTrackLabel recognizes it as a sim for the
 *  same-slot rule. */
export function raceSimConflictTrack(trackKey: string | null | undefined): string {
  return getRaceSimTrack(trackKey ?? null)?.name ?? RACE_SIM_TRACK_FALLBACK;
}

/** True when a timed booking is a sim session (its track is a sim label). */
export function isRaceSimTrackLabel(track: string | null | undefined): boolean {
  if (!track) return false;
  return track === RACE_SIM_TRACK_FALLBACK || RACE_SIM_TRACKS.some((t) => t.name === track);
}

/** Wall-clock ISO ("2026-08-26T15:00:00", optional trailing Z) → epoch ms,
 *  the same parse racing's grid and conflict helpers use. */
export function wallClockMs(iso: string): number {
  return new Date(iso.replace(/Z$/, "")).getTime();
}

export interface TimedBooking {
  startMs: number;
  /** Racing track name for heats, a sim track label for sim sessions, null
   *  for attractions/bowling (null = always the 30-min cross-activity rule). */
  track: string | null;
}

/** Does a candidate sim session at `candidateStartMs` conflict with one other
 *  timed booking? Sim-vs-sim = same start only; anything else = racing's
 *  cross-activity spacing. */
export function simConflictsWith(candidateStartMs: number, other: TimedBooking): boolean {
  if (isRaceSimTrackLabel(other.track)) return other.startMs === candidateStartMs;
  return heatsConflict(other.startMs, other.track, candidateStartMs, RACE_SIM_TRACK_FALLBACK);
}

/** Every timed booking in the cart EXCEPT item `excludeItemId`. Broader than
 *  racing's own grid (which only checks its race item's heats) — a rider
 *  can't be in two places, so the whole cart counts. */
export function cartTimedBookings(items: SessionItem[], excludeItemId: string): TimedBooking[] {
  const out: TimedBooking[] = [];
  for (const other of items) {
    if (other.id === excludeItemId) continue;
    if (other.kind === "race") {
      for (const h of other.heats) {
        if (h.heatId) out.push({ startMs: wallClockMs(h.heatId), track: h.track ?? null });
      }
    } else if (other.kind === "racesim") {
      for (const s of other.sessions) {
        out.push({ startMs: wallClockMs(s.slot), track: raceSimConflictTrack(s.trackKey) });
      }
    } else if (other.kind === "attraction") {
      if (other.slot) out.push({ startMs: wallClockMs(other.slot), track: null });
    } else if (other.kind === "bowling" || other.kind === "kbf") {
      if (other.bookedAt) out.push({ startMs: wallClockMs(other.bookedAt), track: null });
    }
  }
  return out.filter((b) => Number.isFinite(b.startMs));
}

/** Is a candidate sim session too close to any of `others`? */
export function raceSimSlotConflicts(candidateStartMs: number, others: TimedBooking[]): boolean {
  return others.some((o) => simConflictsWith(candidateStartMs, o));
}

/** The item's own pick that occupies this start on ANOTHER track, if any —
 *  the "10:00 on Track A blocks 10:00 on B and C" rule, for the card label. */
export function ownPickAtSameStart(
  sessions: RaceSimSession[],
  start: string,
  currentTrackKey: string | null,
): RaceSimSession | null {
  const ms = wallClockMs(start);
  return sessions.find((s) => s.trackKey !== currentTrackKey && wallClockMs(s.slot) === ms) ?? null;
}

/** The wizard gate's self-check (racing's canAdvanceFor): two of the item's
 *  own sessions on the same start. Returns the pair or null. */
export function findRaceSimSelfConflict(
  sessions: RaceSimSession[],
): { a: RaceSimSession; b: RaceSimSession } | null {
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      if (wallClockMs(sessions[i].slot) === wallClockMs(sessions[j].slot)) {
        return { a: sessions[i], b: sessions[j] };
      }
    }
  }
  return null;
}

/** Racing's "Reserved for event" rule: the session overlaps an event-window
 *  reservation on this date. Karting-track-scoped extensions never apply to a
 *  sim (raceWindowAppliesToTrack with a null track). */
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

/** The item's riders for the cross-reservation guard — racing's
 *  raceHeatsMetadata shape: one row per (session × rider with a BMI id).
 *  Roster = assignedTo → participants → whole party (the kiosk stamps the
 *  whole party — racing's "everyone races"). */
export function raceSimCartPersonHeats(
  item: RaceSimItem,
  party: PartyMember[],
): BookedPersonHeat[] {
  if (item.sessions.length === 0) return [];
  const ids =
    item.assignedTo.length > 0
      ? item.assignedTo
      : item.participants && item.participants.length > 0
        ? item.participants
        : party.map((m) => m.id);
  const byId = new Map(party.map((m) => [m.id, m]));
  const out: BookedPersonHeat[] = [];
  for (const s of item.sessions) {
    for (const id of ids) {
      const m = byId.get(id);
      if (!m?.bmiPersonId) continue;
      out.push({
        heatId: s.slot,
        track: raceSimConflictTrack(s.trackKey),
        bmiPersonId: m.bmiPersonId,
        racer: m.firstName ?? null,
      });
    }
  }
  return out;
}

/** Cross-reservation check for sim rows — racing's findCrossBookingConflict
 *  with the sim rules: per rider, an existing SIM at the same start collides;
 *  an existing kart heat needs racing's 30-minute spacing. */
export function findRaceSimCrossBookingConflict(
  cartSims: BookedPersonHeat[],
  existingHeats: BookedPersonHeat[],
): { cart: BookedPersonHeat; existing: BookedPersonHeat } | null {
  for (const c of cartSims) {
    if (!c.bmiPersonId || !c.heatId) continue;
    const cMs = wallClockMs(c.heatId);
    if (!Number.isFinite(cMs)) continue;
    for (const e of existingHeats) {
      if (!e.bmiPersonId || e.bmiPersonId !== c.bmiPersonId || !e.heatId) continue;
      const eMs = wallClockMs(e.heatId);
      if (!Number.isFinite(eMs)) continue;
      if (simConflictsWith(cMs, { startMs: eMs, track: e.track })) return { cart: c, existing: e };
    }
  }
  return null;
}

/**
 * Cart-internal kart↔sim spacing — the one case neither grid catches alone:
 * racing's heat grid checks only its own heats, so a kart heat picked AFTER a
 * held sim never sees it. The whole party rides every sim session, so ANY
 * kart heat in the cart is the same person's booking; every (session, heat)
 * pair is checked with racing's cross-activity rule (30 min). Returns the
 * first offending pair, or null.
 */
export function findCartKartSimConflict(
  items: SessionItem[],
): { simSlot: string; heatId: string; track: string | null } | null {
  const sessions = items.flatMap((i) => (i.kind === "racesim" ? i.sessions : []));
  if (sessions.length === 0) return null;
  for (const other of items) {
    if (other.kind !== "race") continue;
    for (const h of other.heats) {
      if (!h.heatId) continue;
      const heatMs = wallClockMs(h.heatId);
      for (const s of sessions) {
        if (
          heatsConflict(
            wallClockMs(s.slot),
            raceSimConflictTrack(s.trackKey),
            heatMs,
            h.track ?? null,
          )
        ) {
          return { simSlot: s.slot, heatId: h.heatId, track: h.track ?? null };
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
  const cartLabel = conflict.cart.heatId ? heatClockLabel(conflict.cart.heatId) : "the selected";
  if (isRaceSimTrackLabel(conflict.existing.track)) {
    return `${who} already has a sim session at ${heatClockLabel(conflict.existing.heatId)} — the same time as the ${cartLabel} session. Please pick a different time.`;
  }
  return `${who} already has a race booked at ${heatClockLabel(conflict.existing.heatId)} — too close to the ${cartLabel} session. Please pick a different time.`;
}
