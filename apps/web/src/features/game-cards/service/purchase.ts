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
import { getPackage, activationFeeCents, type TokenPackage } from "../constants";
import { GameCardHttpError } from "../errors";
import type { PurchaseInput } from "../schemas";
import type { CardLoadResult, PurchaseResult } from "../types";
// Routed transport: onsite first, cloud SOAP fallback (data/intercard-router.ts).
import { creditTokens, verifyAccount, IntercardError } from "../data/intercard-router";
import { createReloadOrder } from "../data/square-order";
import {
  startTxn,
  markCharged,
  markChargedQueued,
  markChargeFailed,
  markLoadState,
  getGroupQueueStates,
} from "../data/transactions-log";
import { linkCard } from "../data/customer-cards";
import { saveCardOnFile } from "~/features/account/data/cards";
import { isEisQueueCenter } from "./bridge-queue";
import { assertSwipedBlanks } from "./swiped-blank-guard";

/**
 * Optional signed-in context. `verifiedCustomerId` is resolved by the route
 * from the session (validated ∈ session.squareCustomerIds) — NEVER trusted from
 * the client. When present we can save the payment card + auto-link the cards.
 */
export interface PurchaseOptions {
  verifiedCustomerId?: string;
}

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

/** One charged-but-unloaded new-card row, handed back for per-card dispense+load. */
export interface NewCardRow {
  txnId: string;
  packageId: string;
  tokens: number;
  bonusTokens: number;
  amountCents: number;
}

export interface NewCardChargeResult {
  ok: true;
  charged: true;
  groupId: string;
  rows: NewCardRow[];
}

/**
 * BUY (new cards): charge ONCE for a basket of blanks, then hand back one
 * ledger row per card. On a DISPENSER kiosk the account numbers aren't known
 * yet — each blank is dispensed + read + loaded afterward via `loadCard()`
 * (service/load-card.ts). On an MSR-only kiosk the guest swiped each blank
 * BEFORE paying, so the item carries its `accountNumber` and the row is
 * persisted with it (persist-first: a browser death after the charge leaves a
 * row the reconcile cron can still credit). No verify (nothing to verify) and
 * NO load here — that's the whole point of the split (charge must land before
 * we dispense/credit; load lands per card after).
 */
