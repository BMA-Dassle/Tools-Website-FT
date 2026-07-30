/**
 * Load value onto ONE just-dispensed card (buy flow phase 2, and voucher
 * redemption) or report a reload.
 *
 * For a PAID row the charge already happened up front (chargeNewCardOrder) —
 * this attaches the account read off the dispensed blank to its ledger row and
 * credits it. Keyed by the row's stable `tpi_transaction_id` (Intercard
 * dedups), so a retry is safe. A load that doesn't confirm leaves a `pending`
 * row for the reconcile cron — never an auto-refund (same recover-forward
 * doctrine as reload).
 *
 * FREE LOADS ARE STILL FORBIDDEN. `kind='voucher'` rows carry no money, so the
 * "was it charged?" gate is replaced — not removed — by "is the BMI comp
 * voucher still claimed for this row?" (game_card_voucher_claims, the global
 * single-use authority). The invariant is therefore paid OR voucher-claimed;
 * an unauthorised row credits nothing, which also means an orphan row left by a
 * raced claim can never dispense value.
 *
 * The caller MUST NOT present the card unless `loaded` is true; on a failed
 * load the kiosk captures the blank to the error bin instead of handing over
 * an empty card.
 */
import { getCenter } from "~/config/intercard-centers";
import { GameCardHttpError } from "../errors";
import type { LoadCardInput } from "../schemas";
import type { CardBalance } from "../types";
import { clearAccount, verifyAccount } from "../data/intercard";
import { getTxn, markLoadState, setTxnAccount } from "../data/transactions-log";
import { getLiveClaimForTxn } from "../data/voucher-claims-db";
import { applyCreditPlan, creditPlanForRow, planIsEmpty } from "./credit-plan";

export interface LoadCardResult {
  loaded: boolean;
  accountNumber: string;
  tokens: number;
  bonusTokens: number;
  balance?: CardBalance;
}

