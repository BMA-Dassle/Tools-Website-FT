/**
 * Pending game-card voucher legs — the flow-owned list behind the coupon
 * receipt and the categories "cards to pick up" tile. Pure list operations,
 * extracted so the rules (dedup by code, per-code removal, clear only what
 * actually DISPENSED) are tested instead of living inline in KioskFlow.
 */

export interface PendingGzCard {
  code: string;
  tokens: number;
}

/** Append newly-scanned legs; a code already in the list never duplicates
 *  (one voucher's gz legs travel together, re-scans are no-ops). Returns the
 *  SAME array when nothing was added so React state doesn't churn. */
export function addPendingCards(
  prev: PendingGzCard[],
  cards: PendingGzCard[],
): PendingGzCard[] {
  const have = new Set(prev.map((c) => c.code));
  const add = cards.filter((c) => !have.has(c.code));
  return add.length > 0 ? [...prev, ...add] : prev;
}

/** Remove EVERY leg of a code (a voucher is removed whole). */
export function removePendingCard(prev: PendingGzCard[], code: string): PendingGzCard[] {
  return prev.filter((c) => c.code !== code);
}

/** Apply a dispense run's per-code outcome: DISPENSED codes leave the list;
 *  failed ones stay (their claims were released — the way back must stay
 *  open). Unknown codes in `outcomes` are ignored. */
export function clearDispensedCards(
  prev: PendingGzCard[],
  outcomes: { code: string; loaded: boolean }[],
): PendingGzCard[] {
  return prev.filter((p) => !outcomes.some((o) => o.code === p.code && o.loaded));
}
