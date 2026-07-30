/**
 * WEB redemption: put a voucher's value on a card the guest ALREADY holds.
 *
 * The kiosk leg dispenses a fresh card; there is no dispenser on a phone, so the
 * web leg asks for the guest's existing card number (typed, or scanned with the
 * camera on /reload) and credits that. Same voucher, same single-use claim, same
 * ledger row — only the fulfilment differs (`kind='voucher_reload'`, so
 * clear-on-encode never touches a card with the guest's own balance on it).
 *
 * ORDER IS THE WHOLE DESIGN. The card is verified BEFORE the claim is taken, so
 * a typo'd card number costs the guest nothing: a voucher must never be burned
 * on a card that doesn't exist. Then claim → credit. If the credit doesn't
 * confirm, the claim STANDS and the row is left `pending` for the reconcile cron
 * — the same recover-forward doctrine as a paid reload, because the alternative
 * (release on a maybe-credited card) risks paying out twice.
 */

import { getCenter } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import { verifyAccount } from "../data/intercard";
import { getTxn } from "../data/transactions-log";
import { claimNativeVoucher, releaseNativeVoucher } from "./native-voucher";
import { applyCreditPlan, creditPlanForRow, planIsEmpty } from "./credit-plan";
import { markLoadState } from "../data/transactions-log";
import { logVoucherEvent } from "../data/vouchers-db";
import { isNativeVoucherCode, normalizeVoucherCode } from "../vouchers/codes";

export type WebRedeemResult =
  | {
      ok: true;
      accountNumber: string;
      credited: { tokens: number; bonusTokens: number };
      /** Balance after the credit, when Intercard answered. */
      balance?: { tokens: number; bonusTokens: number };
      /** True when the credit didn't confirm — recovery is in flight. */
      pending?: boolean;
    }
  | { ok: false; reason: string };

export async function redeemVoucherToCard(input: {
  code: string;
  accountNumber: string;
  locationCode: number;
}): Promise<WebRedeemResult> {
  const code = normalizeVoucherCode(input.code);
  // Web is OUR vouchers only: a BMI comp's value has to be read back off BMI and
  // its fulfilment is a dispense, so it has no web leg (see the router).
  if (!isNativeVoucherCode(code)) return { ok: false, reason: "bad_format" };
  if (!getCenter(input.locationCode)) {
    throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");
  }

  // 1. Does this card exist? Cheap, non-destructive, and it protects the
  //    voucher from a mistyped number.
  let account: string;
  try {
    const v = await verifyAccount(input.accountNumber, input.locationCode);
    if (!v.exists) return { ok: false, reason: "card_not_found" };
    account = v.accountNumber || input.accountNumber;
  } catch (err) {
    console.error("[voucher-web] verify failed:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "card_lookup_failed" };
  }

  // 2. Claim + durable row. Nothing has been credited yet.
  const claim = await claimNativeVoucher({
    code,
    locationCode: input.locationCode,
    accountNumber: account,
    source: "web",
  });
  if (!claim.ok) return { ok: false, reason: claim.reason };

  // 3. Credit. From here the voucher stays spent even on failure.
  const row = await getTxn(claim.txnId);
  const plan = row ? creditPlanForRow(row) : null;
  if (!row || !plan || planIsEmpty(plan)) {
    // Our own row is unusable — nothing was credited, so give the code back.
    await releaseNativeVoucher({ code, txnId: claim.txnId, reason: "ledger row unusable" });
    return { ok: false, reason: "storage" };
  }

  let credited = false;
  try {
    const { code: rc } = await applyCreditPlan(plan, {
      locationCode: input.locationCode,
      accountNumber: account,
      tpiTransactionID: row.tpiTransactionId,
    });
    credited = rc === 0;
    if (!credited) {
      console.error(`[voucher-web] credit code ${rc} txn=${row.txnId} card=${account} — pending`);
    }
  } catch (err) {
    console.error("[voucher-web] credit threw:", err instanceof Error ? err.message : err);
  }

  await markLoadState(
    row.txnId,
    credited ? "loaded" : "pending",
    credited ? undefined : "web voucher credit not confirmed",
    credited ? "soap" : undefined,
  );
  await logVoucherEvent(code, credited ? "redeem" : "scan", {
    txnId: row.txnId,
    accountNumber: account,
    credited,
    surface: "web",
  });

  let balance: { tokens: number; bonusTokens: number } | undefined;
  if (credited) {
    try {
      const v = await verifyAccount(account, input.locationCode);
      if (v.balance) {
        balance = { tokens: v.balance.tokens, bonusTokens: v.balance.bonusTokens };
      }
    } catch {
      /* display-only */
    }
  }

  return {
    ok: true,
    accountNumber: account,
    credited: { tokens: plan.tokens, bonusTokens: plan.bonusTokens },
    balance,
    // The cron will finish an unconfirmed credit; tell the guest it's coming
    // rather than implying nothing happened (their voucher IS spent).
    ...(credited ? {} : { pending: true }),
  };
}
