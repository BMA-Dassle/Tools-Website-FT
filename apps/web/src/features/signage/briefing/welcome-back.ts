/**
 * When does a briefing room greet its group BACK? PURE — numbers in, boolean out.
 *
 * The flow (owner 2026-08-11): a group is briefed, races, and walks back into the
 * SAME room to return kit. The wall should say welcome back — return helmets to
 * the shelves, cameras to the attendant, restate the qualifying time, and say
 * where the scores are posted.
 *
 * THE SIGNAL IS THE TIMING SYSTEM'S OWN `actualEnd`, not a guess (owner: "we know
 * exactly when a session finishes — don't guess"). The VIP experience board
 * already reads it: Pandora's per-track sessions list stamps actualStart/actualEnd
 * when the timing system starts and ends a heat, and
 * reservations-admin/race-live-state.server reads it live per poll for this
 * board (owner budget: "15 seconds, no more"). A first cut here derived the
 * moment from "the next heat was called" plus elapsed time; that heuristic is
 * deleted, not layered under this.
 *
 * The window opens AT the session's actual end and holds long enough for the walk
 * back and the kit return, then the room falls back to helmet sizes — a greeting
 * left up into the evening is just wrong signage. The board itself only shows
 * while the room is otherwise IDLE: a playing video, a take-a-seat hold or the
 * helmet phase all outrank it (owner: "AS LONG AS A VIDEO IS NOT PLAYING").
 */

/**
 * Is the welcome-back window open for a session that actually ended at
 * `actualEndMs`? Null/unparseable means the session has not ended — the timing
 * system stamps the field only when the heat truly stops.
 *
 * NO TIME CEILING, deliberately (owner 2026-08-11: "the return screen can stay
 * up till the next briefing video plays"). What retires the greeting is the
 * room's own life, not a clock: the next send occupies the room (any live
 * timeline outranks this board), and the resolver always reads the LATEST
 * briefed group, so an older group's greeting can never outlive a newer one.
 * The business-day scope on the assignment lookup is what stops yesterday's
 * greeting reappearing tomorrow.
 */
export function welcomeBackWindowOpen(actualEndMs: number | null): boolean {
  return actualEndMs != null && Number.isFinite(actualEndMs);
}

/**
 * ...AND WHEN IT IS FINALLY DONE (owner 2026-08-23/24, watching a red room hold
 * an exit sign for 30+ minutes with nobody in it: "is the screen ever going to
 * clear?" — "after the leave room finally finishes I'd like to go to the
 * session overview that pit goes to when it has nothing").
 *
 * THIS REVERSES THE 2026-08-11 "no time ceiling" DECISION, deliberately and in
 * one place. That call was right for the flow as it then was — a room went
 * straight from one group to the next, so the next briefing always retired the
 * greeting soon enough. It stopped being right once rooms began idling between
 * groups: the retiring condition was another group's arrival, and on a quiet
 * stretch that never came.
 *
 * TWO WAYS TO BE FINISHED, and the first is the real one:
 *
 *   1. THE POST HAS PLAYED AND THEY HAVE HAD THEIR MOMENT. The post-race
 *      announcement is what calls the group back in; `lingerAfterMs` past it is
 *      the span the greeting already uses for "are they still moving in here".
 *      Once that is spent, the group has been thanked and pointed at the door
 *      and the screen has no audience left.
 *
 *   2. NOTHING EVER CAME. A post that never fires must not pin the screen up
 *      for the night — and tonight it fired 25 minutes after the flag, so this
 *      is not hypothetical. `HARD_CAP_AFTER_END_MS` from the race's own end is
 *      the backstop, measured from the one stamp that always exists.
 *
 * Not a guess at where the group is: both bounds are stamps we hold. And still
 * nothing here retires a greeting EARLY — a group walking in at +9 minutes is
 * greeted, because the post is what starts the clock, not the flag.
 */
export const HARD_CAP_AFTER_END_MS = 20 * 60_000;

export function welcomeBackExpired(input: {
  /** The race's own end — the one stamp that always exists. */
  actualEndMs: number | null;
  /** When the post-race announcement played, if it has. */
  postPlayedAtMs: number | null;
  /** The greeting's linger span, a staff setting. */
  lingerAfterMs: number;
  nowMs: number;
}): boolean {
  const { actualEndMs, postPlayedAtMs, lingerAfterMs, nowMs } = input;
  if (postPlayedAtMs != null && Number.isFinite(postPlayedAtMs)) {
    return nowMs - postPlayedAtMs >= lingerAfterMs;
  }
  if (actualEndMs != null && Number.isFinite(actualEndMs)) {
    return nowMs - actualEndMs >= HARD_CAP_AFTER_END_MS;
  }
  // No stamps at all is not "expired" — it is "we cannot tell", and the open
  // check above is the one that decides whether to show anything.
  return false;
}
