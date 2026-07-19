/**
 * Race packs bought WITH a booking — the client-side handoff between checkout
 * and the kiosk confirmation screen (gz-fulfillment's little sibling).
 *
 * The reserve response returns per-pack outcomes (`racePacks`: used today /
 * banked / granted); checkout stashes them here and the confirmation screen
 * renders the "1 race today · 2 banked to Eric's account" lines. Pure display —
 * the credits themselves were granted server-side (or handed to the retry
 * sweep), so losing this stash loses nothing but a nicety.
 */

export const KIOSK_RACE_PACK_CONFIRM_KEY = "kiosk:race-packs:confirm";

export interface RacePackConfirmLine {
  memberName: string;
  label: string;
  raceCount: number;
  usedToday: number;
  banked: number;
  /** false = the retry sweep owns the grant — copy degrades honestly. */
  granted: boolean;
}

export function stashRacePackConfirmation(payload: unknown): void {
  if (!payload || !Array.isArray(payload) || payload.length === 0) return;
  try {
    sessionStorage.setItem(KIOSK_RACE_PACK_CONFIRM_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable — the credits still granted server-side */
  }
}

export function readRacePackConfirmation(): RacePackConfirmLine[] | null {
  try {
    const raw = sessionStorage.getItem(KIOSK_RACE_PACK_CONFIRM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RacePackConfirmLine[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearRacePackConfirmation(): void {
  try {
    sessionStorage.removeItem(KIOSK_RACE_PACK_CONFIRM_KEY);
  } catch {
    /* nothing to clear */
  }
}
