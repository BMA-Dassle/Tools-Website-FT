/**
 * POV video codes claimed WITH a kiosk booking — the client-side handoff
 * between checkout and the kiosk confirmation screen (race-pack-confirmation's
 * little sibling).
 *
 * unified-reserve claims the codes server-side (idempotent per billId) and
 * returns them on the reserve result as `povCodes`; checkout stashes them here
 * and the confirmation screen renders the voucher block. Pure display — the
 * durable copies are the guest email and the reservation memo, so losing this
 * stash loses nothing but a nicety.
 */

export const KIOSK_POV_CONFIRM_KEY = "kiosk:pov-codes:confirm";

export function stashPovConfirmation(codes: unknown): void {
  if (!Array.isArray(codes) || codes.length === 0) return;
  try {
    sessionStorage.setItem(KIOSK_POV_CONFIRM_KEY, JSON.stringify(codes));
  } catch {
    /* storage unavailable — the email + memo still carry the codes */
  }
}

export function readPovConfirmation(): string[] | null {
  try {
    const raw = sessionStorage.getItem(KIOSK_POV_CONFIRM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.filter((c): c is string => typeof c === "string");
  } catch {
    return null;
  }
}

export function clearPovConfirmation(): void {
  try {
    sessionStorage.removeItem(KIOSK_POV_CONFIRM_KEY);
  } catch {
    /* nothing to clear */
  }
}
