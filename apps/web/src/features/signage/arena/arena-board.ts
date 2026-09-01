/**
 * HP Arena check-in board — the RULES. PURE: no React, no clock reads, no I/O.
 *
 * Same discipline as director/schedule.ts and everything else on this platform:
 * what a wall shows is derived from the shared clock and the facts, never
 * remembered, so two boards agree without talking and a screen that reboots
 * rejoins mid-stride.
 *
 * WHAT THIS BOARD IS, AND IS NOT (owner 2026-09-01: "we will not use a check in
 * board here — we simply call and check them in"):
 *
 * The karting check-in TV reports a PROCESS. It has a scan rail, a "6 of 14
 * checked in" counter and a handover the moment staff send the heat to a
 * briefing room. None of that exists at the arena: a marshal calls the session
 * over the PA and checks people in at the desk by hand. There is no scan event
 * to react to, no roster count to read, and no send to end on.
 *
 * So this board reports exactly one fact — THE CALL — and everything below is
 * about deciding when a call starts owning the wall and when it stops.
 */
import type { ArenaActivity } from "~/features/arena-tickets/types";

/**
 * WHAT A CALLED ARENA SESSION IS, AS FAR AS A WALL IS CONCERNED — the two real
 * activities plus `either`, for a session that genuinely is both.
 *
 * `either` exists because of birthday parties. A 30-day sweep of both venues
 * (2026-09-01) found 494 arena sessions at Fort Myers under four distinct type
 * strings, and ten of them were `"- Gel Blaster or Laser Tag"` — a party that has
 * booked the arena and will decide which game on the day. There is no fact of the
 * matter about which activity that session is, so the board must not invent one:
 * announcing "Laser Tag" to a group that is about to play Gel Blaster sends them
 * to the wrong half of the arena.
 */
export type ArenaBoardActivity = ArenaActivity | "either";

/** One arena session that has been called, as the board receives it. */
export interface ArenaCall {
  /** Pandora session id. A STRING, always — BMI ids exceed
   *  Number.MAX_SAFE_INTEGER and this one is round-tripped through JSON. */
  sessionId: string;
  activity: ArenaBoardActivity;
  /** The heat number staff and the guest's ticket both say ("Session 25"). */
  heatNumber: number | null;
  /** ISO, from the schedule. Null when the session record carried none. */
  scheduledStart: string | null;
  /** Shared-clock ms the session was called — the ONLY clock this board has. */
  calledAtMs: number;
}

/* ── identity ─────────────────────────────────────────────────────────── */

export const ARENA_ACTIVITY_LABELS: Record<ArenaBoardActivity, string> = {
  "laser-tag": "Laser Tag",
  "gel-blaster": "Gel Blasters",
  // Named the way the booking is: the group knows they booked "one or the
  // other", and the desk is where that gets settled.
  either: "Laser Tag or Gel Blasters",
};

/**
 * WHICH ACTIVITY A CALLED SESSION IS, for a wall.
 *
 * A DELIBERATE SUPERSET of `classifyArenaSession`, the arena-ticket cron's
 * classifier, and the two differences are both things the 30-day sweep turned up
 * rather than things imagined:
 *
 *  1. `"- Gel Blaster or Laser Tag"` (10 of 494 sessions at Fort Myers — birthday
 *     parties). The cron's classifier tests laser tag first and returns
 *     "laser-tag", which for a TEXT MESSAGE is a cosmetic inaccuracy. On a wall it
 *     is an instruction, so it resolves to `either` here.
 *  2. `"Nexus LaserTag"` (4 of 494) — no space. The cron's substring test misses
 *     it entirely, so those sessions get no check-in text at all; that is a real
 *     gap in the SMS path and is being reported separately rather than fixed from
 *     here, because changing that classifier changes who receives a text. This
 *     one collapses everything but letters and digits before matching, so the
 *     board is right about it either way.
 *
 * Anything that names neither game is null — a private hire or a maintenance
 * block on the arena resource is not this board's business, and putting a
 * session on the wall with no idea what it is would be worse than silence.
 */
