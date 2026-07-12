/**
 * Square mutations for the reservation-edit cascade. Rules inherited from
 * the cancellation cascade + tasks/lessons.md:
 *
 *  - Re-fetch every object immediately before mutating it.
 *  - 200-with-errors[] is a failure (sq() enforces).
 *  - Order PUTs use the freshly fetched version (OCC) and verify the
 *    returned total against the plan's calculated total — a mismatch aborts
 *    loudly (money may already be captured; forward recovery re-runs).
 *  - All idempotency keys derive from the editId (`edit-{anchor}-a{n}`);
 *    longest key stays well under Square's 45-char payment/card limit.
 */

import { fetchGiftCardFacts, fetchPaymentFacts, sq } from "~/features/cancellation/square-actions";

import type { PlanLine } from "./plan";

const err = (what: string, r: { status: number; json: unknown }): Error =>
  new Error(
    `${what} failed (${r.status}): ${JSON.stringify((r.json as { errors?: unknown })?.errors ?? r.json).slice(0, 300)}`,
  );

/* ── Top-up: small closed order + full-cover payment ─────────────────── */

/**
 * Charge a price INCREASE: a one-line "Reservation Edit — additional deposit"
 * order (deposit-order shape: no tax — the day-of order carries the tax), paid
 * in full by `sourceId` (card on file / payment-link nonce). Returns the
 * payment id the caller must persist BEFORE any downstream step.
 */
export const createEditTopupOrderAndCharge = async (params: {
  editId: string;
  locationId: string;
  amountCents: number;
  note: string;
  sourceId: string;
  squareCustomerId?: string;
}): Promise<{ orderId: string; paymentId: string }> => {
  const orderRes = await sq("POST", "/orders", {
    idempotency_key: `${params.editId}-topup-order`,
    order: {
      location_id: params.locationId,
      ...(params.squareCustomerId ? { customer_id: params.squareCustomerId } : {}),
      line_items: [
        {
          name: "Reservation Edit — additional deposit",
          quantity: "1",
          base_price_money: { amount: params.amountCents, currency: "USD" },
          note: params.note,
        },
      ],
    },
  });
  if (!orderRes.ok || !orderRes.json?.order?.id) throw err("edit top-up order create", orderRes);
  const orderId: string = orderRes.json.order.id;

  const payRes = await sq("POST", "/payments", {
    idempotency_key: `${params.editId}-topup-pay`,
    source_id: params.sourceId,
    amount_money: { amount: params.amountCents, currency: "USD" },
    order_id: orderId,
    location_id: params.locationId,
    autocomplete: true,
    ...(params.squareCustomerId ? { customer_id: params.squareCustomerId } : {}),
    note: params.note,
  });
  if (!payRes.ok || !payRes.json?.payment?.id) throw err("edit top-up payment", payRes);
  return { orderId, paymentId: payRes.json.payment.id };
};

/* ── Partial refund (decreases) ───────────────────────────────────────── */

/**
 * Refund PART of one payment, clamped to its un-refunded remainder — a
 * replayed call refunds only what's still owed (or no-ops). Returns what was
 * actually refunded this call.
 *
 * `skipGiftCardTender`: Square refuses PARTIAL refunds of gift-card-funded
 * payments (live finding 2026-07-11) — full refunds are fine. Allocators set
 * this to hop over a GC tender when the ask would be partial, instead of
 * failing mid-cascade; the caller settles the shortfall elsewhere (store
 * credit) or fails loudly.
 */
export const refundTenderPartial = async (params: {
  editId: string;
  refundIndex: number;
  paymentId: string;
  amountCents: number;
  reason: string;
  skipGiftCardTender?: boolean;
}): Promise<{ refundId?: string; refundedCents: number; skippedGiftCard?: boolean }> => {
  const pay = await fetchPaymentFacts(params.paymentId);
  const remaining = pay.amountCents - pay.refundedCents;
  if (
    params.skipGiftCardTender &&
    pay.sourceType === "GIFT_CARD" &&
    params.amountCents < remaining
  ) {
    // The ask covers only PART of this gift-card payment — Square would
    // refuse it. A full-remainder ask proceeds (full GC refunds are legal).
    return { refundedCents: 0, skippedGiftCard: true };
  }
  const amount = Math.min(params.amountCents, Math.max(0, remaining));
  if (amount <= 0) return { refundedCents: 0 };
  const r = await sq("POST", "/refunds", {
    idempotency_key: `${params.editId}-r${params.refundIndex}`,
    payment_id: params.paymentId,
    amount_money: { amount, currency: "USD" },
    reason: params.reason,
  });
  if (!r.ok || !r.json?.refund) throw err(`partial refund of ${params.paymentId}`, r);
  return { refundId: r.json.refund.id, refundedCents: amount };
};

/**
 * Facts about one refund — used to NET refunds recorded by prior failed /
 * crashed attempts out of what a retry still owes (without this, a retry
 * restarts from the full owed amount and over-refunds later tenders).
 */
export const fetchRefundFacts = async (
  refundId: string,
): Promise<{ paymentId: string; amountCents: number; status: string }> => {
  const r = await sq("GET", `/refunds/${refundId}`);
  if (!r.ok || !r.json?.refund) throw err(`refund ${refundId} fetch`, r);
  const refund = r.json.refund;
  return {
    paymentId: refund.payment_id ?? "",
    amountCents: refund.amount_money?.amount ?? 0,
    status: refund.status ?? "?",
  };
};

