/**
 * Domain + response types for the game-cards feature. Request/input types are
 * derived from zod in `schemas.ts`; these are hand-written server/response shapes.
 */

import type { TokenPackage } from "./constants";

/**
 * Kind of Intercard transaction.
 *   reload    — existing card, guest paid
 *   new_card  — blank dispensed then loaded, guest paid
 *   voucher   — blank DISPENSED then loaded, NO money leg: authorised by a
 *               voucher claim in game_card_voucher_claims (BMI- or self-issued).
 *               `amount_cents` is 0 and `voucher_code` carries the code.
 *   voucher_reload
 *             — voucher credited onto a card the guest ALREADY HOLDS (the web
 *               leg). Same authorisation, but nothing is dispensed, and the card
 *               must NEVER be treated as fresh stock: clear-on-encode would wipe
 *               the guest's own balance. The kind is what encodes that
 *               difference, exactly as new_card vs reload does for paid rows.
 *
 * See vouchers/codes.ts, vouchers/grants.ts, data/voucher-claims-db.ts.
 */
export type TxnKind = "reload" | "new_card" | "voucher" | "voucher_reload";

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
  /** Ledger row id — the success screen polls load-status with these. */
  txnId: string;
  accountNumber: string;
  /** Tokens/bonus credited on this load. */
  tokens: number;
  bonusTokens: number;
  /** Intercard load confirmed (false → credit pending, recovered forward). */
  loaded: boolean;
  creditPending: boolean;
  /** Fresh balance after a confirmed load, when re-read. */
  balance?: CardBalance;
  /** Recent activity from the same post-load re-read (for the success-screen history). */
  transactions?: CardTxn[];
}

/** Outcome returned to the client after a purchase attempt (one charge, N cards). */
export interface PurchaseResult {
  ok: true;
  /** Ledger group id shared by every card in this charge (for load-status polls). */
  groupId: string;
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

/**
 * Bridge-queue lifecycle for web reloads credited on the on-prem EIS server
 * (NULL/absent = the row never queued and belongs to the cloud-SOAP path).
 * The EIS credit carries no idempotency id while the SOAP path dedups on
 * tpi_transaction_id, so a row must be eligible for exactly one path at a
 * time — see the state table in data/transactions-log.ts.
 */
export type QueueState = "queued" | "claimed" | "done" | "soap_fallback" | "verify" | "manual";
