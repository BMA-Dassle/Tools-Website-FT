/**
 * WHEN THE DESK SHOULD BE MADE TO LOOK UP — pure. Facts in, "sound the alarm
 * now, or don't" out.
 *
 * The board already says everything in colour and numbers, and on a Saturday
 * night nobody is reading it: staff are scanning wristbands with their heads
 * down. Two moments cost a race if they pass unnoticed, and the owner asked for
 * both to be AUDIBLE (2026-08-23):
 *
 *   CALL      a session's call time has arrived and nobody has called it
 *   SEND      the window to walk a called group into the briefing room is
 *             about to shut
 *
 * ─── THE PATTERN, AND WHY IT IS BOUNDED ──────────────────────────────────
 *
 * Every 10 seconds across the last 30 — so three plays, then silence, per
 * event. It is deliberately NOT "nag until fixed": a sound that repeats
 * forever gets muted at the desk within a week, and then neither alarm works
 * ever again. Three plays is enough to move a head; the board keeps the visual.
 *
 * ─── THE SEND ALARM HAS A SECOND CONDITION ───────────────────────────────
 *
 * It only fires once the session has been CALLED for at least
 * `SEND_ALARM_MIN_CALLED_MS` (owner: "if we have had the session called for at
 * least 7 minutes"). A group called 90 seconds ago whose window is closing is
 * not a failure — the racers are still walking to the desk, and the right move
 * is to wait for the next race. The alarm is for the case where the group has
 * been standing there long enough that the send should already have happened.
 *
 * ─── FIRING IS THE CALLER'S JOB, IDEMPOTENTLY ────────────────────────────
 *
 * This returns which 10-second SLOT the clock is in, not "play now" — the
 * caller plays once per (event, slot) and a 1s tick therefore cannot play four
 * times. Slot 3 is the earliest (30s out), slot 1 the last (10s out).
 */

/** One play every 10 seconds… */
export const ALARM_INTERVAL_MS = 10_000;
/** …across the last 30, so three plays and then silence. */
export const ALARM_LEAD_MS = 30_000;
/** How long a session must have been called before a closing send window is
 *  worth shouting about. */
export const SEND_ALARM_MIN_CALLED_MS = 7 * 60_000;

/**
 * THE THREE THINGS THE DESK IS SHOUTED AT ABOUT, named in one place.
 *
 * Listed here so the API route that validates an arriving cue cannot drift from
 * what this module can emit. That drift is not hypothetical: `pull` was added
 * to the test button and to the live cue on 2026-08-24 and never to the
 * push-fire guard, so the one kind staff most needed on a phone was the one
 * shape-check that would have rejected it.
 */
export const ALARM_KINDS = ["call", "send", "pull"] as const;

export type AlarmKind = (typeof ALARM_KINDS)[number];

/** Is this one of our alarm kinds? For validating what arrives over the wire. */
export function isAlarmKind(value: unknown): value is AlarmKind {
  return typeof value === "string" && (ALARM_KINDS as readonly string[]).includes(value);
}

export interface AlarmCue {
  kind: AlarmKind;
  /** 3 = 30s out, 2 = 20s, 1 = 10s. Stable within its 10s slot, so a caller
   *  that plays once per (kind, session, slot) plays exactly three times.
   *  A `pull` cue is not a countdown at all and is pinned to 1 — see
   *  {@link pullAlarmCue}, which is precisely why it needs its own kind. */
  slot: 1 | 2 | 3;
  /** The session the alarm is about — part of the caller's play-once key, so
   *  the next heat's alarm is never swallowed as a duplicate of this one. */
  sessionId: string;
  /** For the notification's own words. */
  heatNumber: number | null;
}

/** The slot a deadline `ms` away falls in, or null when it is outside the
 *  30-second run-up (or already past — a passed deadline is the board's amber
 *  banner's business, not the speaker's). */
function slotFor(msUntil: number): 1 | 2 | 3 | null {
  if (msUntil <= 0 || msUntil > ALARM_LEAD_MS) return null;
  const slot = Math.ceil(msUntil / ALARM_INTERVAL_MS);
  return slot === 1 || slot === 2 || slot === 3 ? slot : null;
}

/**
 * THE CALL ALARM. `callWindowEndsMs` is the end of the window a call may land
 * in — the same number the board's amber banner counts down to, so the sound
 * and the screen cannot disagree about when the desk is out of time.
 */
export function callAlarmCue(args: {
  nowMs: number;
  /** The next uncalled session, or null. */
  next: { sessionId: string; heatNumber: number | null; callWindowEndsMs: number } | null;
}): AlarmCue | null {
  if (!args.next) return null;
  const slot = slotFor(args.next.callWindowEndsMs - args.nowMs);
  return slot == null
    ? null
    : {
        kind: "call",
        slot,
        sessionId: args.next.sessionId,
        heatNumber: args.next.heatNumber,
      };
}

