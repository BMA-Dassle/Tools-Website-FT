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

export type AlarmKind = "call" | "send";

export interface AlarmCue {
  kind: AlarmKind;
  /** 3 = 30s out, 2 = 20s, 1 = 10s. Stable within its 10s slot, so a caller
   *  that plays once per (kind, session, slot) plays exactly three times. */
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
  if (!args.called || args.windowClosesInMs == null) return null;
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

/** The caller's play-once key. One play per event per 10-second slot. */
export function alarmKey(cue: AlarmCue): string {
  return `${cue.kind}:${cue.sessionId}:${cue.slot}`;
}

/** What a push notification says. Short on purpose — it lands on a lock screen
 *  and has to be read at a glance, from across a counter. */
export function alarmMessage(cue: AlarmCue): { title: string; body: string } {
  const who = cue.heatNumber != null ? `Session ${cue.heatNumber}` : "The next session";
  const secs = cue.slot * 10;
  return cue.kind === "call"
    ? { title: `Call ${who}`, body: `${secs}s left to call it on time.` }
    : {
        title: `Send ${who} to briefing`,
        body: `${secs}s left — after that the film will not fit.`,
      };
}
