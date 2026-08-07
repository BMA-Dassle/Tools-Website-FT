/**
 * Pure decision logic for KioskAmbientCheckout — no React, no transport, so
 * the money-flow rules are unit-testable without a DOM. The component owns
 * the wiring (fetches, timers, refs); every branch that decides WHAT happens
 * next lives here.
 */
import { MAX_GIFT_CARD_TENDERS, MAX_TOTAL_TENDERS } from "~/features/booking/service/tenders";
import type { BoardTender } from "./client";

/** The ambient poll/arm response, as the terminal-checkout route shapes it. */
export interface AmbientPollResponse {
  status?: string;
  captured?: boolean;
  paymentIds?: string[];
  primaryPaymentId?: string;
  remainingCents?: number;
  tender?: {
    paymentId: string;
    amountCents: number;
    sourceType?: string;
    cardBrand?: string;
    last4?: string;
  } | null;
  tenders?: BoardTender[];
  verifyPending?: boolean;
  error?: string;
}

export type PollOutcome =
  | { kind: "captured"; paymentIds: string[]; primaryPaymentId: string }
  | { kind: "partial"; remainingCents: number; tenders: BoardTender[] }
  | { kind: "canceled" }
  | { kind: "pending" };

/** Classify one poll response. Unknown/lagging shapes are "pending" — the
 *  loop keeps polling; the 180s deadline and the server sweep bound it. */
export function classifyPoll(pd: AmbientPollResponse): PollOutcome {
  if (pd.status === "CANCELED") return { kind: "canceled" };
  if (pd.status === "COMPLETED" && pd.captured && pd.paymentIds?.length) {
    return {
      kind: "captured",
      paymentIds: pd.paymentIds,
      primaryPaymentId: pd.primaryPaymentId ?? pd.paymentIds[0],
    };
  }
  if (pd.status === "COMPLETED" && pd.captured === false && pd.remainingCents != null) {
    return { kind: "partial", remainingCents: pd.remainingCents, tenders: pd.tenders ?? [] };
  }
  return { kind: "pending" };
}

/** Client-side cap guard (the server enforces the same rule — this only
 *  keeps the error instant instead of a round-trip). */
export function canAddGiftCard(tenders: BoardTender[]): "ok" | "gc-limit" | "tender-limit" {
  if (tenders.filter((t) => t.isGiftCard).length >= MAX_GIFT_CARD_TENDERS) return "gc-limit";
  if (tenders.length >= MAX_TOTAL_TENDERS) return "tender-limit";
  return "ok";
}

/**
 * What a CANCELED poll signal means: nothing when we dismissed the checkout
 * ourselves (a scan-apply or re-arm in flight), a silent re-arm when the
 * guest has money applied (the reader's X must not strand a half-paid board),
 * and a clean exit when the board is empty (today's semantics).
 */
export function afterCancelSignal(opts: {
  selfDismissed: boolean;
  tenderCount: number;
}): "ignore" | "rearm" | "exit" {
  if (opts.selfDismissed) return "ignore";
  return opts.tenderCount > 0 ? "rearm" : "exit";
}

/** The 180s arm deadline: with tenders applied the session must survive (the
 *  guest may be fishing for a second card) — re-arm; empty boards exit. */
export function afterDeadline(tenderCount: number): "rearm" | "exit" {
  return tenderCount > 0 ? "rearm" : "exit";
}

/** SplitError code → catalog copy. Unmapped codes fall back to the generic
 *  apply error; "already-captured" is handled OUT of band (capture converge),
 *  never as copy. */
export function errorKeyForCode(
  code: string | undefined,
): "giftcard.limitReached" | "giftcard.err.lookup" | "giftcard.err.apply" | "giftcard.err.capture" {
  switch (code) {
    case "gc-limit":
    case "tender-limit":
      return "giftcard.limitReached";
    case "card-unusable":
    case "zero-balance":
    case "token-invalid":
      return "giftcard.err.lookup";
    case "sum-mismatch":
    case "nothing-to-capture":
      return "giftcard.err.capture";
    default:
      return "giftcard.err.apply";
  }
}
