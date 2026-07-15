/**
 * Domain + response types for the game-cards feature. Request/input types are
 * derived from zod in `schemas.ts`; these are hand-written server/response shapes.
 */

import type { TokenPackage } from "./constants";

/** Kind of Intercard transaction. `reload` now; `new_card` is a future product. */
export type TxnKind = "reload" | "new_card";

/**
 * Current on-card balances, read at verify time. Displayed on the reload page
 * so the guest sees Tokens / Bonus Tokens / Time before (and after) reloading.
 */
export interface CardBalance {
  tokens: number;
  bonusTokens: number;
  /** Time-play balance in minutes. */
  timeMinutes: number;
}

/** Result of the read-only account lookup. */
export interface VerifyResult {
  exists: boolean;
  accountNumber: string;
  balance?: CardBalance;
  /** Card holder name if the lookup returns it (masked/omitted otherwise). */
  name?: string;
}

/** Client-facing view of a package (no server-only fields to hide, but keeps the boundary clean). */
export type PublicPackage = Pick<
  TokenPackage,
  "id" | "label" | "priceCents" | "tokens" | "bonusTokens"
>;

/** Outcome returned to the client after a purchase attempt. */
export interface PurchaseResult {
  ok: true;
  /** Square charge settled. */
  charged: boolean;
  /** Intercard load confirmed (false → credit pending, recovered forward). */
  loaded: boolean;
  creditPending: boolean;
  receiptUrl: string | null;
  /** New balances after a confirmed load, when re-read. */
  balance?: CardBalance;
}

export type LoadState = "pending" | "loaded" | "load_failed";
export type TxnState = "started" | "charged" | "charge_failed" | "completed" | "failed";
