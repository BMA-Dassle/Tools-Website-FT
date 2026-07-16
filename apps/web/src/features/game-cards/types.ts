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
  /** eTickets balance (Intercard PointBalance). */
  eTickets: number;
  /** Time-play balance in minutes. */
  timeMinutes: number;
}

/** One line of on-card activity (from the same balance/history web call). */
export interface CardTxn {
  device: string;
  transType: string;
  tokens: number;
  bonusTokens: number;
  points: number;
  cash: number;
  timeStamp: string;
  location: string;
}

/** Result of the read-only account lookup. */
export interface VerifyResult {
  exists: boolean;
  accountNumber: string;
  balance?: CardBalance;
  /** Card holder name if the lookup returns it (masked/omitted otherwise). */
  name?: string;
  /** Recent on-card activity, newest first (for the expandable history section). */
  transactions?: CardTxn[];
}

/** Client-facing view of a package (no server-only fields to hide, but keeps the boundary clean). */
export type PublicPackage = Pick<
  TokenPackage,
  "id" | "label" | "priceCents" | "tokens" | "bonusTokens"
>;

/** Per-card outcome within a (possibly multi-card) reload. */
export interface CardLoadResult {
  accountNumber: string;
  /** Tokens/bonus credited on this load. */
  tokens: number;
  bonusTokens: number;
  /** Intercard load confirmed (false → credit pending, recovered forward). */
  loaded: boolean;
  creditPending: boolean;
  /** Fresh balance after a confirmed load, when re-read. */
  balance?: CardBalance;
}

/** Outcome returned to the client after a purchase attempt (one charge, N cards). */
export interface PurchaseResult {
  ok: true;
  /** Square charge settled (for the whole cart). */
  charged: boolean;
  /** Per-card load results. */
  results: CardLoadResult[];
  /** True if any card's load is pending (recovered forward). */
  anyPending: boolean;
  receiptUrl: string | null;
}

export type LoadState = "pending" | "loaded" | "load_failed";
export type TxnState = "started" | "charged" | "charge_failed" | "completed" | "failed";
