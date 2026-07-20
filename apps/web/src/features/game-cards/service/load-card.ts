/**
 * Load tokens onto ONE just-dispensed new card (buy flow, phase 2).
 *
 * The charge already happened up front (chargeNewCardOrder) — this attaches the
 * account read off the dispensed blank to its ledger row and credits it. Keyed
 * by the row's stable `tpi_transaction_id` (Intercard dedups), so a retry is
 * safe. A load that doesn't confirm leaves a `pending` row for the reconcile
 * cron — never an auto-refund (same recover-forward doctrine as reload).
 *
 * The caller MUST NOT present the card unless `loaded` is true; on a failed
 * load the kiosk captures the blank to the error bin instead of handing over
 * an empty card.
 */
import { getCenter } from "~/config/intercard-centers";
import { getPackage } from "../constants";
import { GameCardHttpError } from "../errors";
import type { LoadCardInput } from "../schemas";
import type { CardBalance } from "../types";
import { creditTokens, verifyAccount } from "../data/intercard";
import { getTxn, markLoadState, setTxnAccount } from "../data/transactions-log";

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
  // kiosk PC's on-prem bridge then reported here). The website reload path never
  // calls this — it credits inline via SOAP.
  if (row.kind !== "new_card" && row.kind !== "reload") {
    throw new GameCardHttpError(400, "WRONG_KIND", "That transaction can't be loaded here.");
  }

  const pkg = getPackage(row.packageId);
  if (!pkg) throw new GameCardHttpError(400, "UNKNOWN_PACKAGE", "That package isn't available.");

  // Idempotent: a row already loaded (e.g. a client retry) just returns balance.
  if (row.loadState === "loaded") {
    const v = await verifyAccount(input.accountNumber, input.locationCode).catch(() => null);
    return {
      loaded: true,
      accountNumber: input.accountNumber,
      tokens: pkg.tokens,
      bonusTokens: pkg.bonusTokens,
      balance: v?.balance,
    };
  }

  // Must be paid for before we credit anything (no free loads).
  if (row.state !== "charged") {
    throw new GameCardHttpError(409, "NOT_CHARGED", "That card hasn't been paid for yet.");
  }

  // new_card: attach the account read off the blank (the row was charged with an
  // empty account). reload: the account was known at purchase — guard it matches
  // rather than overwrite, so a mixed-up client payload can't credit a stranger.
  if (row.kind === "new_card") {
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
    try {
      const { code } = await creditTokens({
        locationCode: input.locationCode,
        accountNumber: input.accountNumber,
        tokens: pkg.tokens,
        bonusTokens: pkg.bonusTokens,
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
    tokens: pkg.tokens,
    bonusTokens: pkg.bonusTokens,
    balance,
  };
}
