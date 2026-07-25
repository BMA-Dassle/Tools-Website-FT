/**
 * Square primitives for the cancellation cascade — reads used to build the
 * plan, mutations used to execute it. Rules inherited from the proven combo
 * close-out (_itl0um08-close.mts) + tasks/lessons.md:
 *
 *  - Re-fetch every object immediately before mutating it (never trust a
 *    minutes-old snapshot for money).
 *  - A Square 200 can still carry errors[] (idempotency replays of failures) —
 *    always check the body.
 *  - "Paid" = tenders present, never state === "COMPLETED".
 *  - Order PUTs use the freshly fetched version (OCC); gift-card activity
 *    reasons are ENUMS (ADJUST_DECREMENT → PURCHASE_WAS_REFUNDED,
 *    create-DEACTIVATE → SUSPICIOUS_ACTIVITY).
 */
import { CancelGuardError, type GatheredFacts } from "./types";
import { guardDayofOrder } from "./guards";

const BASE = "https://connect.squareup.com/v2";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function sq(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  // 200-with-errors = idempotency replay of a prior failure — treat as failure.
  const ok = res.ok && !(json && Array.isArray(json.errors) && json.errors.length > 0);
  return { ok, status: res.status, json };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function squareErr(what: string, r: { status: number; json: unknown }): Error {
  return new Error(
    `${what} failed (${r.status}): ${JSON.stringify((r.json as { errors?: unknown })?.errors ?? r.json).slice(0, 300)}`,
  );
}

// ── Reads (plan building; also re-run inside each mutation) ─────────────────

export async function fetchGiftCardFacts(
  giftCardId: string,
): Promise<NonNullable<GatheredFacts["giftCard"]>> {
  const card = await sq("GET", `/gift-cards/${giftCardId}`);
  if (!card.ok || !card.json?.gift_card) throw squareErr(`gift card ${giftCardId} fetch`, card);
  const gc = card.json.gift_card;
  const acts = await sq("GET", `/gift-cards/activities?gift_card_id=${giftCardId}&limit=50`);
  const activities: Array<{ location_id?: string }> = acts.ok
    ? (acts.json?.gift_card_activities ?? [])
    : [];
  return {
    id: gc.id,
    gan: gc.gan ?? "",
    state: gc.state ?? "?",
    balanceCents: gc.balance_money?.amount ?? 0,
    locationId: activities.find((a) => a.location_id)?.location_id,
  };
}

/** One Square order line item, reduced to what the manage UI shows. */
export interface OrderLineItem {
  name: string;
  /** Square returns quantity as a string; keep it verbatim for "×N" display. */
  quantity: string;
  /** Line total (already qty-multiplied, tax/discount applied) in cents. */
  totalCents: number;
}
/** A flat service charge on the order (GF day-of orders carry these). */
export interface OrderServiceCharge {
  name: string;
  totalCents: number;
}

export async function fetchOrderFacts(orderId: string): Promise<
  GatheredFacts["dayofOrders"][string] & {
    tenders: Array<{ paymentId: string; amountCents: number }>;
    lineItems: OrderLineItem[];
    serviceCharges: OrderServiceCharge[];
  }
> {
  const r = await sq("GET", `/orders/${orderId}`);
  if (!r.ok || !r.json?.order) throw squareErr(`order ${orderId} fetch`, r);
  const o = r.json.order;
  const tenders = (o.tenders ?? [])
    .map((t: { payment_id?: string; amount_money?: { amount?: number } }) => ({
      paymentId: t.payment_id ?? "",
      amountCents: t.amount_money?.amount ?? 0,
    }))
    .filter((t: { paymentId: string }) => t.paymentId);
  const lineItems: OrderLineItem[] = (o.line_items ?? []).map(
    (li: { name?: string; quantity?: string; total_money?: { amount?: number } }) => ({
      name: li.name ?? "Item",
      quantity: li.quantity ?? "1",
      totalCents: li.total_money?.amount ?? 0,
    }),
  );
  const serviceCharges: OrderServiceCharge[] = (o.service_charges ?? []).map(
    (sc: { name?: string; total_money?: { amount?: number } }) => ({
      name: sc.name ?? "Service charge",
      totalCents: sc.total_money?.amount ?? 0,
    }),
  );
  return {
    id: o.id,
    state: o.state ?? "?",
    version: o.version ?? 0,
    locationId: o.location_id ?? "",
    tenderCount: (o.tenders ?? []).length,
    netDueCents: o.net_amount_due_money?.amount ?? 0,
    totalCents: o.total_money?.amount ?? 0,
    tenders,
    lineItems,
    serviceCharges,
  };
}

export async function fetchPaymentFacts(
  paymentId: string,
): Promise<GatheredFacts["payments"][string]> {
  const r = await sq("GET", `/payments/${paymentId}`);
  if (!r.ok || !r.json?.payment) throw squareErr(`payment ${paymentId} fetch`, r);
  const p = r.json.payment;
  return {
    id: p.id,
    status: p.status ?? "?",
    amountCents: p.amount_money?.amount ?? 0,
    refundedCents: p.refunded_money?.amount ?? 0,
    // "CARD" | "GIFT_CARD" | "WALLET" | … — gift-card tenders can't be
    // partially refunded (live finding 2026-07-11), so refund allocators
    // must know what funded the payment.
    sourceType: p.source_type ?? undefined,
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Refund one deposit tender. Exactly-once: re-fetches the payment and refunds
 * only the still-unrefunded remainder (a replayed call becomes a no-op).
 */
export async function refundTender(p: {
  cascadeId: string;
  tenderIndex: number;
  paymentId: string;
  reason: string;
}): Promise<{ refundId?: string; refundedCents: number }> {
  const pay = await fetchPaymentFacts(p.paymentId);
  const remaining = pay.amountCents - pay.refundedCents;
  if (remaining <= 0) {
    console.log(`[cancel/square] payment ${p.paymentId} already fully refunded — skip`);
    return { refundedCents: 0 };
  }
  const r = await sq("POST", "/refunds", {
    idempotency_key: `${p.cascadeId}-r${p.tenderIndex}`,
    payment_id: p.paymentId,
    amount_money: { amount: remaining, currency: "USD" },
    reason: p.reason,
  });
  if (!r.ok || !r.json?.refund) throw squareErr(`refund of payment ${p.paymentId}`, r);
  return { refundId: r.json.refund.id, refundedCents: remaining };
}

/**
 * Drain the internal deposit gift card to $0 (ADJUST_DECREMENT of EXACTLY the
 * live balance, reason PURCHASE_WAS_REFUNDED — the enum for "its funding was
 * refunded"). Skips when not ACTIVE or already $0 — idempotent by state.
 */
export async function drainGiftCard(p: { cascadeId: string; giftCardId: string }): Promise<number> {
  const gc = await fetchGiftCardFacts(p.giftCardId);
  if (gc.state !== "ACTIVE" || gc.balanceCents <= 0) {
    console.log(
      `[cancel/square] gift card ${p.giftCardId} state=${gc.state} balance=${gc.balanceCents} — no drain needed`,
    );
    return 0;
  }
  if (!gc.locationId) throw new Error(`gift card ${p.giftCardId} has no activity location_id`);
  const r = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${p.cascadeId}-drain`,
    gift_card_activity: {
      type: "ADJUST_DECREMENT",
      location_id: gc.locationId,
      gift_card_id: p.giftCardId,
      adjust_decrement_activity_details: {
        amount_money: { amount: gc.balanceCents, currency: "USD" },
        reason: "PURCHASE_WAS_REFUNDED",
      },
    },
  });
  if (!r.ok) throw squareErr(`gift card ${p.giftCardId} drain`, r);
  return gc.balanceCents;
}

/** Deactivate the internal deposit card (SUSPICIOUS_ACTIVITY is the only enum Square accepts for a create-deactivate). Skips when already terminal. */
export async function deactivateGiftCard(p: {
  cascadeId: string;
  giftCardId: string;
}): Promise<void> {
  const gc = await fetchGiftCardFacts(p.giftCardId);
  if (gc.state !== "ACTIVE") {
    console.log(
      `[cancel/square] gift card ${p.giftCardId} state=${gc.state} — no deactivate needed`,
    );
    return;
  }
  if (!gc.locationId) throw new Error(`gift card ${p.giftCardId} has no activity location_id`);
  const r = await sq("POST", "/gift-cards/activities", {
    idempotency_key: `${p.cascadeId}-deact`,
    gift_card_activity: {
      type: "DEACTIVATE",
      location_id: gc.locationId,
      gift_card_id: p.giftCardId,
      deactivate_activity_details: { reason: "SUSPICIOUS_ACTIVITY" },
    },
  });
  if (!r.ok) throw squareErr(`gift card ${p.giftCardId} deactivate`, r);
}

/**
 * Cancel a day-of order. Fresh GET decides: tendered → typed refusal (state
 * may have changed since the plan was built), already CANCELED/COMPLETED →
 * skip, OPEN/DRAFT → PUT state=CANCELED with the fresh version.
 */
export async function cancelDayofOrder(p: { orderId: string }): Promise<"cancelled" | "skipped"> {
  const o = await fetchOrderFacts(p.orderId);
  const disposition = guardDayofOrder(o);
  if (disposition === "refuse") {
    throw new CancelGuardError(
      "dayof_order_tendered",
      `Day-of order ${p.orderId} has ${o.tenderCount} tender(s) / state=${o.state} — manual path.`,
      409,
    );
  }
  if (disposition === "skip") return "skipped";
  const r = await sq("PUT", `/orders/${p.orderId}`, {
    order: { location_id: o.locationId, version: o.version, state: "CANCELED" },
  });
  if (!r.ok) throw squareErr(`order ${p.orderId} cancel`, r);
  return "cancelled";
}

/**
 * Delete a loyalty reward so the points return to the guest. REDEEMED rewards
 * can't be deleted (points already spent) — callers treat failure as a warning.
 */
export async function deleteLoyaltyReward(rewardId: string): Promise<void> {
  const r = await sq("DELETE", `/loyalty/rewards/${rewardId}`);
  if (!r.ok) throw squareErr(`loyalty reward ${rewardId} delete`, r);
}
