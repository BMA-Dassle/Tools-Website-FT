/**
 * IS THIS GROUP READY TO BE PULLED INTO A BRIEFING ROOM? PURE — facts in, the
 * triggers that fired out.
 *
 * Owner 2026-09-13, for the screens outside the briefing rooms: "the checkin
 * step (step 1) will start blinking and highlight when ready, it will have 3
 * triggers possible: 1. All racers checked in. 2. Past 8 minutes. 3. Someone
 * presses [the ready] button… to start indicating ready to pull."
 *
 * THREE TRIGGERS, ANY ONE IS ENOUGH, and the list says WHICH fired rather than
 * collapsing to a boolean — a wall that says "ready" for three different
 * reasons is a wall staff learn to distrust, and a test that can only see
 * true/false cannot tell "the window ran out" from "somebody pressed it".
 *
 *   all-in   everyone on the roster has scanned. Guarded on a NON-ZERO total:
 *            a roster we could not read is not an empty heat (the 2026-08
 *            roster-count lesson), and it must never read as "everybody is here".
 *   window   the venue's check-in window has RUN OUT — `checkinAlert` says
 *            "late", i.e. past the deadline, not the one-minute lead before it.
 *            The lead is the desk's warning to hurry; the wall lights when the
 *            time they were ever going to get is gone.
 *   staff    a person said so, from the desk's Ready to pull button. Their word
 *            is taken as-is; the caller has already matched the mark to THIS
 *            heat's session (ready-to-pull.server.ts is track-keyed).
 *
 * DISTINCT FROM `briefVerdict`, deliberately. The verdict answers "should the
 * desk press Send right now" and lets the film clock outrank everything — a
 * group can be ready to pull and still have "no time to brief". This answers
 * only whether the GROUP is ready; the renderer lets the row's tone (which the
 * verdict still decides) colour how it flashes.
 */
import { checkinAlert } from "./desk-alerts";

export type PullTrigger = "all-in" | "window" | "staff";

export interface PullTriggerInput {
  /** The desk's count for this heat. Null = unread, which is NOT "nobody". */
  checkedIn: { checkedIn: number; total: number } | null;
  /** Time since the call — the anchor every check-in clock counts from. */
  calledForMs: number | null;
  /** The venue's check-in window in minutes. 0/unknown ⇒ no deadline to fire on. */
  checkinWindowMins: number;
  /** Has a staff member marked THIS heat ready at the desk? */
  staffReady: boolean;
}

/** The triggers that have fired, in the order the owner listed them. Empty = not ready. */
export function pullTriggers(input: PullTriggerInput): PullTrigger[] {
  const out: PullTrigger[] = [];
  const c = input.checkedIn;
  if (c && c.total > 0 && c.checkedIn >= c.total) out.push("all-in");
  if (
    input.calledForMs != null &&
    checkinAlert(input.calledForMs, input.checkinWindowMins) === "late"
  ) {
    out.push("window");
  }
  if (input.staffReady) out.push("staff");
  return out;
}