/* ── Gift-card exact adjust-down ──────────────────────────────────────── */

/**
 * ADJUST_DECREMENT the internal deposit card by EXACTLY `amountCents`
 * (deposit == day-of total invariant maintenance after a decrease). Clamps to
 * the live balance; state-checked so a replay after success no-ops via the
 * idempotency key.
 */
export const adjustGiftCardDown = async (params: {
  editId: string;
  giftCardId: string;
  amountCents: number;
}): Promise<number> => {
  const gc = await fetchGiftCardFacts(params.giftCardId);
  if (gc.state !== "ACTIVE" || gc.balanceCents <= 0) return 0;
  if (!gc.locationId) throw new Error(`gift card ${params.giftCardId} has no activity location_id`);
  const amount = Math.min(params.amountCents, gc.balanceCents);
  const r = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${params.editId}-dec`,
    gift_card_activity: {
      type: "ADJUST_DECREMENT",
      location_id: gc.locationId,
      gift_card_id: params.giftCardId,
      adjust_decrement_activity_details: {
        amount_money: { amount, currency: "USD" },
        reason: "PURCHASE_WAS_REFUNDED",
      },
    },
  });
  if (!r.ok) throw err(`gift card ${params.giftCardId} adjust-down`, r);
  return amount;
};

/* ── Day-of order line update (the core edit write) ───────────────────── */

/**
 * PUT the desired line set onto the day-of order. Square's UpdateOrder is a
 * sparse MERGE: lines with a uid update in place, lines without append, and
 * removals go through fields_to_clear ("line_items[<uid>]"). The desired
 * lines' uids were claimed from the live order by the plan; any live uid not
 * present in `desired` is cleared.
 *
 * Verifies the returned tax-inclusive total equals `expectedTotalCents` (the
 * plan's orders/calculate result). On mismatch the order is NOT rolled back —
 * the caller surfaces a loud recoverable error (re-run heals via idempotency).
 */
export const updateDayofOrderLines = async (params: {
  editId: string;
  orderId: string;
  desired: PlanLine[];
  expectedTotalCents: number;
}): Promise<{ totalCents: number; version: number }> => {
  const fresh = await sq("GET", `/orders/${params.orderId}`);
  if (!fresh.ok || !fresh.json?.order) throw err(`order ${params.orderId} fetch`, fresh);
  const order = fresh.json.order as {
    version: number;
    location_id: string;
    state: string;
    line_items?: Array<{ uid: string }>;
  };
  if (order.state !== "OPEN" && order.state !== "DRAFT") {
    throw new Error(`order ${params.orderId} not editable (state ${order.state})`);
  }

  const desiredUids = new Set(params.desired.map((l) => l.uid).filter(Boolean));
  const fieldsToClear = (order.line_items ?? [])
    .filter((li) => !desiredUids.has(li.uid))
    .map((li) => `line_items[${li.uid}]`);

  const lineWrites = params.desired.map((l) => ({
    ...(l.uid ? { uid: l.uid } : {}),
    ...(l.catalogObjectId ? { catalog_object_id: l.catalogObjectId } : { name: l.name }),
    quantity: String(l.quantity),
    base_price_money: { amount: l.unitPriceCents, currency: "USD" },
    ...(l.note ? { note: l.note } : {}),
  }));

  const r = await sq("PUT", `/orders/${params.orderId}`, {
    idempotency_key: `${params.editId}-ord-${order.version}`,
    order: {
      location_id: order.location_id,
      version: order.version,
      line_items: lineWrites,
    },
    ...(fieldsToClear.length > 0 ? { fields_to_clear: fieldsToClear } : {}),
  });
  if (!r.ok || !r.json?.order) throw err(`order ${params.orderId} update`, r);
  const totalCents: number = r.json.order.total_money?.amount ?? 0;
  if (totalCents !== params.expectedTotalCents) {
    throw new Error(
      `order ${params.orderId} total after update (${totalCents}) != planned (${params.expectedTotalCents}) — verify before retrying`,
    );
  }
  return { totalCents, version: r.json.order.version ?? order.version + 1 };
};

/* ── Mid-phase direct charge against the day-of order ─────────────────── */

/**
 * Charge a mid-session INCREASE directly against the OPEN day-of order
 * (food-route pattern: charge FIRST, then the caller PUTs the new lines).
 */
export const chargeDayofOrder = async (params: {
  editId: string;
  orderId: string;
  locationId: string;
  amountCents: number;
  sourceId: string;
  squareCustomerId?: string;
  note: string;
}): Promise<{ paymentId: string }> => {
  const r = await sq("POST", "/payments", {
    idempotency_key: `${params.editId}-mid-pay`,
    source_id: params.sourceId,
    amount_money: { amount: params.amountCents, currency: "USD" },
    order_id: params.orderId,
    location_id: params.locationId,
    autocomplete: true,
    ...(params.squareCustomerId ? { customer_id: params.squareCustomerId } : {}),
    note: params.note,
  });
  if (!r.ok || !r.json?.payment?.id) throw err("mid-session charge", r);
  return { paymentId: r.json.payment.id };
};
