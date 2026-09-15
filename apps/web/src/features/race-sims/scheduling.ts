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
import { RACE_SIM_TRACKS, getRaceSimTrack, type RaceSimTrackKey } from "./products";

/** Fallback conflict label when a session has no resolvable track. */
export const RACE_SIM_TRACK_FALLBACK = "Race Sim";

/** The label a sim session carries in every conflict list AND in
 *  booking_metadata.racesims[].track — the track KEY's stable label
 *  ("Track A"), never the circuit running on it. Distinct from
 *  red/blue/mega, so heatsConflict treats sim-vs-kart as cross-track;
 *  isRaceSimTrackLabel recognizes it as a sim for the same-slot rule.
 *
 *  Guest-facing surfaces must NOT call this — they want
 *  circuits.ts `circuitForTrack(key, date)`. This string outlives every
 *  lineup on purpose: it is matched against rows written months ago. */
export function raceSimConflictTrack(trackKey: string | null | undefined): string {
  return getRaceSimTrack(trackKey ?? null)?.conflictLabel ?? RACE_SIM_TRACK_FALLBACK;
}

/** True when a timed booking is a sim session (its track is a sim label).
 *  Matches only the STABLE key labels, which is why they may never change:
 *  every sim ever sold is recognised here, whatever circuit it ran. */
