/**
 * MAY THIS ROOM FETCH THE NEXT GROUP ITSELF? PURE — facts in, one verdict out.
 *
 * The room tablet has always KNOWN when the next heat was fully through the desk
 * — its band goes green and says READY TO PULL — and then asked the staff member
 * to walk to the front desk and press somebody else's button. This is that
 * button, on the wall, with the owner's one condition on it (2026-08-16): "allow
 * them to pull to room… IF and only if all racers are checked in".
 *
 * IT IS THE SAME SEND. Pressing this runs exactly the desk's `send` action —
 * same server call, same insurance log, same film resolution. Nothing about a
 * pull is a second way of doing a briefing; only who is standing where when the
 * decision is taken.
 *
 * WHY A VERDICT AND NOT A BOOLEAN. A dead button with no sentence on it is a
 * fault report — staff press it, nothing happens, and they walk to the desk
 * anyway having lost the ten seconds. Every refusal here carries the reason the
 * screen prints, in the words the person holding the tablet would use.
 *
 * THE ORDER IS THE DESIGN. First match wins, and the earlier a rule sits the
 * more it is about something the staff member cannot fix by waiting:
 *
 *   1  the kill switch is thrown          — nothing on this screen will send
 *   2  nothing is checking in             — there is nobody to fetch
 *   3  the heat already went to a room    — including this one
 *   4  a group is still in this room      — send them to holding first
 *   5  the roster is short                — THE OWNER'S CONDITION
 *   6  the roster could not be read       — 0 of 0 is not "everybody is here"
 *   7+ clear
 *
 * WHY 4 REFUSES RATHER THAN OFFERING "REPLACE". The desk may replace a room's
 * group behind a confirm, and should: it is arbitrating between two heats it can
 * see the whole night for. From inside the room, replacing means overwriting a
 * group who are watching the film three feet in front of you, and the correct
 * move is always the one the screen already asks for — send them to holding, and
 * the pull appears in the panel that just cleared.
 */

export type PullRefusal =
  | "disabled"
  | "no-heat"
  | "already-sent"
  | "room-occupied"
  | "not-all-checked-in"
  | "no-roster";

export type PullVerdict = { ok: true; late: boolean } | { ok: false; reason: PullRefusal };

export interface PullInput {
  /** The briefing kill switch. Undefined on an older board ⇒ treated as on. */
  enabled: boolean | undefined;
  /** The heat currently checking in for this room's track. */
  incoming: { sessionId: string; heatNumber: number | null } | null;
  /** Which room this heat has already gone to, if any. */
  sentToRoom: "red" | "blue" | null;
  /** The heat already in THIS room, if any. */
  inRoomHeatNumber: number | null;
  /** Whether this room holds a live session at all. */
  roomOccupied: boolean;
  /** The desk's count for the incoming heat. */
  checkedIn: { checkedIn: number; total: number } | null;
  /**
   * Is the pull going in late — see `pullIsLate`. Never a refusal: a late pull
   * is often the right call with the group standing in front of you, so this
   * only changes what the button says and how it is coloured.
   */
  late?: boolean;
}

export function pullVerdict(input: PullInput): PullVerdict {
  if (input.enabled === false) return { ok: false, reason: "disabled" };
  if (!input.incoming) return { ok: false, reason: "no-heat" };
  if (input.sentToRoom) return { ok: false, reason: "already-sent" };
  if (input.roomOccupied) return { ok: false, reason: "room-occupied" };

  const count = input.checkedIn;
  // A roster that read back empty is UNKNOWN, not complete. Distinguished from
  // a short roster because the two ask different things of staff: one is "go on
  // scanning", the other is "the desk cannot see this heat yet".
  if (!count || count.total <= 0) return { ok: false, reason: "no-roster" };
  if (count.checkedIn < count.total) return { ok: false, reason: "not-all-checked-in" };

  return { ok: true, late: input.late === true };
}

/**
 * HOW LONG BEFORE A PULL IS "LATE" (owner 2026-08-16: "add a warning to check in
 * board and this board we try to pull to room with under 5 minutes").
 *
 * Measured against the race ON TRACK: pull a group with less time than that left
 * and the safety film is still running when the seats need filling, so the next
 * race waits on this room. Five minutes is the owner's number, not a derived
 * one — it is roughly a briefing film plus the walk.
 */
export const PULL_LATE_MS = 5 * 60_000;

/**
 * Is a pull going in late, and by how much.
 *
 * TWO NUMBERS OR NOTHING. The warning names the time left on track AND the
 * film's own length, because the first without the second is just a clock —
 * "2:40 left" only becomes a decision when you know the film runs 4:30. With no
 * film length known the warning still fires (the clock is the fact that
 * matters); the sentence simply stops short.
 *
 * A FINISHED RACE IS THE LATEST OF ALL. `remainingMs` of zero, or a track with
 * nothing on it and a group already in the pit, is the case where the seats are
 * wanted now — so it warns rather than falling through the `> 0` test into
 * silence.
 */
export function pullIsLate(args: {
  /** Time left on the race on track. Null when nothing is running. */
  remainingMs: number | null;
  /** Is a group in the pit awaiting their post-race announcement? */
  pitInOccupied: boolean;
  /** Is anything actually out on track? */
  onTrack: boolean;
}): boolean {
  if (args.remainingMs != null) return args.remainingMs < PULL_LATE_MS;
  // No clock. A group in the pit means the track has just emptied and the next
  // one is wanted; an empty track with an empty pit is an early evening lull,
  // which is the opposite of late.
  return !args.onTrack && args.pitInOccupied;
}
