/**
 * Idempotency keys for a deal refund.
 *
 * Square keys are the ONLY thing standing between a retried request and a second
 * refund, so the rules here are strict and the failures are throws, not
 * fallbacks.
 *
 * LENGTH IS THE TRAP. Square's create-payment key limit is 45 characters, and a
 * key whose length depends on variable-width content eventually exceeds it in
 * production and nowhere else (the 2026-06-20 VALUE_TOO_LONG lesson). Every key
 * here is derived from `deal_purchases.idempotency_key`, which is
 * `randomBytes(8).toString("hex")` — ALWAYS exactly 16 characters — plus a
 * bounded sequence number, so the worst case is computable and pinned by a test.
 *
 * THE SEQUENCE COMES FROM THE LEDGER, never from a counter in memory. It is
 * allocated by `UNIQUE (purchase_id, seq)` before any Square call, and a RETRY
 * RESUMES THE EXISTING ROW and re-derives the identical key. That is the whole
 * reason the row is written first: replaying the same key is what makes the
 * reconciliation automatic — Square returns the original refund object rather
 * than issuing a second one, so we never have to list refunds to find our own.
 */

/** Bounded so a derived key's length is always computable. */
export const MAX_REFUND_SEQ = 99;

const BASE_KEY = /^[0-9a-f]{16}$/;

/** The namespace for ONE refund attempt: `<baseKey>-rf<seq>`. */
export function dealRefundKey(baseKey: string, seq: number): string {
  if (!BASE_KEY.test(baseKey)) {
    throw new Error(`deal refund key: baseKey must be 16 hex characters, got "${baseKey}"`);
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_REFUND_SEQ) {
    throw new Error(`deal refund seq ${seq} out of range 1..${MAX_REFUND_SEQ}`);
  }
  return `${baseKey}-rf${seq}`;
}

export interface DealRefundSquareKeys {
  /** Passed to createReturnOrder, which appends its own `-ret<seq>`. */
  returnOrder: string;
  /** Passed to refundTenderPartial, which appends its own `-r<index>`. */
  cardRefund: string;
  /** POST /v2/gift-cards — minting the cross-tender destination. */
  giftCardCreate: string;
  /** POST /v2/refunds — the cross-tender credit. */
  giftCardRefund: string;
}

/**
 * Every Square key one refund attempt can need.
 *
 * `returnOrder` and `cardRefund` are NAMESPACES rather than finished keys: the
 * shared helpers in `reservation-edit/square-actions` build
 * `${editId}-ret${seq}` and `${editId}-r${index}` themselves. Their parameter is
 * literally named `editId`, which reads like a reservation id — it is only ever
 * used as a key prefix, and passing a deal refund key is correct.
 */
export function dealRefundSquareKeys(refundKey: string): DealRefundSquareKeys {
  return {
    returnOrder: refundKey,
    cardRefund: refundKey,
    giftCardCreate: `deal-gcd-${refundKey}`,
    giftCardRefund: `deal-gcr-${refundKey}`,
  };
}

/** Square's documented idempotency-key ceiling. */
export const SQUARE_KEY_MAX = 45;

/**
 * Longest string any of these keys can become once the shared helpers have
 * appended their own suffixes. Exported so a test can assert the bound rather
 * than trusting the arithmetic in a comment.
 */
export function longestDerivedKeyLength(refundKey: string): number {
  const k = dealRefundSquareKeys(refundKey);
  return Math.max(
    `${k.returnOrder}-ret0`.length,
    `${k.cardRefund}-r0`.length,
    k.giftCardCreate.length,
    // createDigitalGiftCard appends `-fb` on its GAN-collision fallback path.
    `${k.giftCardCreate}-fb`.length,
    k.giftCardRefund.length,
  );
}
