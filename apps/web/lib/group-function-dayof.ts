import { buildSquareLineItem } from "@/lib/plu-catalog-map";
import {
  updateGfQuoteDetails,
  appendAuditLog,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";

/**
 * Creates the OPEN day-of Square order for a group function event. Staff redeem the loaded
 * gift card against it at the event, and the day-of payout cron applies the gift card.
 *
 * Best-effort: tries catalog-linked line items first, then ad-hoc (name + price). Returns
 * the order id, or `undefined` if both attempts fail — the caller decides how to handle it.
 * Its failure is intentionally non-fatal to the deposit charge.
 *
 * Shared by the deposit flow (initial creation) and group-quote-sync (self-heal backfill
 * when the deposit-time attempt failed — e.g. a transient Square error). Keep this the
 * single source of truth for day-of order creation.
 */
const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** Created day-of order: its id plus Square's authoritative tax-inclusive total (cents). */
export interface DayofOrder {
  id: string;
  totalCents: number;
}

export async function createDayofOrder(
  quote: GroupFunctionQuote,
  baseKey: string,
): Promise<DayofOrder | undefined> {
  const rawItems = quote.line_items as Array<{
    name: string;
    price: number;
    tax: number;
    qty: number;
    total: number;
    plu: string;
  }>;
  const serviceCharges =
    quote.tax_cents > 0
      ? [
          {
            name: "Service Charge",
            amount_money: { amount: quote.tax_cents, currency: "USD" },
            calculation_phase: "SUBTOTAL_PHASE",
          },
        ]
      : [];
  const refId = `GF-${quote.event_number || quote.bmi_reservation_id}`.slice(0, 40);

  // Attempt 1: catalog-linked. base_price_money carries the (possibly overridden)
  // price, which Square honors over the catalog default — see plu-catalog-map.ts.
  try {
    const lineItems = rawItems.map((p) => buildSquareLineItem(quote.center_code, p));
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: refId,
          line_items: lineItems,
          service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) {
      return { id: data.order.id, totalCents: data.order.total_money?.amount ?? 0 };
    }
    console.warn("[gf-dayof] catalog day-of order failed, falling back to ad-hoc:", data);
  } catch (err) {
    console.warn("[gf-dayof] catalog day-of order error, falling back to ad-hoc:", err);
  }

  // Attempt 2: ad-hoc line items (name + price, no catalog link)
  try {
    const adHocItems = rawItems.map((p) => ({
      name: p.name,
      quantity: String(p.qty),
      base_price_money: { amount: Math.round(p.price * 100), currency: "USD" },
    }));
    const res = await fetch(`${SQUARE_BASE}/orders`, {
      method: "POST",
      headers: sqHeaders(),
      body: JSON.stringify({
        idempotency_key: `gf-dayof-adhoc-${baseKey}`,
        order: {
          location_id: quote.square_location_id,
          reference_id: refId,
          line_items: adHocItems,
          service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
        },
      }),
    });
    const data = await res.json();
    if (res.ok && data.order?.id) {
      console.log("[gf-dayof] day-of order created via ad-hoc fallback:", data.order.id);
      return { id: data.order.id, totalCents: data.order.total_money?.amount ?? 0 };
    }
    console.error("[gf-dayof] ad-hoc day-of order also failed:", data);
  } catch (err) {
    console.error("[gf-dayof] ad-hoc day-of order error:", err);
  }

  return undefined;
}

/** Cancel an OPEN day-of order (best-effort). Needs the current version for the PUT. */
async function cancelDayofOrder(orderId: string, locationId: string): Promise<void> {
  const cur = await (
    await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() })
  ).json();
  if (cur.order?.state === "CANCELED") return;
  await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    method: "PUT",
    headers: sqHeaders(),
    body: JSON.stringify({
      order: { location_id: locationId, version: cur.order?.version, state: "CANCELED" },
    }),
  });
}