export function classifyArenaBoardSession(
  text: string | null | undefined,
): ArenaBoardActivity | null {
  // Letters and digits only, so "Laser Tag", "LaserTag" and "laser-tag" are one
  // string by the time they are compared.
  const squashed = (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const laser = squashed.includes("lasertag");
  const gel = squashed.includes("gelblaster");
  if (laser && gel) return "either";
  if (laser) return "laser-tag";
  if (gel) return "gel-blaster";
  return null;
}

/**
 * Board colours for the two activities.
 *
 * The SAME two accents the kiosk billboard and the house ad slides already use
 * for these products (assets.ts: laser `#f800c6`, gel `#46d68c`), turned up the
 * way the track accents are — these sit on a near-black canvas and have to read
 * from across a lobby. A guest who has just watched the Laser Tag advert on this
 * screen sees their call arrive in the same colour.
 */
export const ARENA_ACTIVITY_ACCENTS: Record<ArenaBoardActivity, string> = {
  "laser-tag": "#ff3ad6",
  "gel-blaster": "#46d68c",
  // Neither of the two, on purpose: a session that could be either game must not
  // wear one game's colour, or the colour becomes the instruction and undoes the
  // point of naming it honestly.
  either: "#8ab4ff",
};

/** Where each activity's group is sent. Named the way staff name it on the
 *  floor — one destination per activity, not a room number nobody uses. */
export const ARENA_ACTIVITY_DESTINATIONS: Record<ArenaBoardActivity, string> = {
  "laser-tag": "the Laser Tag desk",
  "gel-blaster": "the Gel Blaster desk",
  // One desk, named once — staff sort out which game when the group arrives,
  // which is exactly what a party that booked "either" is expecting.
  either: "the arena desk",
};

/* ── how long a call owns the wall ────────────────────────────────────── */

/**
 * Default hold, in ms, measured from `calledAtMs`.
 *
 * KARTING ENDS A HEAT ON AN EVENT; THIS BOARD CANNOT. A track board lets go the
 * moment staff send the group to a briefing room — a fact about the operation,
 * not about elapsed minutes (owner 2026-08-11). The arena has no equivalent
 * press: nobody records "this group is checked in", because checking them in IS
 * the conversation at the desk.
 *
 * That leaves two honest signals, and the board uses both. Pandora drops a
 * session out of `sessions/current` about twenty minutes after the call, which
 * is the hard ceiling. Within that, the hold below is what decides when the
 * wall goes back to selling — ten minutes, comfortably longer than the walk from
 * anywhere in the building and comfortably shorter than the ~15-minute gap to
 * the next session, so a call never overlaps the following one.
 */
export const ARENA_HOLD_DEFAULT_MS = 10 * 60_000;
export const ARENA_HOLD_MIN_MS = 2 * 60_000;
export const ARENA_HOLD_MAX_MS = 20 * 60_000;

/**
 * A stored hold, made safe. ONE definition of what is legal, shared by the
 * config resolver and anything else that reads it, because the value arrives
 * from a hand-edited JSONB blob an older or newer deploy may have written.
 *
 * The clamp is not decoration: this number decides how long an instruction sits
 * on a wall. A fat-fingered value either pins the board on one session all
 * evening or drops it before the group has walked over.
 */
export function clampArenaHoldMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return ARENA_HOLD_DEFAULT_MS;
  return Math.min(ARENA_HOLD_MAX_MS, Math.max(ARENA_HOLD_MIN_MS, value));
}

/* ── which calls are live ─────────────────────────────────────────────── */

/**
 * The calls that own the wall right now — at most one per activity, newest
 * first.
 *
 * TWO AT ONCE IS THE NORMAL CASE, not an edge. Laser Tag and Gel Blaster run off
 * the ONE "HP Arena" dayplanner resource (arena-tickets/constants.ts), they
 * check in at the same desk, and a busy Saturday calls both inside the same
 * minute — verified in the 10-day probe behind this feature. A board that
 * showed only the newest would silently drop half the building's instructions,
 * so the scene lays out one panel per activity instead.
 *
 * ONE PER ACTIVITY, though: if Laser Tag 26 is called while Laser Tag 25 is
 * still holding, 25 is over — the desk has moved on, and two Laser Tag panels
 * would leave a guest choosing between them.
 *
 * THREE IS THE CEILING, not two: a birthday party booked as "either" is its own
 * kind and can be called alongside both scheduled games. Rare, and the scene
 * lays three out at a smaller size rather than dropping one — a called group
 * missing from the wall is the one outcome worth avoiding.
 *
 * A future-stamped call is dropped as firmly as an expired one. Clock skew on
 * the writer is not a reason to put an instruction on a wall, and the guard
 * carries a few seconds of slack so an ordinary round-trip is not mistaken for
 * skew.
 */
export function activeArenaCalls(
  calls: readonly ArenaCall[],
  nowMs: number,
  holdMs: number,
): ArenaCall[] {
  const hold = clampArenaHoldMs(holdMs);
  const newestByActivity = new Map<ArenaBoardActivity, ArenaCall>();
  for (const call of calls) {
    const age = nowMs - call.calledAtMs;
    if (age < -5_000 || age > hold) continue;
    const held = newestByActivity.get(call.activity);
    if (!held || call.calledAtMs > held.calledAtMs) newestByActivity.set(call.activity, call);
  }
  // Newest first, session id as the tie-break so the order is TOTAL: two boards
  // in the same building must lay the panels out in the same order, and two
  // calls can land in the same millisecond.
  return Array.from(newestByActivity.values()).sort(
    (a, b) => b.calledAtMs - a.calledAtMs || a.sessionId.localeCompare(b.sessionId),
  );
}

/**
 * The instant this takeover began — the EARLIEST live call, not the newest.
 *
 * This is the interrupt's `startedAtMs`, which is what `frameKey` keys a
 * non-event interrupt on. Anchoring on the earliest means a second activity
 * being called joins the board WITHOUT remounting it: the existing panel keeps
 * its place and the new one animates in beside it. Anchoring on the newest
 * would tear the whole scene down and replay both entrances every time the desk
 * called something — the "screen is freaking out" failure, from the same cause.
 *
 * Null when nothing is live, which is the caller's signal that there is no
 * takeover at all.
 */
export function arenaTakeoverStartMs(active: readonly ArenaCall[]): number | null {
  if (active.length === 0) return null;
  let earliest = active[0].calledAtMs;
  for (const call of active) if (call.calledAtMs < earliest) earliest = call.calledAtMs;
  return earliest;
}

/* ── the countdown ────────────────────────────────────────────────────── */

/**
 * Milliseconds left in the check-in window, or null when there is no window to
 * count.
 *
 * Counted from the CALL, exactly as the karting board counts (owner 2026-08-11):
 * "6:42 left" moves people and "check in by 7:45" does not. Never negative —
 * staff will still check somebody in at 8:01, and a wall announcing they have
 * missed it would be both unkind and untrue. The scene turns a zero into an
 * instruction instead.
 */
export function arenaCheckinRemainingMs(
  call: Pick<ArenaCall, "calledAtMs">,
  nowMs: number,
  windowMins: number,
): number {
  return Math.max(0, call.calledAtMs + windowMins * 60_000 - nowMs);
}

/** mm:ss, never negative. Same shape the track board prints. */
export function formatArenaCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
