import { createHash } from "crypto";

/**
 * Deterministic idempotency seed for a reserve attempt.
 *
 * Same input → same 16 hex chars, so every Square key derived from it
 * (`*-dayof-`, `dep-order-`, `gc-`, `gc-act-`, `pay-gc-`, `pay-card-`,
 * `payorder-`) REPLAYS the same order / payment / gift card on a retry or
 * double-submit instead of creating a duplicate (blocker #3).
 *
 * CRITICAL: all reserve call sites AND the race-confirm-reconcile cron MUST
 * derive their baseKey from this one function. The cron recomputes it from the
 * stored bill id to re-create the SAME gift card a failed reserve attempt was
 * minting — an inline copy that drifts would mint a second card and re-charge.
 *
 * 16 hex chars keeps the longest derived key (~`pay-card-` + 16 = 24, `payorder-`
 * + 16 = 25) well under Square's 45-char idempotency_key limit.
 */
export function reserveBaseKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
