/**
 * SHOULD THIS GROUP BE BRIEFED RIGHT NOW? PURE — facts in, one verdict out, and
 * the sentence every surface prints.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * The answer was spread across three modules and no surface had all three
 * (owner 2026-08-24: "why would we be telling them to pull to briefing with not
 * everyone checked in… do we have a central module that controls this for both
 * check in board, briefing control and TVs?").
 *
 *   the roster is complete        pull-to-room.ts → pullVerdict   desk, tablets
 *   the check-in window is up     desk-alerts.ts  → checkinAlert  desk only
 *   the film still fits           pull-to-room.ts → sendWindow    desk, tablets, TVs
 *
 * The TV walls got exactly one of the three, so they cheerfully printed BRIEF
 * NOW over a half-checked-in grid — advising the very press the desk button and
 * the room tablet would refuse. A wall the racers read and a button the staff
 * press must not disagree, so the decision lives here now and the surfaces
 * render it.
 *
 * ─── THE RULE, IN THE OWNER'S WORDS ──────────────────────────────────────
 *
 * "That should only happen if we're at the end of the allotted check-in time.
 * Then it should be PULL TO BRIEFING NOW."
 *
 * So an incomplete grid is NOT an invitation to brief — it is a wait, and the
 * wait names what it is waiting on. Only when that group's check-in window is
 * running out does the advice flip, and then it flips hard: the window is the
 * whole time they were ever going to get, so the choice is brief them now or
 * hold the track for people who are not coming.
 *
 * ─── PRECEDENCE, AND WHY IT IS THIS WAY ──────────────────────────────────
 *
 * Time beats roster. A film that can no longer finish before the race in front
 * ends cannot be started by any number of checked-in racers, so `no time to
 * brief` outranks both `waiting on 2` and `PULL TO BRIEFING NOW` — telling a
 * desk to pull a group into a room whose film will not land is worse advice
 * than telling them to wait for the flag.
 */
import { checkinAlert } from "./desk-alerts";
import type { SendWindow } from "./pull-to-room";

export type BriefVerdictKind =
  /** Nothing called, or no clock to reason from. */
  | "quiet"
  /** The window is open but sending now just parks them at the grid. */
  | "early"
  /** Grid complete, film lands as the track clears. The one green state. */
  | "ready"
  /** Grid short, and there is still check-in time left to fill it. */
  | "waiting"
  /** Grid short and the window is running out — brief them anyway, now. */
  | "pull-now"
  /** Past the film deadline, inside the grace minute. */
  | "grace"
  /** The film cannot land at all — wait for the flag and the post. */
  | "blocked";

export interface BriefVerdict {
  kind: BriefVerdictKind;
  /** What every surface prints, lower case; callers case it as they like. */
  phrase: string;
  /** Shared so two surfaces cannot colour one fact differently. */
  tone: "none" | "good" | "warn" | "alert";
  /**
   * Is this the moment to act? True for `ready` and `pull-now` only — the two
   * states where the right thing is a press, which is exactly what an alarm or
   * a push notification should fire on.
   */
  act: boolean;
  /** How many of the grid are still to scan, when we know. */
  short: number | null;
}

export interface BriefVerdictInput {
  /** Is a heat actually called? Everything is quiet without one. */
  called: boolean;
  /** Where the send sits against the race in front — see `sendWindow`. */
  window: SendWindow | null;
  /** The desk's count for this heat. Null = unread, which is NOT "nobody". */
  checkedIn: { checkedIn: number; total: number } | null;
  /** Time since the call — the same anchor every check-in clock counts from. */
  calledForMs: number | null;
  /** The venue's check-in window. 0/unknown ⇒ no deadline to flip on. */
  checkinWindowMins: number;
  /** M:SS, so this module never decides how a duration is written. */
  formatClock?: (ms: number) => string;
}

export function briefVerdict(input: BriefVerdictInput): BriefVerdict {
  const fmt = input.formatClock;
  if (!input.called) return { kind: "quiet", phrase: "", tone: "none", act: false, short: null };

  const count = input.checkedIn;
  // A total of zero is a roster we could not read, never an empty heat — it
  // must not read as "everybody is here" (roster-count.ts, the 2026-08 lesson).
  const known = !!count && count.total > 0;
  const short = known ? Math.max(0, count!.total - count!.checkedIn) : null;
  const allIn = known && count!.checkedIn >= count!.total;

  const w = input.window;

  // ── TIME FIRST. No film, no briefing, whatever the roster says. ──────────
  if (w && w.kind === "blocked") {
    return {
      kind: "blocked",
      phrase: "no time to brief · after the post",
      tone: "alert",
      act: false,
      short,
    };
  }
  if (w && w.kind === "grace") {
    return {
      kind: "grace",
      phrase: fmt ? `no time to brief · ${fmt(w.graceLeftMs)} grace` : "no time to brief",
      tone: "alert",
      act: false,
      short,
    };
  }

  // ── THEN THE ROSTER, and the window that overrides it. ───────────────────
  if (known && !allIn) {
    const windowUp =
      input.calledForMs != null &&
      checkinAlert(input.calledForMs, input.checkinWindowMins) !== "none";
    if (windowUp) {
      return {
        kind: "pull-now",
        phrase: "pull to briefing now",
        tone: "alert",
        act: true,
        short,
      };
    }
    return {
      kind: "waiting",
      // Names what it is waiting ON. "Waiting" alone tells a staff member
      // nothing they can act on; a number tells them how many to chase.
      phrase: short === 1 ? "waiting on 1 racer" : `waiting on ${short} racers`,
      tone: "warn",
      act: false,
      short,
    };
  }

  // ── THEN THE WINDOW ON THE RACE IN FRONT. ────────────────────────────────
  if (!w || w.kind === "quiet") {
    return { kind: "quiet", phrase: "", tone: "none", act: false, short };
  }
  if (w.kind === "early") {
    return {
      kind: "early",
      phrase: fmt ? `brief in ${fmt(w.opensInMs)}` : "brief shortly",
      tone: "warn",
      act: false,
      short,
    };
  }
  // open — and, because the roster gate above has been passed, genuinely ready.
  // An UNREAD roster reaches here too: we cannot prove the grid is short, and
  // refusing to advise on a count we never got would silence the board all
  // night on a Pandora wobble.
  return { kind: "ready", phrase: "brief now", tone: "good", act: true, short };
}
