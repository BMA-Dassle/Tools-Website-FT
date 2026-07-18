/**
 * Game Zone cards bought WITH a booking (owner 2026-07-18) — the client-side
 * handoff between checkout and the kiosk confirmation screen.
 *
 * The reserve response returns the CHARGED ledger-row pointers (`gameCards`);
 * checkout stashes them here (sessionStorage — survives the route change and a
 * refresh mid-dispense), and the confirmation screen fulfills them: dispense +
 * load for new cards, on-prem bridge load for reloads. The rows are only
 * POINTERS — /api/game-cards/load-card re-reads authoritative amounts and
 * validates txn/group server-side, exactly like the standalone Game Zone flow.
 * If the browser dies mid-fulfillment the rows are already charged+pending in
 * the ledger, so the reconcile cron / staff recover forward — never a re-charge.
 */

export const KIOSK_GZ_FULFILLMENT_KEY = "kiosk:gz:fulfillment";

export interface GzFulfillmentCard {
  txnId: string;
  packageId: string;
  /** "" for a new card (account read off the blank at dispense). */
  accountNumber: string;
  tokens: number;
  bonusTokens: number;
}

export interface GzFulfillmentPayload {
  mode: "new_card" | "reload";
  groupId: string;
  locationCode: number;
  cards: GzFulfillmentCard[];
}

/** Stash the reserve response's gameCards for the confirmation screen. */
export function stashGzFulfillment(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  try {
    sessionStorage.setItem(KIOSK_GZ_FULFILLMENT_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable — the reconcile cron still recovers the rows */
  }
}

export function readGzFulfillment(): GzFulfillmentPayload | null {
  try {
    const raw = sessionStorage.getItem(KIOSK_GZ_FULFILLMENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GzFulfillmentPayload;
    if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearGzFulfillment(): void {
  try {
    sessionStorage.removeItem(KIOSK_GZ_FULFILLMENT_KEY);
  } catch {
    /* nothing to clear */
  }
}
