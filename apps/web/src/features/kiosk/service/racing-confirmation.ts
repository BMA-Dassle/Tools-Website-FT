/**
 * "This checkout included a race" — the client-side handoff between checkout
 * and the kiosk confirmation screen (race-pack-confirmation's little sibling).
 *
 * The confirmation screen can't derive this itself: the booking session is
 * cleared before navigation, and the confirmation URL can't tell racing from
 * attractions (both land on /book/confirmation/v2). Checkout stashes the flag
 * while session.items is still in scope; the confirmation screen reads it to
 * show the racing "what's next" banner. Pure display — losing the stash loses
 * nothing but the reminder (the eTicket SMS still carries the instructions).
 */

export const KIOSK_HAS_RACING_KEY = "kiosk:has-racing";

export function stashKioskHasRacing(hasRacing: boolean): void {
  if (!hasRacing) return;
  try {
    sessionStorage.setItem(KIOSK_HAS_RACING_KEY, "1");
  } catch {
    /* storage unavailable — the eTicket SMS still explains check-in */
  }
}

export function readKioskHasRacing(): boolean {
  try {
    return sessionStorage.getItem(KIOSK_HAS_RACING_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearKioskHasRacing(): void {
  try {
    sessionStorage.removeItem(KIOSK_HAS_RACING_KEY);
  } catch {
    /* nothing to clear */
  }
}