export async function chargeNewCardOrder(
  input: PurchaseInput,
  opts: PurchaseOptions = {},
): Promise<NewCardChargeResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");
  if (input.items.length === 0) {
    throw new GameCardHttpError(400, "EMPTY_CART", "Add at least one card.");
  }

  const resolved = input.items.map((it) => {
    const pkg = getPackage(it.packageId);
    if (!pkg) throw new GameCardHttpError(400, "UNKNOWN_PACKAGE", "That package isn't available.");
    // "" on a dispenser kiosk (read off the blank at load); the swiped blank's
    // number on an MSR-only kiosk.
    return { pkg, accountNumber: it.accountNumber ?? "" };
  });
  // Swiped blanks are re-checked server-side before anything is persisted or
  // charged — see swiped-blank-guard.ts. Dispenser items (no account) skip it.
  await assertSwipedBlanks(
    resolved.map((r) => r.accountNumber).filter((a) => a.length > 0),
    input.locationCode,
  );

  const groupId = randomUUID();
  const baseKey = randomBytes(8).toString("hex");
  // New cards owe the $2 activation fee — createReloadOrder(purpose:"purchase")
  // adds the matching fee line, so the charge MUST include it or the payment
  // wouldn't cover the order total.
  const totalCents =
    resolved.reduce((sum, r) => sum + r.pkg.priceCents, 0) +
    activationFeeCents("new_card", resolved.length);

  // Persist one row per card BEFORE charging (account attached later at load
  // when the dispenser reads it; already known when the guest swiped it).
  const rows: NewCardRow[] = [];
  const txnByRow: { txnId: string }[] = [];
  for (const r of resolved) {
    const txnId = randomUUID();
    await startTxn({
      txnId,
      groupId,
      kind: "new_card",
      locationCode: input.locationCode,
      accountNumber: r.accountNumber,
      packageId: r.pkg.id,
      tokens: r.pkg.tokens,
      bonusTokens: r.pkg.bonusTokens,
      amountCents: r.pkg.priceCents,
      tpiTransactionId: `newcard-${txnId}`,
      contact: input.contact,
    });
    rows.push({
      txnId,
      packageId: r.pkg.id,
      tokens: r.pkg.tokens,
      bonusTokens: r.pkg.bonusTokens,
      amountCents: r.pkg.priceCents,
    });
    txnByRow.push({ txnId });
  }

  // One Square order + one charge for the whole basket.
  let orderId: string;
  try {
    orderId = await createReloadOrder({
      squareLocation: center.squareLocation,
      baseKey,
      purpose: "purchase",
      lines: resolved.map((r) => ({
        label: r.pkg.label,
        amountCents: r.pkg.priceCents,
        accountNumber: r.accountNumber,
      })),
    });
  } catch {
    for (const t of txnByRow) await markChargeFailed(t.txnId, "order setup failed");
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
      note: `${rows.length}-card purchase @ ${center.label}`,
    });
    paymentIds = { gc: t.gcPaymentId ?? null, card: t.cardPaymentId ?? null };
  } catch (err) {
    if (err instanceof SquarePaymentError) {
      for (const t of txnByRow) await markChargeFailed(t.txnId, `${err.code}: ${err.message}`);
      throw new GameCardHttpError(400, err.code, FRIENDLY_DECLINE[err.code] || err.message);
    }
    const msg = err instanceof Error ? err.message : "charge failed";
    for (const t of txnByRow) await markChargeFailed(t.txnId, msg);
    throw err;
  }

  for (const t of txnByRow) await markCharged(t.txnId, orderId, paymentIds);

  // Best-effort: save the payment card for a signed-in guest (no cards to link yet).
  if (opts.verifiedCustomerId && input.saveCard && paymentIds.card) {
    try {
      await saveCardOnFile({
        customerId: opts.verifiedCustomerId,
        cardToken: paymentIds.card,
        idempotencyKey: `gc-savecard-${baseKey}`,
      });
    } catch (err) {
      console.error(
        "[game-cards] saveCardOnFile failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { ok: true, charged: true, groupId, rows };
}

export async function purchase(
  input: PurchaseInput,
  opts: PurchaseOptions = {},
): Promise<PurchaseResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");

  if (input.items.length === 0) {
    throw new GameCardHttpError(400, "EMPTY_CART", "Add at least one card to reload.");
  }

  // Resolve packages server-side (never trust client amounts/tokens).
  const resolved = input.items.map((it) => {
    const pkg = getPackage(it.packageId);
    if (!pkg) throw new GameCardHttpError(400, "UNKNOWN_PACKAGE", "That package isn't available.");
    // Reload requires a card number (schema refines this; guard keeps the type string).
    if (!it.accountNumber) {
      throw new GameCardHttpError(400, "CARD_NOT_FOUND", "A card number is required to reload.");
    }
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

  // Bridge-queue mode (flag-gated per center): mark charged AND enqueue in ONE
  // statement — a separate enqueue update would leave a (charged, pending,
  // queue_state NULL) window the reconcile cron could SOAP-credit before the
  // bridge claims, and the two credit paths share no dedup.
  const useQueue = input.kind === "reload" && isEisQueueCenter(input.locationCode);
  for (const row of rows) {
    if (useQueue) await markChargedQueued(row.txnId, orderId, paymentIds);
    else await markCharged(row.txnId, orderId, paymentIds);
  }

  // ── 3b. Signed-in perks (best-effort; never block/undo a settled charge) ──
  const customerId = opts.verifiedCustomerId;
  if (customerId) {
    // Save the payment card on file if the guest opted in (vault the card the
    // payment was made with — the captured payment id, not the spent nonce).
    if (input.saveCard && paymentIds.card) {
      try {
        await saveCardOnFile({
          customerId,
          cardToken: paymentIds.card,
          idempotencyKey: `gc-savecard-${baseKey}`,
        });
      } catch (err) {
        console.error(
          "[game-cards] saveCardOnFile failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Auto-link every reloaded card to the customer so it's remembered.
    for (const row of rows) {
      try {
        await linkCard({
          squareCustomerId: customerId,
          accountNumber: row.accountNumber,
          locationCode: input.locationCode,
        });
      } catch (err) {
        console.error("[game-cards] auto-link failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  // ── 4. Load each card independently (recover forward per card) ────────────
  const results: CardLoadResult[] = useQueue
    ? await awaitQueueOutcome(rows, groupId)
    : await loadCardsInline(rows, input.locationCode);

  return {
    ok: true,
    groupId,
    charged: true,
    results,
    anyPending: results.some((r) => r.creditPending),
    receiptUrl: null,
  };
}

/** Inline cloud-SOAP load — the v1 path, unchanged (non-queue centers). */
async function loadCardsInline(rows: CartRow[], locationCode: number): Promise<CardLoadResult[]> {
  const results: CardLoadResult[] = [];
  for (const row of rows) {
    let loaded = false;
    try {
      const { code } = await creditTokens({
        locationCode,
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
      loaded ? "soap" : undefined,
    );

    let balance;
    let transactions;
    if (loaded) {
      try {
        const v = await verifyAccount(row.accountNumber, locationCode);
        balance = v.balance;
        transactions = v.transactions;
      } catch {
        /* non-fatal */
      }
    }
    results.push({
      txnId: row.txnId,
      accountNumber: row.accountNumber,
      tokens: row.pkg.tokens,
      bonusTokens: row.pkg.bonusTokens,
      loaded,
      creditPending: !loaded,
      balance,
      transactions,
    });
  }
  return results;
}

/** Wait-loop bounds for the bridge-queue path (bridge polls every ~2.5s). */
const QUEUE_WAIT_MS = 12_000;
const QUEUE_POLL_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * OBSERVE the bridge queue for this group — deliberately no SOAP here (owner
 * decision 2026-07-20): if no bridge claims the job the guest sees "Credit
 * pending" and the reconcile cron flips the stale row to the SOAP path. This
 * request never credits in queue mode, so the EIS/SOAP double-credit window
 * doesn't exist here. Rows the bridge loads inside the window report as
 * loaded; no balance re-read — the cloud history endpoint won't reflect a
 * local EIS credit yet, and a stale balance on the success screen reads as a
 * failure.
 */
async function awaitQueueOutcome(rows: CartRow[], groupId: string): Promise<CardLoadResult[]> {
  const deadline = Date.now() + QUEUE_WAIT_MS;
  const loaded = new Set<string>();
  for (;;) {
    const states = await getGroupQueueStates(groupId);
    for (const s of states) if (s.loadState === "loaded") loaded.add(s.txnId);
    if (loaded.size === rows.length || Date.now() >= deadline) break;
    await sleep(Math.min(QUEUE_POLL_MS, Math.max(50, deadline - Date.now())));
  }
  return rows.map((row) => ({
    txnId: row.txnId,
    accountNumber: row.accountNumber,
    tokens: row.pkg.tokens,
    bonusTokens: row.pkg.bonusTokens,
    loaded: loaded.has(row.txnId),
    creditPending: !loaded.has(row.txnId),
  }));
}