export async function loadCard(input: LoadCardInput): Promise<LoadCardResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");

  const row = await getTxn(input.txnId);
  if (!row || row.groupId !== input.groupId) {
    throw new GameCardHttpError(404, "TXN_NOT_FOUND", "That purchase couldn't be found.");
  }
  // new_card (blank dispensed then loaded) OR reload (existing card, loaded on the
  // kiosk PC's on-prem bridge then reported here) OR voucher (blank dispensed
  // against a BMI comp — no money leg). The website reload path never calls this
  // — it credits inline via SOAP.
  if (row.kind !== "new_card" && row.kind !== "reload" && row.kind !== "voucher") {
    throw new GameCardHttpError(400, "WRONG_KIND", "That transaction can't be loaded here.");
  }
  /** A blank taken from the stacker (paid or comped) vs a guest's own card. */
  const isFreshBlank = row.kind !== "reload";

  const plan = creditPlanForRow(row);
  if (!plan || planIsEmpty(plan)) {
    throw new GameCardHttpError(400, "UNKNOWN_PACKAGE", "That package isn't available.");
  }

  // Idempotent: a row already loaded (e.g. a client retry) just returns balance.
  if (row.loadState === "loaded") {
    const v = await verifyAccount(input.accountNumber, input.locationCode).catch(() => null);
    return {
      loaded: true,
      accountNumber: input.accountNumber,
      tokens: plan.tokens,
      bonusTokens: plan.bonusTokens,
      balance: v?.balance,
    };
  }

  // Must be paid for before we credit anything (no free loads).
  if (row.state !== "charged") {
    throw new GameCardHttpError(409, "NOT_CHARGED", "That card hasn't been paid for yet.");
  }

  // A comped row's authority is the voucher claim, not a payment. Re-read it
  // HERE rather than trusting the row: the claim is what makes the voucher
  // single-use, and the row alone can exist without one (claim raced, or a
  // release already handed the code back). No live claim → credit nothing.
  if (row.kind === "voucher") {
    const claim = await getLiveClaimForTxn(row.txnId);
    if (!claim) {
      throw new GameCardHttpError(
        409,
        "VOUCHER_NOT_CLAIMED",
        "That voucher isn't held for this card.",
      );
    }
    if (claim.packageId !== row.packageId) {
      // The claim and the ledger row disagree about what was granted — refuse
      // rather than pick one (this is the free-value path).
      throw new GameCardHttpError(409, "VOUCHER_MISMATCH", "That voucher doesn't match this card.");
    }
  }

  // new_card: attach the account read off the blank (the row was charged with an
  // empty account). reload: the account was known at purchase — guard it matches
  // rather than overwrite, so a mixed-up client payload can't credit a stranger.
  if (isFreshBlank) {
    await setTxnAccount(input.txnId, input.accountNumber);
  } else if (row.accountNumber && row.accountNumber !== input.accountNumber) {
    throw new GameCardHttpError(
      400,
      "ACCOUNT_MISMATCH",
      "The card doesn't match this transaction.",
    );
  }

  let loaded = false;
  if (input.preLoaded) {
    // The kiosk PC's on-prem bridge already credited the tokens via the local
    // EIS server — record it, do NOT re-credit through the cloud SOAP path
    // (the two paths don't share dedup, so double-crediting must be avoided).
    loaded = true;
    console.log(
      `[game-cards] new-card load via on-prem bridge txn=${row.txnId} card=${input.accountNumber}`,
    );
  } else {
    // Clear-on-encode (GC_CLEAR_ON_ENCODE): de-register the card's existing
    // account BEFORE crediting (clearAccount → TPI_ClearAccount), so a RECYCLED
    // card can't stack old value on top of the new load — the credit then
    // re-materializes the account clean (behavior confirmed live 2026-07-23, see
    // clearAccount). Cloud/SOAP path only (preLoaded=false) and cards taken from
    // the STACKER only (paid new_card or comped voucher — both are recycled
    // stock) — NEVER a reload (that would wipe the guest's own balance). If the
    // clear doesn't confirm, we must NOT credit (would over-credit an uncleared
    // card): mark the row load_failed so the reconcile cron never SOAP-credits
    // it, and the kiosk retains the blank + routes to an attendant (payment is
    // safe). (Owner 2026-07-22: the vendor's 24h-before-reuse guidance is
    // intentionally ignored here — clears immediately before the credit.)
    if (isFreshBlank && process.env.GC_CLEAR_ON_ENCODE === "1") {
      let clearOk = false;
      try {
        const { code } = await clearAccount({
          accountNumbers: [input.accountNumber],
          locationCode: input.locationCode,
        });
        clearOk = code === 0;
        if (!clearOk) {
          console.error(
            `[game-cards] clear-on-encode code ${code} txn=${row.txnId} card=${input.accountNumber}`,
          );
        }
      } catch (err) {
        console.error(
          `[game-cards] clear-on-encode threw txn=${row.txnId} card=${input.accountNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }
      if (!clearOk) {
        await markLoadState(input.txnId, "load_failed", "clear-on-encode did not confirm");
        return {
          loaded: false,
          accountNumber: input.accountNumber,
          tokens: plan.tokens,
          bonusTokens: plan.bonusTokens,
        };
      }
    }
    try {
      const { code } = await applyCreditPlan(plan, {
        locationCode: input.locationCode,
        accountNumber: input.accountNumber,
        tpiTransactionID: row.tpiTransactionId,
      });
      loaded = code === 0;
      if (!loaded) {
        console.error(
          `[game-cards] new-card load code ${code} txn=${row.txnId} card=${input.accountNumber} — pending`,
        );
      }
    } catch (err) {
      console.error(
        `[game-cards] new-card load threw txn=${row.txnId} card=${input.accountNumber}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  await markLoadState(
    input.txnId,
    loaded ? "loaded" : "pending",
    loaded ? undefined : "load not confirmed",
    loaded ? (input.preLoaded ? "kiosk_bridge" : "soap") : undefined,
  );

  let balance: CardBalance | undefined;
  if (loaded) {
    try {
      balance = (await verifyAccount(input.accountNumber, input.locationCode)).balance;
    } catch {
      /* non-fatal — the load is what matters */
    }
  }

  return {
    loaded,
    accountNumber: input.accountNumber,
    tokens: plan.tokens,
    bonusTokens: plan.bonusTokens,
    balance,
  };
}
