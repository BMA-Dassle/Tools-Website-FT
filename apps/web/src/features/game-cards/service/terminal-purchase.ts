/**
 * KIOSK direct-Terminal (Square reader) game-card purchase — persist-first,
 * two-phase sibling of purchase.ts's embed flow (owner 2026-07-19: the kiosk
 * must charge on the paired reader, not the card iframe). It reuses the SAME
 * primitives (verify → persist ledger rows → Square order → Intercard load) as
 * purchase.ts, but splits at the order so the reader can charge it:
 *
 *   prepare()  — verify (reload) + startTxn per card + createReloadOrder → the
 *                order id the reader charges. NOTHING charges here (persist-first:
 *                every card has a durable ledger row before any money moves).
 *   finalize() — the reader already captured the card against that order; verify
 *                the payment server-side (COMPLETED + OUR order + amount +
 *                location), mark the rows charged, then load (reload) / hand the
 *                rows back to dispense (new_card).
 *
 * There is structurally NO card token here → no double-charge path. Kept in its
 * own file so purchase.ts (the embed rail) is untouched.
 */
import { randomBytes, randomUUID } from "crypto";
import { upsertTerminalAnchor } from "~/features/booking/service/unified-reserve";
import { kioskAmbientGiftCardsEnabled } from "~/features/kiosk/flags";
import { getCenter } from "~/config/intercard-centers";
import { getPackage, activationFeeCents } from "../constants";
import { GameCardHttpError } from "../errors";
import type { TerminalPrepareInput, TerminalFinalizeInput } from "../schemas";
import { verifyAccount, IntercardError } from "../data/intercard";
import { createReloadOrder, readSquarePaymentSettled } from "../data/square-order";
import { startTxn, markCharged, markLoadState, getTxn } from "../data/transactions-log";

export interface TerminalPreparedRow {
  txnId: string;
  packageId: string;
  tokens: number;
  bonusTokens: number;
  amountCents: number;
  /** "" for a new_card (account attached when the blank is dispensed). */
  accountNumber: string;
}

export interface TerminalPrepareResult {
  groupId: string;
  orderId: string;
  totalCents: number;
  rows: TerminalPreparedRow[];
  /** Present when the gift-card split flag is on AND the split session anchor
   *  was durably written — the session secret the gift-card routes require.
   *  The checkout gate carries the groupId as this rail's `seed`. */
  splitToken?: string;
}

/**
 * PHASE 1 — verify (reload), persist one ledger row per card, and create the
 * Square order the reader will charge. Returns the order + rows; nothing charges.
 */
export async function prepareTerminalPurchase(
  input: TerminalPrepareInput,
): Promise<TerminalPrepareResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");
  if (input.items.length === 0) {
    throw new GameCardHttpError(400, "EMPTY_CART", "Add at least one card.");
  }

  const resolved = input.items.map((it) => {
    const pkg = getPackage(it.packageId);
    if (!pkg) throw new GameCardHttpError(400, "UNKNOWN_PACKAGE", "That package isn't available.");
    if (input.kind === "reload" && !it.accountNumber) {
      throw new GameCardHttpError(400, "CARD_NOT_FOUND", "A card number is required to reload.");
    }
    return { pkg, accountNumber: it.accountNumber ?? "" };
  });

  // Reload: verify EVERY card (read-only) BEFORE arming the reader.
  if (input.kind === "reload") {
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
  }

  const groupId = randomUUID();
  const baseKey = randomBytes(8).toString("hex");
  // New cards owe the $2 activation fee ON TOP of the token prices; createReloadOrder
  // adds the identical fee line for a "purchase", so this total == the order total
  // the reader charges (and == finalize's expected amount below).
  const totalCents =
    resolved.reduce((s, r) => s + r.pkg.priceCents, 0) +
    activationFeeCents(input.kind, resolved.length);

  // Persist BEFORE the order/charge (throws if the DB is down → no money moves).
  const rows: TerminalPreparedRow[] = [];
  for (const r of resolved) {
    const txnId = randomUUID();
    const tpiTransactionId = input.kind === "new_card" ? `newcard-${txnId}` : `reload-${txnId}`;
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
    rows.push({
      txnId,
      packageId: r.pkg.id,
      tokens: r.pkg.tokens,
      bonusTokens: r.pkg.bonusTokens,
      amountCents: r.pkg.priceCents,
      accountNumber: r.accountNumber,
    });
  }

  const orderId = await createReloadOrder({
    squareLocation: center.squareLocation,
    baseKey,
    purpose: input.kind === "new_card" ? "purchase" : "reload",
    lines: resolved.map((r) => ({
      label: r.pkg.label,
      amountCents: r.pkg.priceCents,
      accountNumber: r.accountNumber,
    })),
  });

  // Gift-card split (kiosk v1): the shared split rail authorizes the gift card
  // against the terminal ANCHOR, so this rail writes one too — keyed on the
  // groupId, which is the `seed` the checkout gate carries for Game Zone
  // purchases. Token only handed out when the anchor durably landed: a token
  // without an anchor would light the gift-card button and then answer
  // "no-session" to every tap on it.
  // Merge-writer (not a raw SET): a re-prepare of the same groupId must never
  // clobber tender bookkeeping the split routes already stored on this key.
  const written = await upsertTerminalAnchor(groupId, {
    depositOrderId: orderId,
    depositCents: totalCents,
    locationId: center.squareLocation,
    baseKey: groupId,
    splitToken: randomUUID(),
    // Standalone Game Zone: the deposit order IS the whole charge.
    totalCents,
    source: "gamezone",
  });
  const splitToken = written?.splitToken;

  return {
    groupId,
    orderId,
    totalCents,
    rows,
    ...(splitToken ? { splitToken, ambient: kioskAmbientGiftCardsEnabled() } : {}),
  };
}

