/**
 * What a ledger row credits, and how — the ONE resolver shared by the live load
 * path (`load-card.ts`) and the recover-forward cron (`reconcile.ts`).
 *
 * Why it's shared: those two paths credit the same card from the same row, and
 * before vouchers existed they each independently did
 * `getPackage(row.packageId)` → `creditTokens(tokens, bonusTokens)`. A comp row
 * resolves through a different registry (`vouchers/grants.ts`, not
 * `TOKEN_PACKAGES` — a $0 tile must never appear in the sellable grid), and a
 * bonus-CASH grant needs a different SOAP call entirely. Two copies of that
 * branch would drift, and the way it would drift is silent: the cron would
 * "successfully" credit 0 tokens and mark the row loaded. One resolver, both
 * callers.
 *
 * Ordering note: resolve by `packageId` FIRST (the grant/package registries are
 * the authority) and fall back to the row's own `tokens`/`bonus_tokens` columns
 * only when the id is unknown — that mirrors the pre-existing reconcile
 * behaviour for retired package ids.
 */

import { getPackage } from "../constants";
import { gameCardGrantFromPackageId, isVoucherPackageId } from "../vouchers/grants";
// Routed transport: onsite first, cloud SOAP fallback (data/intercard-router.ts).
import { creditAccountValues } from "../data/intercard-router";
import type { TxnKind } from "../types";

export interface CreditPlan {
  /** Purchased-token bucket. */
  tokens: number;
  /** Promo-token bucket (where comped token value lands). */
  bonusTokens: number;
  /** Intercard `<BonusCash>` dollars — 0 for every shipped grant. */
  bonusCashDollars: number;
  /** True when this plan can ride the on-prem bridge (`/credit` speaks tokens
   *  only). A cash grant must take the cloud SOAP path. */
  bridgeable: boolean;
}

/** The row fields the plan needs — a structural subset of TxnRow. */
export interface CreditableRow {
  kind: TxnKind;
  packageId: string;
  tokens: number;
  bonusTokens: number;
}

export function creditPlanForRow(row: CreditableRow): CreditPlan | null {
  if (isVoucherPackageId(row.packageId)) {
    const grant = gameCardGrantFromPackageId(row.packageId);
    // Unknown/off-allowlist grant id → credit NOTHING. A hand-edited or
    // retired `gzv-*` row must not fall back to the row's own columns: those
    // are as editable as the id, and this is the free-value path.
    if (!grant) return null;
    return {
      tokens: grant.tokens,
      bonusTokens: grant.bonusTokens,
      bonusCashDollars: grant.bonusCashDollars,
      bridgeable: grant.bonusCashDollars === 0,
    };
  }
  const pkg = getPackage(row.packageId);
  return {
    tokens: pkg?.tokens ?? row.tokens,
    bonusTokens: pkg?.bonusTokens ?? row.bonusTokens,
    bonusCashDollars: 0,
    bridgeable: true,
  };
}

/** Nothing to credit — a zero plan means the caller must NOT report "loaded". */
export function planIsEmpty(plan: CreditPlan): boolean {
  return plan.tokens === 0 && plan.bonusTokens === 0 && plan.bonusCashDollars === 0;
}

/**
 * Issue the credit. Single Intercard call for every bucket (TPICreditAccounts
 * takes them together), idempotent on `tpiTransactionID` — the caller must pass
 * the row's stored, stable id so a replay never double-credits.
 */
export async function applyCreditPlan(
  plan: CreditPlan,
  args: { locationCode: number; accountNumber: string; tpiTransactionID: string },
): Promise<{ code: number }> {
  return creditAccountValues({
    locationCode: args.locationCode,
    accountNumber: args.accountNumber,
    tokens: plan.tokens,
    tokenBonus: plan.bonusTokens,
    cashBonus: plan.bonusCashDollars,
    tpiTransactionID: args.tpiTransactionID,
  });
}
