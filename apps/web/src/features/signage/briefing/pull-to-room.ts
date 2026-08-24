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
 *   7  the film no longer fits            — see `sendWindow` (owner 2026-08-23)
 *   8+ clear
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
  | "no-roster"
  | "no-time";

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
  /**
   * The film no longer fits in the race left on track — `sendWindow(...)` came
   * back `blocked` (owner 2026-08-23: "stop them from pushing a group to
   * briefing if they don't have time"). A REFUSAL, unlike `late`: by the time
   * the window is gone, sending buys nothing that waiting for the chequer does
   * not, and the block lifts by itself the moment the race ends.
   */
  noTime?: boolean;
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

  // LAST on purpose: a short roster is fixed by scanning, and staff can scan
  // while they wait for the window to come back — so the roster sentence is
  // the useful one until the grid is fully through the desk.
  if (input.noTime) return { ok: false, reason: "no-time" };

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
/* ────────────────────────────────────────────────────────────────────────────
 * THE SEND WINDOW — the same two numbers the late warning already reads (time
 * left on the race in front, and how long this heat's film runs), turned into
 * a verdict instead of an "anyway" button (owner 2026-08-23: "stop them from
 * pushing a group to briefing if they don't have time").
 *
 * Four states, in the order a night moves through them:
 *
 *   early    sent now, the group just stands at the grid (median 6:40 over
 *            8/18–8/22 — the single biggest waste the data found)
 *   open     film lands as the track clears — the ideal
 *   closing  the window's last seconds; the board gets loud, the button stays
 *   blocked  the film no longer fits in the race left — the send is REFUSED
 *
 * The block lifts on its own at the chequer: with the track already waiting,
 * holding the group back buys nothing, so an ended race is `quiet`, not
 * `blocked`. Nothing here reads the pit lane or holds the room for returners
 * — the owner explicitly scoped that out.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Helmets on and out the door — the room time that follows the film. */
export const ROOM_EXIT_MS = 30_000;
/** When no film length is known, assume the starter film (4:30) — with the
 *  exit above this lands on the owner's own five-minute rule. */
export const DEFAULT_FILM_MS = 4.5 * 60_000;
/** How far above (film + exit) the window still counts as `open`. Below the
 *  top of this band a send releases the group onto a track that is about to
 *  clear; above it they stand. 2:30 ≈ the measured ideal 2:00 hold + walk. */
export const SEND_OPEN_SLACK_MS = 2.5 * 60_000;
/** The window's last stretch above (film + exit) — the board turns loud here,
 *  because past it the send is refused, not warned. */
export const SEND_CLOSING_SPAN_MS = 45_000;

export type SendWindow =
  | { kind: "quiet" }
  | { kind: "early"; standMs: number; opensInMs: number }
  | { kind: "open"; remainingMs: number; closesInMs: number }
  | { kind: "closing"; remainingMs: number; closesInMs: number }
  | { kind: "blocked"; heatNumber: number | null; remainingMs: number };

/**
 * `attribution` is the Mega-night question — both columns read the same track
 * clock, but the "session ends in" warning belongs only on the side the group
 * on track will walk back to (owner 2026-08-18):
 *
 *   this-room   every state may fire, including the hard block
 *   unknown     the block downgrades to `closing`: warn both sides, freeze
 *               neither, because a hand-placed group carries no room and a
 *               refusal that cannot attribute itself may be refusing the send
 *               that is actually fine
 *   other-room  `closing`/`blocked` go quiet; `early`/`open` still speak —
 *               that side is exactly where the next group SHOULD go
 */
export function sendWindow(args: {
  /** Time left on the race on track. Null when nothing is running. */
  remainingMs: number | null;
  /** Is anything actually out on track? */
  onTrack: boolean;
  /** The heat currently on track, for the block's sentence. */
  onTrackHeatNumber: number | null;
  /** The film THIS heat will actually get. Null ⇒ assume the starter film. */
  filmMs: number | null;
  attribution: "this-room" | "unknown" | "other-room";
}): SendWindow {
  // A clock at or past zero is a race that is OVER, however long the feed
  // lingers on it — the track is waiting, holding the group buys nothing, and
  // the block must lift here or a stalled countdown wedges the room.
  if (args.remainingMs == null || args.remainingMs <= 0 || !args.onTrack) return { kind: "quiet" };
  const needMs = (args.filmMs ?? DEFAULT_FILM_MS) + ROOM_EXIT_MS;
  const r = args.remainingMs;

  if (r < needMs) {
    if (args.attribution === "other-room") return { kind: "quiet" };
    if (args.attribution === "unknown") return { kind: "closing", remainingMs: r, closesInMs: 0 };
    return { kind: "blocked", heatNumber: args.onTrackHeatNumber, remainingMs: r };
  }
  if (r < needMs + SEND_CLOSING_SPAN_MS) {
    if (args.attribution === "other-room") return { kind: "quiet" };
    return { kind: "closing", remainingMs: r, closesInMs: r - needMs };
  }
  if (r > needMs + SEND_OPEN_SLACK_MS)
    return { kind: "early", standMs: r - needMs, opensInMs: r - needMs - SEND_OPEN_SLACK_MS };
  return { kind: "open", remainingMs: r, closesInMs: r - needMs };
}

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