export interface TerminalFinalizeResult {
  ok: true;
  charged: true;
  groupId: string;
  /** The charged rows to load per card client-side (via the on-prem bridge).
   *  Both reload + new_card return these; new_card dispenses first, reload's
   *  accounts are already known. */
  rows?: TerminalPreparedRow[];
}

/**
 * PHASE 2 — the reader captured the card against our order. Verify the payment
 * server-side, mark the rows charged (NEVER re-charge), then load (reload) or
 * hand the rows back to dispense (new_card).
 */
export async function finalizeTerminalPurchase(
  input: TerminalFinalizeInput,
): Promise<TerminalFinalizeResult> {
  const center = getCenter(input.locationCode);
  if (!center) throw new GameCardHttpError(400, "UNKNOWN_LOCATION", "Pick a valid location.");

  // Re-read the persisted rows — amounts are server-authoritative, never trusted
  // from the client (which only supplies the txn id pointers PREPARE returned).
  const txns = [];
  for (const txnId of input.txnIds) {
    const row = await getTxn(txnId);
    if (!row || row.groupId !== input.groupId) {
      throw new GameCardHttpError(
        400,
        "TXN_NOT_FOUND",
        "We couldn't match your payment to the order. Please see the front desk.",
      );
    }
    txns.push(row);
  }
  // Match prepare's total: token prices + the new-card activation fee (per card).
  const expectedCents =
    txns.reduce((s, t) => s + t.amountCents, 0) + activationFeeCents(input.kind, txns.length);

  // Verify the reader payment(s) server-side (displayed==charged tripwire lives
  // here). Poll briefly: the Terminal checkout reports COMPLETED a beat before
  // GET /payments reflects it, so a single read stranded good captures.
  // SPLIT checkouts (gift card + tap): every captured payment is verified with
  // the same per-payment checks, and the AMOUNT check is the SUM across the set
  // (PayOrder captures it atomically). One id degenerates to the legacy checks.
  const ep = input.externalPayment;
  const paymentIdList =
    ep.paymentIds && ep.paymentIds.length > 0 ? [...new Set(ep.paymentIds)] : [ep.paymentId];
  let summedCents = 0;
  for (const pid of paymentIdList) {
    const pay = await readSquarePaymentSettled(pid);
    if (!pay || pay.status !== "COMPLETED") {
      throw new GameCardHttpError(
        402,
        "PAYMENT_UNVERIFIED",
        "We couldn't confirm the reader payment. Please see the front desk (do not pay again).",
      );
    }
    if (pay.orderId && pay.orderId !== ep.orderId) {
      throw new GameCardHttpError(
        402,
        "PAYMENT_ORDER_MISMATCH",
        "That payment doesn't match this order. Please see the front desk.",
      );
    }
    if (pay.locationId && pay.locationId !== center.squareLocation) {
      throw new GameCardHttpError(
        402,
        "PAYMENT_LOCATION_MISMATCH",
        "Payment location mismatch. Please see the front desk.",
      );
    }
    // effectiveCents: on a partial-auth capture Square may keep amount_money
    // at the requested figure while approved_money carries the truth.
    summedCents += pay.effectiveCents;
  }
  if (summedCents !== expectedCents) {
    throw new GameCardHttpError(
      402,
      "PAYMENT_AMOUNT_MISMATCH",
      "The charged amount didn't match the order. Please see the front desk.",
    );
  }

  // Record the capture on every row (no re-charge; card-present payment id).
  for (const t of txns) await markCharged(t.txnId, ep.orderId, { card: ep.paymentId });

  // new_card: hand the charged rows back — dispense + per-card load run client-side.
  if (input.kind === "new_card") {
    return {
      ok: true,
      charged: true,
      groupId: input.groupId,
      rows: txns.map((t) => ({
        txnId: t.txnId,
        packageId: t.packageId,
        tokens: t.tokens,
        bonusTokens: t.bonusTokens,
        amountCents: t.amountCents,
        accountNumber: t.accountNumber,
      })),
    };
  }

  // reload: hand the charged rows back so the kiosk PC loads each via the on-prem
  // bridge, then reports through /load-card (owner 2026-07-19: ALL kiosk cards load
  // on the bridge — only the WEBSITE reload uses cloud SOAP). Mark pending now so
  // the reconcile cron is the safety net if the client never reports.
  for (const t of txns) {
    await markLoadState(t.txnId, "pending", "awaiting on-prem bridge load");
  }
  return {
    ok: true,
    charged: true,
    groupId: input.groupId,
    rows: txns.map((t) => ({
      txnId: t.txnId,
      packageId: t.packageId,
      tokens: t.tokens,
      bonusTokens: t.bonusTokens,
      amountCents: t.amountCents,
      accountNumber: t.accountNumber,
    })),
  };
}
