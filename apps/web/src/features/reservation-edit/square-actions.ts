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
 * `skipGiftCardTender`: hops over a gift-card tender when the ask would be a
 * PARTIAL refund of it, leaving the caller to settle elsewhere (store credit)
 * or fail loudly.
 *
 * NOTE this is now over-conservative, not a Square limit. It was added for the
 * 2026-07-11 finding "Square refuses partial refunds of gift-card-funded
 * payments", which an owner-authorized live probe OVERTURNED on 2026-07-27 —
 * the API accepts them (reproduced twice, real card → gift card → order
 * chain). Kept opt-in so existing allocators behave identically; item-refund
 * allocators should pass `false` so a guest's own gift-card tender can take
 * its share back. See tasks/lessons.md and tasks/future/post-dayof-refund-plan.md.
 */
export const refundTenderPartial = async (params: {
  editId: string;
  refundIndex: number;
  paymentId: string;
  amountCents: number;
  reason: string;
  skipGiftCardTender?: boolean;
  /**
   * Return order this refund is attributed to. Set for the DAY-OF leg so the
   * refunded items show as returned in Square's item-level reporting; the
   * deposit/cash leg has no itemizable lines (one funding line) and omits it.
   */
  returnOrderId?: string;
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
    ...(params.returnOrderId ? { order_id: params.returnOrderId } : {}),
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

/* ── Itemized returns ─────────────────────────────────────────────────── */

/**
 * Create a RETURN order for specific line items of a paid order, then refund
 * the payment AGAINST it — the only way a refund is allowed to be issued
 * (owner rule 2026-07-27: never amount-only).
 *
 * A bare `POST /v2/refunds` records a dollar figure and nothing else: the
 * returned item never appears in Square's item-level sales reporting and QBO
 * cannot categorize it, so the books show revenue that was actually reversed.
 * Square models this properly as a separate order carrying
 * `returns[].source_order_id` + `return_line_items[].source_line_item_uid`,
 * which does NOT mutate the original (whose lines are immutable once tendered
 * — see tasks/lessons.md). Probed live 2026-07-27.
 *
 * Square computes the tax-inclusive return total itself
 * (`return_amounts.total_money`), so that figure — not our own tax math — is
 * the authoritative amount to refund.
 */
export const createReturnOrder = async (params: {
  editId: string;
  /** The PAID order the items are coming off. */
  sourceOrderId: string;
  locationId: string;
  lines: Array<{ uid: string; quantity: number }>;
  /** Disambiguates the idempotency key when a plan returns more than once. */
  seq?: number;
}): Promise<{ returnOrderId: string; returnTotalCents: number }> => {
  if (params.lines.length === 0) {
    throw new Error(
      `no line items identified to return from order ${params.sourceOrderId} — refunds must be ` +
        `itemized, never amount-only`,
    );
  }
  const r = await sq("POST", "/orders", {
    idempotency_key: `${params.editId}-ret${params.seq ?? 0}`,
    order: {
      location_id: params.locationId,
      returns: [
        {
          source_order_id: params.sourceOrderId,
          return_line_items: params.lines.map((l, i) => ({
            uid: `R${i}`,
            source_line_item_uid: l.uid,
            quantity: String(l.quantity),
          })),
        },
      ],
    },
  });
  if (!r.ok || !r.json?.order?.id) throw err(`return order for ${params.sourceOrderId}`, r);
  const returnTotalCents = r.json.order.return_amounts?.total_money?.amount ?? 0;
  if (returnTotalCents <= 0) {
    throw new Error(
      `return order ${r.json.order.id} computed a ${returnTotalCents}¢ total — refusing to refund ` +
        `against an empty return`,
    );
  }
  return { returnOrderId: r.json.order.id, returnTotalCents };
};

/* ── Wait for a refund's credit to land on the gift card ─────────────── */

export interface RefundCreditWait {
  /** True once the refund reached a terminal SUCCESS state. */
  settled: boolean;
  /** Square's last-seen refund status (COMPLETED / PENDING / FAILED / …). */
  status: string;
  /** Gift-card balance observed on the final poll, when readable. */
  balanceCents?: number;
}

/**
 * Poll until a refund of a gift-card-funded payment has actually CREDITED the
 * gift card, or until `timeoutMs` elapses.
 *
 * Why this exists (live finding 2026-07-27): Square returns these refunds as
 * PENDING and posts the credit to the card ASYNCHRONOUSLY — the payment showed
 * `refunded_money` before any REFUND activity appeared on the card. Every
 * downstream step that reads the card's balance is therefore wrong if it runs
 * immediately:
 *
 *   - `adjustGiftCardDown` reads balance 0, returns 0 WITHOUT posting, and its
 *     idempotency key is spent → the credit lands seconds later and stays on
 *     the card forever, while the guest also keeps the deposit refund. That is
 *     silent double value, once per occurrence.
 *   - draining/deactivating the card in this window strands the credit (it
 *     happened to probe card …1430 on 2026-07-27).
 *
 * Verification is by REFUND STATUS first (authoritative, and immune to a
 * concurrent spend moving the balance), with the observed balance returned for
 * the caller's invariant check. A timeout is NOT an error here: the caller
 * parks the attempt as resumable rather than guessing.
 */
export const waitForRefundCredit = async (params: {
  refundId: string;
  giftCardId?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<RefundCreditWait> => {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const pollMs = params.pollMs ?? 5_000;
  const sleep = params.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  let status = "UNKNOWN";
  let balanceCents: number | undefined;

  for (;;) {
    const r = await sq("GET", `/refunds/${params.refundId}`);
    status = r.json?.refund?.status ?? status;

    if (status === "FAILED" || status === "REJECTED") {
      // The money never left; treat as terminal-unsettled so the caller can
      // fail loudly instead of decrementing against a credit that isn't coming.
      return { settled: false, status, balanceCents };
    }
    if (status === "COMPLETED") {
      if (params.giftCardId) {
        try {
          balanceCents = (await fetchGiftCardFacts(params.giftCardId)).balanceCents;
        } catch {
          /* balance is advisory — status is the gate */
        }
      }
      return { settled: true, status, balanceCents };
    }
    if (Date.now() >= deadline) return { settled: false, status, balanceCents };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
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
  // Returning 0 here is NOT success — it means the credit this decrement was
  // meant to cancel has not landed (or the card is unusable). The caller must
  // treat a short return as fatal: silently completing leaves the refunded
  // value sitting on the card while the guest also keeps their card refund.
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
