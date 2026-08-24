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
 *   7  the film no longer fits            — ONLY when the gear's override is
 *                                          switched off; otherwise it warns
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

/**
 * `noTime` rides on the ALLOWED verdict, not as a refusal (owner 2026-08-24:
 * "instead of complete lock on send to briefing, allow it but prompt a big
 * warning message"). The press is the desk's to make; what the surfaces owe is
 * a warning nobody can walk past by accident.
 */
export type PullVerdict =
  | { ok: true; late: boolean; noTime: boolean }
  | { ok: false; reason: PullRefusal };

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
   * MAY staff override a no-time send? The gear setting, default TRUE (owner
   * 2026-08-24: "make this a toggle in settings… default to allow the
   * override"). False restores the 8/23 hard lock, which is why the refusal it
   * produces still exists.
   */
  overrideAllowed?: boolean;
  /**
   * The film no longer fits in the race left on track — `sendWindow(...)` came
   * back `blocked`.
   *
   * WAS A REFUSAL, NOW A WARNING (owner 2026-08-23 "stop them from pushing a
   * group to briefing if they don't have time", revised 2026-08-24 "instead of
   * complete lock… allow it but prompt a big warning"). A dead button is the
   * wrong tool for a judgement the person at the desk can make and this rule
   * cannot: a film overrunning by a few seconds against a group already
   * standing there is theirs to weigh. So both surfaces still allow the press
   * and put an unmissable confirm in front of it.
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

  // A no-time send is a WARNING when the override is allowed (the default) and
  // a refusal when staff have switched the override off. Either way it is last:
  // a short roster is fixed by scanning, which staff can do while they wait.
  if (input.noTime && input.overrideAllowed === false) {
    return { ok: false, reason: "no-time" };
  }
  // Reported alongside `late` so a caller cannot render one and forget the
  // other; the confirm copy each surface shows is its own.
  return { ok: true, late: input.late === true, noTime: input.noTime === true };
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
 *   grace    past the deadline, one minute of it: red, counting down, and the
 *            send is still the desk's to make
 *   blocked  the grace is gone too — the send WARNS HARD (a full-screen
 *            confirm) rather than dying; see PullInput.noTime
 *
 * THE BLOCK LIFTS AT THE POST, NOT THE FLAG (owner 2026-08-23: "unlocked at
 * post race… if it even exists"). The finishing group's post-race announcement
 * plays into this exact room, and it cannot start over a film (postRaceGate,
 * pit/audio.server.ts) — so the send stays WARNED through the chequer until
 * the post has finished. "If it even exists" is the fallback: a post that has
 * not fired within POST_WAIT_MAX_MS of the finish is not coming, and the block
 * lifts on its own rather than outwait a dead cue. No pit fact beyond the post
 * is read — the owner scoped out holding the room for the kit handback.
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
/**
 * THE ONE-MINUTE GRACE, and it sits AFTER the deadline, not before (owner
 * 2026-08-23: "give them a 1 minute grace period where check in blinks red as
 * they're out of time to send to briefing" — and, on seeing a hard lock at 4:52
 * against a 5:00 need, "it did not give me grace period").
 *
 * So the moment the film stops fitting is NOT the lock. It is the start of a
 * minute in which the desk may still send — the board turns red and counts the
 * grace down, because staff standing with the group in front of them are better
 * placed than this rule to judge a film that overruns by twenty seconds. Only
 * when the grace is gone does the button die: past that the film cannot land
 * before the flag by any reading, and the group's own post-race call is next.
 */
export const SEND_GRACE_MS = 60_000;
/** How long after the finish a still-unplayed post counts as NOT COMING. The
 *  cue normally fires within a minute or two of the flag; a block that waits
 *  longer than this is waiting on a dead speaker, not an announcement. */
export const POST_WAIT_MAX_MS = 4 * 60_000;

export type SendWindow =
  | { kind: "quiet" }
  | { kind: "early"; standMs: number; opensInMs: number }
  | { kind: "open"; remainingMs: number; closesInMs: number }
  /**
   * PAST THE DEADLINE, INSIDE THE GRACE. The film no longer fits cleanly, the
   * board is red, and the send is STILL THE DESK'S TO MAKE for `graceLeftMs`.
   */
  | { kind: "grace"; remainingMs: number; graceLeftMs: number; overBy: number }
  | {
      kind: "blocked";
      /** film: the grace is gone too. post-owed: flag fallen, announcement
       *  still to play into this room. post-playing: it is playing right now. */
      why: "film" | "post-owed" | "post-playing";
      heatNumber: number | null;
      /** Time left on the race in front (why: "film"), else null. */
      remainingMs: number | null;
      /** Time until the playing post ends (why: "post-playing"), else null. */
      postEndsInMs: number | null;
    };

/** The finishing group's post-race announcement, as the caller's lane feed
 *  sees it. Null when nothing is owed — no group in the pit, or its post has
 *  already finished playing. */
export type PitPost =
  | { phase: "owed"; heatNumber: number | null; sinceFinishMs: number | null }
  | { phase: "playing"; heatNumber: number | null; endsInMs: number };

/**
 * `attribution` is the Mega-night question — both columns read the same track
 * clock, but the "session ends in" warning belongs only on the side the group
 * on track will walk back to (owner 2026-08-18):
 *
 *   this-room   every state may fire, including the hard block
 *   unknown     the block downgrades to `grace`: warn both sides, freeze
 *               neither, because a hand-placed group carries no room and a
 *               refusal that cannot attribute itself may be refusing the send
 *               that is actually fine
 *   other-room  `grace`/`blocked` go quiet; `early`/`open` still speak —
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
  /** The post-race announcement owed to (or playing into) this room. */
  pitPost: PitPost | null;
  attribution: "this-room" | "unknown" | "other-room";
}): SendWindow {
  const gate = (blocked: SendWindow & { kind: "blocked" }): SendWindow => {
    if (args.attribution === "this-room") return blocked;
    if (args.attribution === "other-room") return { kind: "quiet" };
    return {
      kind: "grace",
      remainingMs: blocked.remainingMs ?? 0,
      graceLeftMs: 0,
      overBy: 0,
    };
  };

  // THE POST OWNS THE ROOM FIRST. It outranks the clock ladder because it can
  // outlive the flag — and even overlap the next race going green.
  if (args.pitPost) {
    if (args.pitPost.phase === "playing")
      return gate({
        kind: "blocked",
        why: "post-playing",
        heatNumber: args.pitPost.heatNumber,
        remainingMs: null,
        postEndsInMs: args.pitPost.endsInMs,
      });
    // "If it even exists": an owed post that has not fired within the wait cap
    // is not coming, and must stop blocking on its own.
    const dead =
      args.pitPost.sinceFinishMs != null && args.pitPost.sinceFinishMs > POST_WAIT_MAX_MS;
    if (!dead)
      return gate({
        kind: "blocked",
        why: "post-owed",
        heatNumber: args.pitPost.heatNumber,
        remainingMs: null,
        postEndsInMs: null,
      });
  }

  // A clock at or past zero is a race that is OVER, however long the feed
  // lingers on it — with no post owed the track is simply waiting, holding the
  // group buys nothing, and the block must lift or a stalled countdown wedges
  // the room.
  if (args.remainingMs == null || args.remainingMs <= 0 || !args.onTrack) return { kind: "quiet" };
  const needMs = (args.filmMs ?? DEFAULT_FILM_MS) + ROOM_EXIT_MS;
  const r = args.remainingMs;

  // PAST THE DEADLINE BY MORE THAN THE GRACE — now it is a refusal.
  if (r < needMs - SEND_GRACE_MS) {
    return gate({
      kind: "blocked",
      why: "film",
      heatNumber: args.onTrackHeatNumber,
      remainingMs: r,
      postEndsInMs: null,
    });
  }
  // INSIDE THE GRACE. Red, counting down, still sendable. Suppressed on the
  // other Mega room for the same reason every other warning is: the returning
  // group is not walking back into that one.
  if (r < needMs) {
    if (args.attribution === "other-room") return { kind: "quiet" };
    return {
      kind: "grace",
      remainingMs: r,
      graceLeftMs: r - (needMs - SEND_GRACE_MS),
      overBy: needMs - r,
    };
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
