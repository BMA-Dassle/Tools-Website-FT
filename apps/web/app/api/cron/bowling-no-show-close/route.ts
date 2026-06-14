import { NextRequest, NextResponse } from "next/server";
import {
  getNoShowBowlingReservations,
  updateBowlingReservationLaneOpen,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/bowling-no-show-close
 *
 * End-of-night close for NO-SHOW bowling/KBF reservations. A no-show is a
 * past-slot reservation that was never checked in (status still 'confirmed',
 * no checkin_method) with an open day-of order — the guest prepaid (deposit =
 * full day-of total, sitting on the gift card) but never showed.
 *
 * For each we apply the gift card to the day-of order and COMPLETE it —
 * collecting the forfeited deposit — but WITHOUT adding a SHIPMENT fulfillment.
 * The fulfillment is what routes a bowling order to the kitchen KDS (see
 * lib/bowling-lane-open.ts processLaneOpen step 2); omitting it means NO food
 * fires for the no-show. That's the whole reason bowling is normally
 * check-in-gated — this path is the safe exception (owner decision 2026-06-13).
 *
 * $0 / free (KBF) orders have nothing to charge — we just COMPLETE them so they
 * stop showing "Pending". Combo legs are excluded (own settle flow). Idempotent
 * (idempotency_key + dayof_order_sent_at guard) — never double-charges.
 *
 * ?dryRun=1 — report what WOULD close, no Square writes.
 *
 * Scheduled ~3 AM ET (08:00 UTC) in vercel.json — well after every center has
 * closed, so the 2-hour DB buffer plus that timing means no in-progress session
 * is ever closed. Also runnable on demand for the past-backlog with ?token=.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** Complete an open order WITHOUT adding a fulfillment (no KDS / kitchen). */
async function completeOrderNoFulfillment(
  orderId: string,
  locationId: string,
  version: number,
): Promise<void> {
  await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    method: "PUT",
    headers: sqHeaders(),
    body: JSON.stringify({ order: { location_id: locationId, version, state: "COMPLETED" } }),
  });
}

/**
 * Settle a no-show: gift card → day-of order + COMPLETE, NO fulfillment.
 * Mirrors race-dayof-pay's chargeDayof (which also adds no fulfillment) but with
 * a no-show idempotency key. $0 orders are just completed.
 */
async function closeNoShow(
  r: BowlingReservation,
): Promise<{ closed: boolean; charged: number; paymentId?: string; note: string }> {
  const orderId = r.squareDayofOrderId!;
  const orderRes = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
  if (!orderRes.ok) return { closed: false, charged: 0, note: `order fetch ${orderRes.status}` };
  const order = (await orderRes.json()).order;
  if (!order) return { closed: false, charged: 0, note: "order not found" };
  const locationId: string = order.location_id;

  if (order.state === "COMPLETED") return { closed: true, charged: 0, note: "already COMPLETED" };

  const remaining: number = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
  if (remaining <= 0) {
    // Free/$0 (e.g. KBF): nothing to collect — just close it.
    if (order.version) await completeOrderNoFulfillment(orderId, locationId, order.version);
    return { closed: true, charged: 0, note: "order $0 — completed" };
  }

  const gcId = r.squareGiftCardId;
  if (!gcId) return { closed: false, charged: 0, note: "balance due but no gift card" };
  const gcRes = await fetch(`${SQUARE_BASE}/gift-cards/${gcId}`, { headers: sqHeaders() });
  if (!gcRes.ok) return { closed: false, charged: 0, note: `gift card fetch ${gcRes.status}` };
  const gcBalance: number = (await gcRes.json()).gift_card?.balance_money?.amount ?? 0;
  if (gcBalance <= 0) return { closed: false, charged: 0, note: "gift card $0 balance" };

  const amountToPay = Math.min(gcBalance, remaining);
  const payRes = await fetch(`${SQUARE_BASE}/payments`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({
      idempotency_key: `no-show-close-${r.id}`,
      source_id: gcId,
      amount_money: { amount: amountToPay, currency: "USD" },
      order_id: orderId,
      location_id: locationId,
      autocomplete: true,
      note: `no-show close ${r.productKind} (neon ${r.id})`,
    }),
  });
  if (!payRes.ok) {
    const e = await payRes.json().catch(() => ({}));
    return {
      closed: false,
      charged: 0,
      note: `payment failed: ${e.errors?.[0]?.detail || payRes.status}`,
    };
  }
  const payData = await payRes.json();
  const paymentId: string | undefined = payData.payment?.id;
  const paidAmount: number = payData.payment?.amount_money?.amount ?? amountToPay;

  // Complete the order (no fulfillment) once fully paid.
  if (paidAmount >= remaining) {
    try {
      const fresh = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
      const version = fresh.ok ? (await fresh.json()).order?.version : null;
      if (version) await completeOrderNoFulfillment(orderId, locationId, version);
    } catch {
      /* non-fatal — payment captured; order stays open, harmless */
    }
  }
  return {
    closed: true,
    charged: paidAmount,
    paymentId,
    note: `collected $${(paidAmount / 100).toFixed(2)}`,
  };
}

export async function GET(req: NextRequest) {
  const manualToken = req.nextUrl.searchParams.get("token");
  const isManual =
    !!process.env.ADMIN_CAMERA_TOKEN && manualToken === process.env.ADMIN_CAMERA_TOKEN;
  if (!isManual) {
    const blocked = verifyCron(req);
    if (blocked) return blocked;
  }
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const candidates = await getNoShowBowlingReservations();
  let closed = 0;
  let chargedCents = 0;
  const details: string[] = [];

  for (const r of candidates) {
    const label = `${r.guestName ?? "?"} (neon ${r.id}, ${r.productKind})`;
    if (dryRun) {
      details.push(`WOULD close ${label} — total $${((r.totalCents ?? 0) / 100).toFixed(2)}`);
      continue;
    }
    try {
      const res = await closeNoShow(r);
      if (res.closed) {
        await updateBowlingReservationLaneOpen(r.id, {
          laneNumbers: [],
          paymentId: res.paymentId,
          source: "no-show",
        });
        closed += 1;
        chargedCents += res.charged;
        details.push(`${label}: ${res.note}`);
      } else {
        details.push(`SKIP ${label}: ${res.note}`);
      }
    } catch (err) {
      details.push(`ERROR ${label}: ${err instanceof Error ? err.message : "close error"}`);
    }
  }

  console.log(
    `[bowling-no-show-close] dryRun=${dryRun} candidates=${candidates.length} closed=${closed} collected=$${(chargedCents / 100).toFixed(2)}`,
  );
  return NextResponse.json({
    ok: true,
    dryRun,
    candidates: candidates.length,
    closed,
    collectedDollars: +(chargedCents / 100).toFixed(2),
    details,
  });
}