export function isRaceSimTrackLabel(track: string | null | undefined): boolean {
  if (!track) return false;
  return (
    track === RACE_SIM_TRACK_FALLBACK || RACE_SIM_TRACKS.some((t) => t.conflictLabel === track)
  );
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

/**
 * The item's own picks that BMI is no longer proposing on the shown grid —
 * one per start, preferring the shown track's session. Every sim track books
 * the same four rigs and BMI's availability only returns blocks with
 * freeSpots ≥ the requested quantity (never a full block), so our own hold
 * can make a picked start disappear: a party of 4 loses its SELECTED card on
 * the next poll, and a 4:15 picked on Track A vanishes from Track B instead
 * of reading "Picked on Track A". The grid synthesizes cards for these.
 */
export function ownSessionsMissingFromGrid(
  sessions: RaceSimSession[],
  shownStarts: string[],
  gridDate: string,
  currentTrackKey: string | null,
): RaceSimSession[] {
  const shown = new Set(shownStarts.map(wallClockMs));
  const byStart = new Map<number, RaceSimSession>();
  for (const s of sessions) {
    if (s.slot.slice(0, 10) !== gridDate) continue;
    const ms = wallClockMs(s.slot);
    if (!Number.isFinite(ms) || shown.has(ms)) continue;
    const prev = byStart.get(ms);
    if (!prev || (s.trackKey === currentTrackKey && prev.trackKey !== currentTrackKey)) {
      byStart.set(ms, s);
    }
  }
  return [...byStart.values()].sort((a, b) => wallClockMs(a.slot) - wallClockMs(b.slot));
}

// ── One session runs ONE circuit: the per-slot lock ────────────────────────
//
// There are four rigs and one shared capacity pool, so a 10:00 session is four
// rigs running ONE circuit. The first booking on a slot therefore fixes which
// $0 track key — and so which circuit — that slot runs; everyone who joins it
// afterwards books the same key (owner 2026-09-15). Without this, two parties
// could hold the same four rigs on Baku and Bristol and the desk would have to
// tell one of them no, after they had paid.
//
// The grid reads locks to show "10:00 — BRISTOL" instead of an open picker;
// guard 2f re-checks at reserve, because the grid's copy can be seconds stale
// and the guest who picked second must be refused BEFORE the Square write.

/** A slot already claimed by a live booking, and the track key it runs. */
export interface SimSlotLock {
  /** Wall-clock ISO slot start, exactly as persisted. */
  slot: string;
  trackKey: RaceSimTrackKey;
}

/** Locks keyed by slot-start epoch ms — the grid asks per card, so the lookup
 *  has to be O(1) and tolerant of the Z-suffix drift between sources. */
export function simSlotLockIndex(locks: readonly SimSlotLock[]): Map<number, RaceSimTrackKey> {
  const index = new Map<number, RaceSimTrackKey>();
  for (const lock of locks) {
    const ms = wallClockMs(lock.slot);
    if (!Number.isFinite(ms)) continue;
    // First writer wins: the earliest booking owns the slot's circuit, and a
    // later row must never silently re-point it.
    if (!index.has(ms)) index.set(ms, lock.trackKey);
  }
  return index;
}

/** The track key a slot is locked to, or null when it is still unclaimed and
 *  the guest may pick any circuit. */
export function lockedTrackKeyForSlot(
  index: Map<number, RaceSimTrackKey>,
  startIso: string,
): RaceSimTrackKey | null {
  const ms = wallClockMs(startIso);
  return Number.isFinite(ms) ? (index.get(ms) ?? null) : null;
}

/** The cart's OWN sim picks as locks. A guest who picks 10:00 Bristol has
 *  claimed 10:00 for Bristol just as firmly as a stranger would have — this is
 *  what stops one cart booking two circuits into one session. */
export function cartSimSlotLocks(items: SessionItem[]): SimSlotLock[] {
  const out: SimSlotLock[] = [];
  for (const item of items) {
    if (item.kind !== "racesim") continue;
    for (const s of item.sessions) {
      if (s.trackKey === "a" || s.trackKey === "b" || s.trackKey === "c") {
        out.push({ slot: s.slot, trackKey: s.trackKey });
      }
    }
  }
  return out;
}

/**
 * The first pick that wants a circuit the slot is already locked to something
 * else for — the guard's and the wizard gate's shared check. Returns the
 * offending session plus the key the slot actually runs, or null.
 */
export function findSimCircuitClash(
  sessions: readonly RaceSimSession[],
  index: Map<number, RaceSimTrackKey>,
): { session: RaceSimSession; lockedTo: RaceSimTrackKey } | null {
  for (const s of sessions) {
    const locked = lockedTrackKeyForSlot(index, s.slot);
    if (locked && locked !== s.trackKey) return { session: s, lockedTo: locked };
  }
  return null;
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
 * Cart-internal spacing between the cart's sim sessions and its OTHER timed
 * activities — the case no single grid can be trusted with: racing's heat grid
 * checks only its own heats, and an attraction/bowling picked AFTER a held
 * sim may never have seen it. The whole party rides every sim session, so any
 * other timed item in the cart is the same people's booking; every (session,
 * activity) pair is checked with racing's cross-activity rule (30 min).
 * Returns the first offending pair (heatId = the other activity's start as an
 * epoch ISO), or null. Sim-vs-sim across items is findRaceSimSelfConflict's job.
 */
export function findCartKartSimConflict(
  items: SessionItem[],
): { simSlot: string; heatId: string; track: string | null; kind: SessionItem["kind"] } | null {
  const sessions = items.flatMap((i) => (i.kind === "racesim" ? i.sessions : []));
  if (sessions.length === 0) return null;
  const others = items.flatMap((i) =>
    i.kind === "racesim" ? [] : cartTimedBookings([i], "").map((b) => ({ ...b, kind: i.kind })),
  );
  for (const o of others) {
    for (const s of sessions) {
      if (
        heatsConflict(wallClockMs(s.slot), raceSimConflictTrack(s.trackKey), o.startMs, o.track)
      ) {
        return {
          simSlot: s.slot,
          heatId: new Date(o.startMs).toISOString(),
          track: o.track,
          kind: o.kind,
        };
      }
    }
  }
  return null;
}

/** Rejection copy for a cart-internal sim↔activity conflict. */
export function cartKartSimConflictMessage(c: {
  simSlot: string;
  heatId: string;
  kind?: SessionItem["kind"];
}): string {
  const what = c.kind === "race" ? "race" : c.kind === "attraction" ? "activity" : "booking";
  // heatId is an epoch ISO here; label it in the same local wall-clock terms
  // every grid parses with.
  const otherLabel = new Date(c.heatId).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Your ${otherLabel} ${what} is too close to your ${heatClockLabel(c.simSlot)} sim session — activities need 30 minutes between them. Please pick a different time.`;
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