/**
 * THE SEND ALARM. `windowClosesInMs` comes from `sendWindow(...)`'s `closesInMs`
 * — null on any state that is not counting down to a shut window.
 */
export function sendAlarmCue(args: {
  /** The called session standing at the desk, or null. */
  called: { sessionId: string; heatNumber: number | null } | null;
  /** How long that session has been called. Null when unknown — which is NOT
   *  permission to shout; an unknown age cannot clear the 7-minute bar. */
  calledForMs: number | null;
  /** `closesInMs` from the send window, or null when it is not closing. */
  windowClosesInMs: number | null;
}): AlarmCue | null {
  if (!args.called) return null;
  if (args.windowClosesInMs == null) return null;
  if (args.calledForMs == null || args.calledForMs < SEND_ALARM_MIN_CALLED_MS) return null;
  const slot = slotFor(args.windowClosesInMs);
  return slot == null
    ? null
    : {
        kind: "send",
        slot,
        sessionId: args.called.sessionId,
        heatNumber: args.called.heatNumber,
      };
}

/**
 * PULL TO BRIEFING NOW — a STATE, not a countdown, and that is the whole reason
 * it is its own kind.
 *
 * The group's check-in window has run out with racers still missing
 * (brief-verdict.ts, owner 2026-08-24), so the choice is brief them now or hold
 * the track for people who are not coming. It sounds on its own, without the
 * send window closing, and the 7-minute bar does not apply — the check-in
 * window IS the wait that bar exists to guarantee.
 *
 * ─── WHY NOT `kind: "send", slot: 1`, WHICH IS WHAT IT USED TO BE ────────
 *
 * Because `pull-now` holds true for as long as the grid is short, it fires
 * early and then STANDS, sometimes for ten minutes. Emitting it as the send
 * alarm's final beat meant it took `send:{session}:1` — the caller's play-once
 * key AND the server's cross-board Redis claim, which lives for an hour. When
 * the send window later slipped into its grace minute and the real countdown
 * ran, slot 3 and slot 2 went out and the last beat was refused as a duplicate
 * of a buzz that had happened ten minutes earlier.
 *
 * Measured on the live claim ledger 2026-08-25: session 59039734 claimed
 * `send:…:1` **586 seconds before** `send:…:2`, which no genuine countdown can
 * do. A distinct kind gives it a distinct key, and both alarms keep their beats.
 *
 * ONE BEAT PER SESSION, deliberately. The slot is pinned to 1 because there is
 * no run-up to divide — the verdict either has flipped or has not — so the
 * caller's `(kind, session, slot)` key plays it exactly once and it cannot
 * become the nag that gets the speaker muted.
 */
export function pullAlarmCue(args: {
  /** The called session standing at the desk, or null. */
  called: { sessionId: string; heatNumber: number | null } | null;
  /** Has the verdict flipped to `pull-now`? */
  pullNow: boolean;
}): AlarmCue | null {
  if (!args.called || !args.pullNow) return null;
  return {
    kind: "pull",
    slot: 1,
    sessionId: args.called.sessionId,
    heatNumber: args.called.heatNumber,
  };
}

/** The caller's play-once key. One play per event per 10-second slot. */
export function alarmKey(cue: AlarmCue): string {
  return `${cue.kind}:${cue.sessionId}:${cue.slot}`;
}

/** What a push notification says. Short on purpose — it lands on a lock screen
 *  and has to be read at a glance, from across a counter. */
export function alarmMessage(cue: AlarmCue): { title: string; body: string } {
  const who = cue.heatNumber != null ? `Session ${cue.heatNumber}` : "The next session";
  const secs = cue.slot * 10;
  if (cue.kind === "call") {
    return { title: `Call ${who}`, body: `${secs}s left to call it on time.` };
  }
  if (cue.kind === "pull") {
    /**
     * NO SECONDS NAMED HERE, because there are none: this is a verdict that has
     * flipped, not a clock running out. While it rode the send alarm's final
     * slot it inherited that sentence and told a lock screen "10s left — after
     * that the film will not fit", which was a deadline it had invented and
     * which sent staff looking for one that was not there.
     */
    const group = cue.heatNumber != null ? `Session ${cue.heatNumber}` : "this group";
    return {
      title: `Pull ${group} to briefing`,
      body: "Check-in window is up with racers still missing.",
    };
  }
  return {
    title: `Send ${who} to briefing`,
    body: `${secs}s left — after that the film will not fit.`,
  };
}
