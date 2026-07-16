/**
 * Game-card purchase order engine (cart of 1..10 cards, one Square charge).
 * Operation-agnostic: the Intercard step is keyed by `kind` (`reload` →
 * creditTokens now; `new_card` later).
 *
 * Doctrine (persist-first + recover-forward):
 *   verify EVERY card → persist a ledger row per card (shared group_id) → ONE
 *   Square charge for the sum → load each card independently. A card whose load
 *   fails leaves a durable `pending` row for the reconcile cron — never an
 *   auto-refund, never a stranded guest. Per-card idempotency keys mean one
 *   card failing never blocks the others.
 */
import { randomBytes, randomUUID } from "crypto";
import { authorizeMultiTender, SquarePaymentError } from "@/lib/square-gift-card";
import { getCenter } from "~/config/intercard-centers";
import { getPackage, type TokenPackage } from "../constants";
import { GameCardHttpError } from "../errors";
import type { PurchaseInput } from "../schemas";
import type { CardLoadResult, PurchaseResult } from "../types";
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

interface CartRow {
  accountNumber: string;
  pkg: TokenPackage;
  txnId: string;
  tpiTransactionId: string;
}

export async function purchase(input: PurchaseInput): Promise<PurchaseResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");

  if (input.items.length === 0) {
    throw new GameCardHttpError(400, "EMPTY_CART", "Add at least one card to reload.");
  }

  // Resolve packages server-side (never trust client amounts/tokens).
  const resolved = input.items.map((it) => {
    const pkg = getPackage(it.packageId);
    if (!pkg) throw new GameCardHttpError(400, "UNKNOWN_PACKAGE", "That package isn't available.");
    return { accountNumber: it.accountNumber, pkg };
  });

  // ── 1. Verify EVERY card (read-only) — never charge if any can't be confirmed ──
  for (const r of resolved) {
    try {
      const v = await verifyAccount(r.accountNumber, input.locationCode);
      if (!v.exists) {
        throw new GameCardHttpError(
          400,
          "CARD_NOT_FOUND",
          `We couldn't find card ${r.accountNumber}.`,
        );
      }
    } catch (err) {
      if (err instanceof GameCardHttpError) throw err;
      if (err instanceof IntercardError) {
        throw new GameCardHttpError(
          503,
          "VERIFY_UNAVAILABLE",
          "We couldn't check the card(s) right now. Please try again in a moment.",
        );
      }
      throw err;
    }
  }

  // ── 2. Persist BEFORE charging (throws if DB down → we don't move money) ──
  const groupId = randomUUID();
  const baseKey = randomBytes(8).toString("hex"); // 16 hex — fits Square's 45-char key limit
  const totalCents = resolved.reduce((sum, r) => sum + r.pkg.priceCents, 0);

  const rows: CartRow[] = [];
  for (const r of resolved) {
    const txnId = randomUUID();
    const tpiTransactionId = `reload-${txnId}`;
    await startTxn({
      txnId,
      groupId,
      kind: input.kind,
      locationCode: input.locationCode,
      accountNumber: r.accountNumber,
      packageId: r.pkg.id,
      tokens: r.pkg.tokens,
      bonusTokens: r.pkg.bonusTokens,
      amountCents: r.pkg.priceCents,
      tpiTransactionId,
      contact: input.contact,
    });
    rows.push({ accountNumber: r.accountNumber, pkg: r.pkg, txnId, tpiTransactionId });
  }

  // ── 3. One Square order (line per card) + one charge for the sum ─────────
  let orderId: string;
  try {
    orderId = await createReloadOrder({
      squareLocation: center.squareLocation,
      baseKey,
      lines: resolved.map((r) => ({
        label: r.pkg.label,
        amountCents: r.pkg.priceCents,
        accountNumber: r.accountNumber,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "order setup failed";
    for (const row of rows) await markChargeFailed(row.txnId, msg);
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
      totalCents,
      baseKey,
      giftCardNonce: input.giftCardNonce,
      cardSourceId: input.cardNonce,
      customerId: input.squareCustomerId,
      buyerEmail: input.contact?.email,
      note:
        rows.length === 1
          ? `${rows[0].pkg.label} → card ${rows[0].accountNumber} @ ${center.label}`
          : `${rows.length}-card reload @ ${center.label}`,
    });
    paymentIds = { gc: t.gcPaymentId ?? null, card: t.cardPaymentId ?? null };
  } catch (err) {
    if (err instanceof SquarePaymentError) {
      for (const row of rows) await markChargeFailed(row.txnId, `${err.code}: ${err.message}`);
      const friendly = FRIENDLY_DECLINE[err.code] || err.message;
      throw new GameCardHttpError(400, err.code, friendly);
    }
    const msg = err instanceof Error ? err.message : "charge failed";
    for (const row of rows) await markChargeFailed(row.txnId, msg);
    throw err;
  }

  for (const row of rows) await markCharged(row.txnId, orderId, paymentIds);

  // ── 4. Load each card independently (recover forward per card) ────────────
  const results: CardLoadResult[] = [];
  for (const row of rows) {
    let loaded = false;
    try {
      const { code } = await creditTokens({
        locationCode: input.locationCode,
        accountNumber: row.accountNumber,
        tokens: row.pkg.tokens,
        bonusTokens: row.pkg.bonusTokens,
        tpiTransactionID: row.tpiTransactionId,
      });
      if (code === 0) loaded = true;
      else
        console.error(
          `[game-cards] load code ${code} txn=${row.txnId} card=${row.accountNumber} — pending`,
        );
    } catch (err) {
      console.error(
        `[game-cards] load threw txn=${row.txnId} card=${row.accountNumber}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await markLoadState(
      row.txnId,
      loaded ? "loaded" : "pending",
      loaded ? undefined : "load not confirmed",
    );

    let balance;
    let transactions;
    if (loaded) {
      try {
        const v = await verifyAccount(row.accountNumber, input.locationCode);
        balance = v.balance;
        transactions = v.transactions;
      } catch {
        /* non-fatal */
      }
    }
    results.push({
      accountNumber: row.accountNumber,
      tokens: row.pkg.tokens,
      bonusTokens: row.pkg.bonusTokens,
      loaded,
      creditPending: !loaded,
      balance,
      transactions,
    });
  }

  return {
    ok: true,
    charged: true,
    results,
    anyPending: results.some((r) => r.creditPending),
    receiptUrl: null,
  };
}
