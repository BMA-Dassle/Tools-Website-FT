import { buildSquareLineItem } from "@/lib/plu-catalog-map";
import { buildDayofOrderShape } from "@/lib/gf-square-tax";
import {
  updateGfQuoteDetails,
  appendAuditLog,
  type GroupFunctionQuote,
} from "@/lib/group-function-db";

/**
 * Creates the OPEN day-of Square order for a group function event. Staff redeem the loaded
 * gift card against it at the event, and the day-of payout cron applies the gift card.
 *
 * Best-effort, in descending order of correctness: the taxed shape (tax booked as tax, the
 * service charge as a real Square service charge — see gf-square-tax.ts), then the legacy
 * shape, then ad-hoc (name + price) if the catalog links themselves are the problem.
 * Returns the order id, or `undefined` if every attempt fails — the caller decides how to
 * handle it. Its failure is intentionally non-fatal to the deposit charge.
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

const DAYOF_RECONCILE_TOLERANCE_CENTS = 50;

/** Square's CreateOrder response, narrowed to what the callers here actually read. */
interface CreateOrderResponse {
  order?: {
    id?: string;
    total_money?: { amount?: number };
    total_tax_money?: { amount?: number };
  };
  errors?: unknown;
}

/** POST an order at a quote's location under its `GF-<event>` reference. */
async function postOrder(
  quote: GroupFunctionQuote,
  idempotencyKey: string,
  order: object,
): Promise<{ ok: boolean; data: CreateOrderResponse }> {
  const refId = `GF-${quote.event_number || quote.bmi_reservation_id}`.slice(0, 40);
  const res = await fetch(`${SQUARE_BASE}/orders`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      order: { location_id: quote.square_location_id, reference_id: refId, ...order },
    }),
  });
  return { ok: res.ok, data: await res.json() };
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
  /**
   * LEGACY shape, kept only as a fallback. It books `tax_cents` as a service charge and
   * lets the contract's service-charge PLU ride in as a "Legacy Service Charge"
   * merchandise line — the right total in the wrong two slots. See gf-square-tax.ts for
   * why that was wrong and what replaced it.
   */
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

  const post = (idempotencyKey: string, order: object) => postOrder(quote, idempotencyKey, order);

  // Attempt 1: the taxed shape — tax in `taxes`, service charge in `service_charges`.
  // Square computes both from catalog objects, so the total is its arithmetic, not ours.
  // It agrees with the contract to the cent on real events at all three venues; the guard
  // below is for the case it someday does not, because booking a WRONG AMOUNT is worse
  // than booking a right amount in the wrong slot for one more event.
  const shape = buildDayofOrderShape({
    centerCode: quote.center_code,
    locationId: quote.square_location_id,
    products: rawItems,
    taxExempt: quote.is_tax_exempt,
  });
  if (shape) {
    try {
      const { ok, data } = await post(`gf-dayof-taxed-${baseKey}`, shape);
      if (ok && data.order?.id) {
        const totalCents = data.order.total_money?.amount ?? 0;
        const drift = Math.abs(totalCents - quote.total_cents);
        if (drift <= DAYOF_RECONCILE_TOLERANCE_CENTS) {
          return { id: data.order.id, totalCents };
        }
        console.warn(
          `[gf-dayof] taxed shape totalled ${totalCents} vs contract ${quote.total_cents} ` +
            `(drift ${drift}c) for ${refId} — canceling and falling back to the legacy shape`,
        );
        await cancelDayofOrder(data.order.id, quote.square_location_id).catch(() => {});
      } else {
        console.warn("[gf-dayof] taxed shape rejected by Square, falling back:", data);
      }
    } catch (err) {
      console.warn("[gf-dayof] taxed shape error, falling back:", err);
    }
  } else {
    console.warn(
      `[gf-dayof] ${refId} cannot be modelled with catalog taxes ` +
        `(location=${quote.square_location_id}) — using the legacy shape`,
    );
  }

  // Attempt 2: legacy catalog-linked. base_price_money carries the (possibly overridden)
  // price, which Square honors over the catalog default — see plu-catalog-map.ts.
  try {
    const lineItems = rawItems.map((p) => buildSquareLineItem(quote.center_code, p));
    const { ok, data } = await post(`gf-dayof-${baseKey}`, {
      line_items: lineItems,
      service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
    });
    if (ok && data.order?.id) {
      return { id: data.order.id, totalCents: data.order.total_money?.amount ?? 0 };
    }
    console.warn("[gf-dayof] catalog day-of order failed, falling back to ad-hoc:", data);
  } catch (err) {
    console.warn("[gf-dayof] catalog day-of order error, falling back to ad-hoc:", err);
  }

  // Attempt 3: ad-hoc line items (name + price, no catalog link)
  try {
    const adHocItems = rawItems.map((p) => ({
      name: p.name,
      quantity: String(p.qty),
      base_price_money: { amount: Math.round(p.price * 100), currency: "USD" },
    }));
    const { ok, data } = await post(`gf-dayof-adhoc-${baseKey}`, {
      line_items: adHocItems,
      service_charges: serviceCharges.length > 0 ? serviceCharges : undefined,
    });
    if (ok && data.order?.id) {
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

export type DayofReconcileResult =
  | { action: "noop" | "skipped_no_order"; reason?: string }
  | {
      action: "rebuilt";
      oldOrderId: string;
      newOrderId: string;
      oldTotalCents: number;
      newTotalCents: number;
      /** Set when the rebuild was driven by a center move, not a price change. */
      relocatedFrom?: string;
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
 * It is ALSO what moves the money when an event changes venue. FastTrax and HeadPinz
 * Fort Myers share one BMI client, so a move keeps the same project and the quote's
 * `square_location_id` is re-synced in place (group-quote-dispatch) — but the day-of
 * order was already created at the OLD location, and a Square order's location is
 * immutable. A location mismatch therefore forces a rebuild even when the total is
 * unchanged, or the event's whole day-of revenue rings up at the venue it left.
 *
 * Behavior:
 *   - No existing day-of order        → no-op (the deposit flow owns first creation).
 *   - Existing order at another location → rebuild (center move).
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

  // What does the current order total, and where does it live? A canceled order
  // forces a rebuild. `currentLocation` is also what we must cancel the old order
  // AT — a Square order PUT has to carry that order's own location, so passing the
  // quote's (already-updated) location would fail the cancel on a center move and
  // leave two live orders for one event.
  let currentTotal = -1;
  let currentLocation = "";
  try {
    const j = await (
      await fetch(`${SQUARE_BASE}/orders/${existingId}`, { headers: sqHeaders() })
    ).json();
    if (j.order && j.order.state !== "CANCELED") {
      currentTotal = j.order.total_money?.amount ?? -1;
      currentLocation = j.order.location_id ?? "";
    }
  } catch {
    /* fetch failure → treat as needing rebuild */
  }
  const relocated = Boolean(
    currentLocation && quote.square_location_id && currentLocation !== quote.square_location_id,
  );
  if (
    !relocated &&
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
  // Cancel the superseded order at ITS location (see currentLocation above).
  await cancelDayofOrder(existingId, currentLocation || quote.square_location_id).catch(() => {});
  await appendAuditLog({
    quoteId: quote.id,
    event: "dayof_order_reconciled",
    metadata: {
      oldOrderId: existingId,
      oldTotalCents: currentTotal,
      newOrderId: dayof.id,
      newTotalCents: dayof.totalCents,
      trigger: "dispatch_reconcile",
      ...(relocated
        ? { relocatedFrom: currentLocation, relocatedTo: quote.square_location_id }
        : {}),
    },
  }).catch(() => {});

  return {
    action: "rebuilt",
    oldOrderId: existingId,
    newOrderId: dayof.id,
    oldTotalCents: currentTotal,
    newTotalCents: dayof.totalCents,
    ...(relocated ? { relocatedFrom: currentLocation } : {}),
  };
}

export type DayofReshapeResult =
  | {
      action: "reshaped";
      oldOrderId: string;
      newOrderId: string;
      totalCents: number;
      taxCents: number;
    }
  | { action: "skipped"; reason: string };

/**
 * Re-create an EXISTING day-of order in the tax/service-charge-correct shape, leaving the
 * amount the guest owes untouched.
 *
 * Why this is separate from reconcileDayofOrder: reconcile rebuilds when the CONTRACT has
 * moved, and no-ops when the order total already matches — which is precisely the case
 * here. The total is right; only the slots are wrong. So this is the one operation that
 * rebuilds an order whose total is already correct.
 *
 * STRICT, and deliberately unlike createDayofOrder: there is NO legacy fallback. The order
 * being replaced is already the legacy shape, so swapping it for another legacy order is
 * churn with a changed order id and nothing gained. If the taxed shape cannot be built, is
 * refused, or does not reproduce the live total AND the contract tax exactly, we cancel
 * whatever we made and leave the original order standing.
 *
 * Refuses anything not safely re-creatable: no existing order; an order that is not OPEN or
 * already carries tenders (real money); an order at a different location than the quote (a
 * center move — reconcileDayofOrder's job, and it must cancel at the OLD location); or an
 * order that already reports tax (already reshaped).
 */
export async function reshapeDayofOrder(
  quote: GroupFunctionQuote,
  baseKey: string,
  /**
   * Re-shape an order that ALREADY reports tax. Needed when the builder itself is
   * corrected and orders reshaped under the old logic must be redone (H3222: a second
   * service-charge line was left as merchandise). Every money guard below still applies —
   * `force` only waives the "already has tax, nothing to do" shortcut.
   */
  opts: { force?: boolean } = {},
): Promise<DayofReshapeResult> {
  const existingId = quote.square_dayof_order_id;
  if (!existingId) return { action: "skipped", reason: "no day-of order" };
  if (quote.square_settled_order_id)
    return { action: "skipped", reason: `settled at the POS (${quote.square_settled_order_id})` };

  /** The live order, narrowed to the fields the eligibility checks below read. */
  let live:
    | {
        state?: string;
        location_id?: string;
        tenders?: unknown[];
        total_money?: { amount?: number };
        total_tax_money?: { amount?: number };
      }
    | undefined;
  try {
    live = (
      await (await fetch(`${SQUARE_BASE}/orders/${existingId}`, { headers: sqHeaders() })).json()
    ).order;
  } catch (err) {
    return { action: "skipped", reason: `could not read order ${existingId}: ${String(err)}` };
  }
  if (!live) return { action: "skipped", reason: `order ${existingId} not readable` };
  if (live.state !== "OPEN") return { action: "skipped", reason: `order state=${live.state}` };
  const tenderCount = (live.tenders ?? []).length;
  if (tenderCount > 0) return { action: "skipped", reason: `order has ${tenderCount} tender(s)` };
  if (live.location_id !== quote.square_location_id)
    return {
      action: "skipped",
      reason: `order at ${live.location_id}, quote at ${quote.square_location_id} (center move)`,
    };
  if (!opts.force && (live.total_tax_money?.amount ?? 0) > 0)
    return { action: "skipped", reason: "order already reports tax — already reshaped" };

  const liveTotal: number = live.total_money?.amount ?? 0;
  const shape = buildDayofOrderShape({
    centerCode: quote.center_code,
    locationId: quote.square_location_id,
    products: quote.line_items as Parameters<typeof buildDayofOrderShape>[0]["products"],
    taxExempt: quote.is_tax_exempt,
  });
  if (!shape) return { action: "skipped", reason: "contract not modellable with catalog taxes" };

  const { ok, data } = await postOrder(quote, `gf-dayof-reshape-${baseKey}`, shape);
  if (!ok || !data.order?.id)
    return { action: "skipped", reason: `Square refused: ${JSON.stringify(data.errors ?? data)}` };

  const newId: string = data.order.id;
  const newTotal: number = data.order.total_money?.amount ?? 0;
  const newTax: number = data.order.total_tax_money?.amount ?? 0;

  // The guest must owe the same to the CENT — the loaded gift card was sized on it — and
  // the tax must match the contract, or this is not a pure re-slotting.
  const problem =
    newTotal !== liveTotal
      ? `new total ${newTotal} != live ${liveTotal}`
      : newTotal !== quote.total_cents
        ? `new total ${newTotal} != contract ${quote.total_cents}`
        : newTax !== quote.tax_cents
          ? `new tax ${newTax} != contract tax ${quote.tax_cents}`
          : "";
  if (problem) {
    await cancelDayofOrder(newId, quote.square_location_id).catch(() => {});
    return { action: "skipped", reason: problem };
  }

  await updateGfQuoteDetails(quote.id, { square_dayof_order_id: newId });
  await cancelDayofOrder(existingId, live.location_id).catch(() => {});
  await appendAuditLog({
    quoteId: quote.id,
    event: "dayof_order_reshaped",
    metadata: {
      oldOrderId: existingId,
      newOrderId: newId,
      totalCents: newTotal,
      taxCents: newTax,
      trigger: "tax_slot_remediation",
    },
  }).catch(() => {});

  return {
    action: "reshaped",
    oldOrderId: existingId,
    newOrderId: newId,
    totalCents: newTotal,
    taxCents: newTax,
  };
}