const DAYOF_RECONCILE_TOLERANCE_CENTS = 50;

export type DayofReconcileResult =
  | { action: "noop" | "skipped_no_order"; reason?: string }
  | {
      action: "rebuilt";
      oldOrderId: string;
      newOrderId: string;
      oldTotalCents: number;
      newTotalCents: number;
    }
  | { action: "skipped_mismatch"; reason: string; attemptedTotalCents: number };

/**
 * Self-heal the day-of Square order so it always matches the current contract.
 *
 * The day-of order is created ONCE at deposit time and otherwise frozen, so any
 * post-deposit reprice (added product, changed lanes, service-charge tier) leaves it
 * stale — at the event the loaded gift card no longer matches the order staff redeem
 * against (the H1174 / #80 incident, 2026-06-16). This is called on every dispatch
 * pass that touches an existing event, so a resend reconciles the order.
 *
 * Behavior:
 *   - No existing day-of order        → no-op (the deposit flow owns first creation).
 *   - Existing order total ≈ contract → no-op (within 50c per-line rounding).
 *   - Otherwise rebuild from current line items, BUT only repoint if the rebuilt total
 *     matches total_cents (±50c). A divergence means the contract total itself is wrong
 *     (e.g. a tax-exempt event whose total omits tax, #23) — we cancel the throwaway
 *     order and leave the pointer alone rather than booking a wrong amount.
 *
 * Best-effort and non-fatal: callers wrap in try/catch and never block the resend on it.
 */
export async function reconcileDayofOrder(
  quote: GroupFunctionQuote,
  baseKey: string,
): Promise<DayofReconcileResult> {
  const existingId = quote.square_dayof_order_id;
  if (!existingId) return { action: "skipped_no_order" };

  // What does the current order total? A canceled order forces a rebuild.
  let currentTotal = -1;
  try {
    const j = await (
      await fetch(`${SQUARE_BASE}/orders/${existingId}`, { headers: sqHeaders() })
    ).json();
    if (j.order && j.order.state !== "CANCELED") currentTotal = j.order.total_money?.amount ?? -1;
  } catch {
    /* fetch failure → treat as needing rebuild */
  }
  if (
    currentTotal >= 0 &&
    Math.abs(currentTotal - quote.total_cents) <= DAYOF_RECONCILE_TOLERANCE_CENTS
  ) {
    return { action: "noop" };
  }

  const dayof = await createDayofOrder(quote, baseKey);
  if (!dayof)
    return {
      action: "skipped_mismatch",
      reason: "createDayofOrder failed",
      attemptedTotalCents: 0,
    };

  // Guard: the rebuilt order must equal the contract total. If not, the contract total is
  // the suspect value (tax-exempt mismatch etc.) — don't silently repoint to a wrong amount.
  if (Math.abs(dayof.totalCents - quote.total_cents) > DAYOF_RECONCILE_TOLERANCE_CENTS) {
    await cancelDayofOrder(dayof.id, quote.square_location_id).catch(() => {});
    return {
      action: "skipped_mismatch",
      reason: `rebuilt total ${dayof.totalCents} != contract total_cents ${quote.total_cents}`,
      attemptedTotalCents: dayof.totalCents,
    };
  }

  await updateGfQuoteDetails(quote.id, { square_dayof_order_id: dayof.id });
  await cancelDayofOrder(existingId, quote.square_location_id).catch(() => {});
  await appendAuditLog({
    quoteId: quote.id,
    event: "dayof_order_reconciled",
    metadata: {
      oldOrderId: existingId,
      oldTotalCents: currentTotal,
      newOrderId: dayof.id,
      newTotalCents: dayof.totalCents,
      trigger: "dispatch_reconcile",
    },
  }).catch(() => {});

  return {
    action: "rebuilt",
    oldOrderId: existingId,
    newOrderId: dayof.id,
    oldTotalCents: currentTotal,
    newTotalCents: dayof.totalCents,
  };
}
