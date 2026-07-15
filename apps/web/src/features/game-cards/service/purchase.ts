/**
 * Game-card purchase order engine. Operation-agnostic: the Intercard step is a
 * strategy keyed by `kind` (`reload` → creditTokens now; `new_card` later).
 *
 * Ordering follows the repo's persist-first + recover-forward doctrine:
 *   verify (read-only) → persist ledger row → Square charge → Intercard load
 *   → flip load_state. A charge that succeeds but a load that fails leaves a
 *   durable `pending` row for the reconcile cron — never an auto-refund, never
 *   a stranded guest.
 */
import { randomBytes, randomUUID } from "crypto";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";
import { getCenter } from "~/config/intercard-centers";
import { getPackage } from "../constants";
import { GameCardHttpError } from "../errors";
import type { PurchaseInput } from "../schemas";
import type { PurchaseResult } from "../types";
import { creditTokens, verifyAccount, IntercardError } from "../data/intercard";
import { createReloadOrder } from "../data/square-order";
import { startTxn, markCharged, markChargeFailed, markLoadState } from "../data/transactions-log";

const FRIENDLY_DECLINE: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Card declined — insufficient funds. Try a different card.",
  GENERIC_DECLINE: "Card declined. Please try a different card.",
  CVV_FAILURE: "CVV check failed. Please re-enter your card details.",
  CARD_EXPIRED: "Card expired. Please use a different card.",
  CARD_DECLINED: "Card declined. Please try a different card.",
  CARD_DECLINED_VERIFICATION_REQUIRED: "Additional verification required. Please try again.",
};

export async function purchase(input: PurchaseInput): Promise<PurchaseResult> {
  const pkg = getPackage(input.packageId);
  if (!pkg) throw new GameCardHttpError(400, "UNKNOWN_PACKAGE", "That package isn't available.");

  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");

  // ── 1. Verify (read-only) — never charge a card we can't confirm ──────────
  try {
    const v = await verifyAccount(input.accountNumber, input.locationCode);
    if (!v.exists) {
      throw new GameCardHttpError(400, "CARD_NOT_FOUND", "We couldn't find that card number.");
    }
  } catch (err) {
    if (err instanceof GameCardHttpError) throw err;
    if (err instanceof IntercardError) {
      throw new GameCardHttpError(
        503,
        "VERIFY_UNAVAILABLE",
        "We couldn't check that card right now. Please try again in a moment.",
      );
    }
    throw err;
  }

  // ── 2. Persist BEFORE charging (throws if DB down → we don't move money) ──
  const txnId = randomUUID();
  const tpiTransactionId = `reload-${txnId}`;
  const baseKey = randomBytes(8).toString("hex"); // 16 hex — fits Square's 45-char key limit

  await startTxn({
    txnId,
    kind: input.kind,
    locationCode: input.locationCode,
    accountNumber: input.accountNumber,
    packageId: pkg.id,
    tokens: pkg.tokens,
    bonusTokens: pkg.bonusTokens,
    amountCents: pkg.priceCents,
    tpiTransactionId,
    contact: input.contact,
  });

  // ── 3. Square order + charge (server derives amount from the package) ─────
  let orderId: string;
  try {
    orderId = await createReloadOrder({
      squareLocation: center.squareLocation,
      amountCents: pkg.priceCents,
      label: pkg.label,
      accountNumber: input.accountNumber,
      baseKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "order setup failed";
    await markChargeFailed(txnId, msg);
    throw new GameCardHttpError(
      502,
      "PAYMENT_SETUP_FAILED",
      "Couldn't start the payment. Try again.",
    );
  }

  let paymentIds: { gc: string | null; card: string | null };
  try {
    const t = await authorizeMultiTender({
      orderId,
      locationId: center.squareLocation,
      totalCents: pkg.priceCents,
      baseKey,
      giftCardNonce: input.giftCardNonce,
      cardSourceId: input.cardNonce,
      customerId: input.squareCustomerId,
      buyerEmail: input.contact?.email,
      note: `${pkg.label} → card ${input.accountNumber} @ ${center.label}`,
    });
    paymentIds = { gc: t.gcPaymentId ?? null, card: t.cardPaymentId ?? null };
  } catch (err) {
    if (err instanceof SquarePaymentError) {
      await markChargeFailed(txnId, `${err.code}: ${err.message}`);
      const friendly = FRIENDLY_DECLINE[err.code] || err.message;
      throw new GameCardHttpError(400, err.code, friendly);
    }
    await markChargeFailed(txnId, err instanceof Error ? err.message : "charge failed");
    throw err;
  }

  await markCharged(txnId, orderId, paymentIds);

  // ── 4. Intercard load (recover forward on failure) ────────────────────────
  let loaded = false;
  try {
    const { code } = await creditTokens({
      locationCode: input.locationCode,
      accountNumber: input.accountNumber,
      tokens: pkg.tokens,
      bonusTokens: pkg.bonusTokens,
      tpiTransactionID: tpiTransactionId,
    });
    if (code === 0) {
      loaded = true;
    } else {
      console.error(
        `[game-cards] load returned code ${code} txn=${txnId} card=${input.accountNumber} — pending`,
      );
    }
  } catch (err) {
    console.error(
      `[game-cards] load threw txn=${txnId} card=${input.accountNumber}:`,
      err instanceof Error ? err.message : err,
    );
  }

  await markLoadState(
    txnId,
    loaded ? "loaded" : "pending",
    loaded ? undefined : "load not confirmed",
  );

  // ── 5. Best-effort fresh balance for the success screen ───────────────────
  let balance;
  if (loaded) {
    try {
      const v = await verifyAccount(input.accountNumber, input.locationCode);
      balance = v.balance;
    } catch {
      /* non-fatal — success screen falls back to no post-balance */
    }
  }

  return {
    ok: true,
    charged: true,
    loaded,
    creditPending: !loaded,
    receiptUrl: null,
    balance,
  };
}
