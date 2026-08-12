/**
 * WHEN THE DESK BOARD STARTS SHOUTING. PURE — numbers in, a level out.
 *
 * Two boxes on the check-in board have a deadline behind them, and until now
 * neither said so: a group can sit in a briefing room for ten minutes because
 * nobody pressed Start, and a called heat can blow through its check-in window
 * while the desk is looking at the other track. Both are staff-visible only after
 * somebody thinks to read a small timer — which on a busy Friday nobody does.
 *
 * So each box gets two levels (owner 2026-08-12):
 *
 *   IN THE ROOM   waiting > 3 min → warn, > 5 min → late. "Just that box."
 *   CALLED        the last minute of the check-in window → warn, past it → late.
 *
 * THE CHECK-IN WINDOW IS NOT A NUMBER THIS FILE OWNS. It is per-screen signage
 * config (`checkinWindowMins`, 8 today for both tracks) and it is what the track
 * boards count down for guests — so the desk reads the same value rather than
 * keeping its own copy that could drift from the wall a racer just walked past.
 *
 * `late` deliberately has NO upper bound: a heat that is twenty minutes overdue is
 * still overdue, and a warning that quietly retires itself is worse than none.
 * Both boxes stop existing on their own — a room that starts its film leaves the
 * waiting phase, and a called heat leaves the Called box when it is sent.
 */

/** Waiting-in-room thresholds, from the owner. */
export const WAITING_WARN_MS = 3 * 60_000;
export const WAITING_LATE_MS = 5 * 60_000;

/** How long before the check-in window closes the Called box starts warning.
 *  One minute, matching what the track TVs already do — they turn the countdown
 *  amber and blink it inside the last minute (SceneRaceCheckin's Countdown), so
 *  desk and wall escalate on the same beat. */
export const CHECKIN_WARN_LEAD_MS = 60_000;

/** No alert, nearly out of time, out of time. */
export type AlertLevel = "none" | "warn" | "late";

/**
 * How overdue a group waiting in a room is.
 *
 * `waitingMs` is time since the SEND — the group has been sitting in there that
 * long with a "take a seat" board up and no film rolling.
 */
export function waitingAlert(waitingMs: number): AlertLevel {
  if (!Number.isFinite(waitingMs)) return "none";
  if (waitingMs > WAITING_LATE_MS) return "late";
  if (waitingMs > WAITING_WARN_MS) return "warn";
  return "none";
}

/**
 * How close a called heat is to the end of its check-in window.
 *
 * `sinceCalledMs` counts from the call (BMI's SessionAboutToStart), the same
 * anchor the track boards count down from. A non-positive or unusable window
 * means the countdown is switched off or unknown — no deadline, so no alert,
 * rather than inventing one.
 */
export function checkinAlert(sinceCalledMs: number, windowMins: number): AlertLevel {
  if (!Number.isFinite(sinceCalledMs) || !Number.isFinite(windowMins) || windowMins <= 0) {
    return "none";
  }
  const remainingMs = windowMins * 60_000 - sinceCalledMs;
  if (remainingMs <= 0) return "late";
  if (remainingMs <= CHECKIN_WARN_LEAD_MS) return "warn";
  return "none";
}
