/**
 * WHEN the welcome-back greeting speaks — PURE, numbers in, numbers out.
 *
 * The greeting used to play the moment the post-race cue was pressed and the
 * room read empty, which is ~30 seconds before anyone has actually walked in
 * (measured 2026-08-23: across 480 post presses, first motion on the room
 * camera lands at a median of +30s after the press; 95% by +60s). So the clip
 * was talking to an empty room half the time.
 *
 * TWO MODES, chosen on the check-in board's settings sheet (owner 2026-08-23:
 * "I'd like this option in the settings of check in board where we have the
 * other motion option"):
 *
 *  - BY MOTION (default): the greeting starts when the room's own camera first
 *    sees somebody after the post press — the server stamps that onset
 *    (return-arrival.server.ts), so every TV and a mid-window reboot agree.
 *    The NVR's motion index runs ~13-15s behind the wall clock (probed live
 *    2026-08-23), plus the TV's 15s poll, so in practice the clip sounds
 *    15-30s after the first person enters. A camera that cannot answer falls
 *    back to the fixed timer below — a broken NVR costs adaptiveness, never
 *    the greeting.
 *
 *  - FIXED TIMER: post + 45 seconds, the owner's number, sized so the median
 *    group (+30s) has been in the room for a beat before the clip speaks.
 *
 * Either way the window still closes GREETING_WINDOW_MS after the post press —
 * the delay spends the window, it does not extend it — and the clip repeats at
 * most GREETING_MAX_PLAYS times (owner 2026-08-23: "have a timeout on number
 * of repeats"), whichever bound lands first.
 */

/** The fixed-timer delay after the post press, and the fallback when the NVR
 *  cannot answer in motion mode. Owner: "I'm thinking 45 seconds is good." */
export const GREETING_FALLBACK_MS = 45_000;

/** The greeting stops nagging after this, counted from the POST PRESS — the
 *  same 2-minute cap the greeting has always had (owner 2026-08-15: "max of
 *  2 minutes"). Server-stamped anchor, so every TV stops together. */
export const GREETING_WINDOW_MS = 2 * 60_000;

/** How many times the clip may sound in one return, on top of the window
 *  (owner 2026-08-23). Three plays of the 18s clip is the whole window anyway;
 *  the explicit cap is what keeps a future shorter clip from nagging six
 *  times. */
export const GREETING_MAX_PLAYS = 3;

/** Silence between plays, measured from each play's END — matching how the
 *  owner specs gaps on the pit's stay-seated loop ("every 10s", 2026-08-15). */
export const GREETING_GAP_MS = 10_000;

/**
 * A group still moving in the room this long after they walked in is
 * LINGERING, and the wall may say so — the "another group is waiting" clip
 * (asset `welcome-back-linger-audio`), once. Sized off the measured returns:
 * the median group is quiet in 1:27 and 80% inside 3:00, so three minutes of
 * continued motion is the tail, not the norm.
 */
export const LINGER_AFTER_MS = 3 * 60_000;

/** A linger stamp older than this is history, not an instruction — a TV that
 *  reboots five minutes later must not replay the nag at a room that has
 *  since emptied. */
export const LINGER_FRESH_MS = 2 * 60_000;

export interface GreetingInput {
  /** The settings-sheet choice: greet on the camera's say-so, or on the timer. */
  byMotion: boolean;
  /** Server stamp of the post-race cue — the anchor for everything. */
  postPlayedAtMs: number | null;
  /** Server stamp of the first motion after the post press, null until seen. */
  arrivedAtMs: number | null;
  /** False when the NVR could not answer — the cue to stop waiting for it. */
  motionHealthy: boolean;
}

/**
 * The absolute ms at which the first play is due, or null for "not yet" —
 * which in motion mode with a healthy camera means KEEP WAITING: nobody has
 * walked in, and a greeting to an empty room is the exact bug this replaces.
 * The window cap (below) is what bounds that wait.
 */
export function greetingStartMs(input: GreetingInput): number | null {
  const { byMotion, postPlayedAtMs, arrivedAtMs, motionHealthy } = input;
  if (postPlayedAtMs == null) return null;
  if (!byMotion) return postPlayedAtMs + GREETING_FALLBACK_MS;
  // Motion mode. An onset stamped before the post (impossible by construction,
  // but clamp anyway) still greets after the press, never before it.
  if (arrivedAtMs != null) return Math.max(arrivedAtMs, postPlayedAtMs);
  if (!motionHealthy) return postPlayedAtMs + GREETING_FALLBACK_MS;
  return null;
}

/** Window shut = no first play, and no further repeats, ever. */
export function greetingWindowClosed(postPlayedAtMs: number, nowMs: number): boolean {
  return nowMs - postPlayedAtMs > GREETING_WINDOW_MS;
}

/**
 * The first motion period that STARTS at or after `fromMs` — the group walking
 * in. A period already running at `fromMs` is the previous group, staff
 * resetting helmets, or the returning group being called back into an occupied
 * room; none of those is an arrival, so it deliberately does not count.
 */
export function firstOnsetAfter(
  periods: Array<{ startMs: number; durationMs: number }>,
  fromMs: number,
): number | null {
  let best: number | null = null;
  for (const p of periods) {
    if (!Number.isFinite(p.startMs) || p.startMs < fromMs) continue;
    if (best == null || p.startMs < best) best = p.startMs;
  }
  return best;
}

/** Is the room still moving `LINGER_AFTER_MS` past the arrival? Decided from
 *  numbers the server already holds — the caller supplies whether the camera
 *  saw motion in its recent window. */
export function lingerDue(input: {
  arrivedAtMs: number | null;
  stillMoving: boolean;
  nowMs: number;
}): boolean {
  const { arrivedAtMs, stillMoving, nowMs } = input;
  if (arrivedAtMs == null || !stillMoving) return false;
  return nowMs - arrivedAtMs >= LINGER_AFTER_MS;
}
