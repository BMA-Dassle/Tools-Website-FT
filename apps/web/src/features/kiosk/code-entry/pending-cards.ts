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
export function addPendingCards(prev: PendingGzCard[], cards: PendingGzCard[]): PendingGzCard[] {
  const have = new Set(prev.map((c) => c.code));
  const add = cards.filter((c) => !have.has(c.code));
  return add.length > 0 ? [...prev, ...add] : prev;
}

/** Remove EVERY leg of a code (a voucher is removed whole). */
export function removePendingCard(prev: PendingGzCard[], code: string): PendingGzCard[] {
  return prev.filter((c) => c.code !== code);
}

/** Remove ONE leg of a code — the receipt's qty "−" (owner 2026-08-02). */
export function removeOnePendingCard(prev: PendingGzCard[], code: string): PendingGzCard[] {
  const i = prev.findIndex((c) => c.code === code);
  if (i === -1) return prev;
  return [...prev.slice(0, i), ...prev.slice(i + 1)];
}

/** Append ONE leg, bypassing the whole-code dedupe — the receipt's qty "+".
 *  The caller has already verified against the validate response that the
 *  voucher holds more unspent gz legs than are pending. */
export function addOnePendingCard(prev: PendingGzCard[], card: PendingGzCard): PendingGzCard[] {
  return [...prev, card];
}

/** Apply a dispense run's per-LEG outcomes. ONE loaded outcome clears ONE leg
 *  of that code — the server spends a single gz item per claim
 *  (`claimNativeVoucher` takes "the FIRST unspent Game Zone item"), and the
 *  run reports one outcome per card it attempted, so a multi-leg voucher that
 *  fully dispenses clears all its legs while a leg that failed mid-run stays
 *  pending and keeps the way-back tile alive. Failed outcomes clear nothing
 *  (their claims were released). Unknown codes in `outcomes` are ignored. */
export function clearDispensedCards(
  prev: PendingGzCard[],
  outcomes: { code: string; loaded: boolean }[],
): PendingGzCard[] {
  const spent = new Map<string, number>();
  for (const o of outcomes) {
    if (o.loaded) spent.set(o.code, (spent.get(o.code) ?? 0) + 1);
  }
  const next: PendingGzCard[] = [];
  for (const c of prev) {
    const n = spent.get(c.code) ?? 0;
    if (n > 0) {
      spent.set(c.code, n - 1); // this leg's card just came out
      continue;
    }
    next.push(c);
  }
  return next;
}
