import {
  getCheckedInOrdersToComplete,
  markDayofOrderCompleted,
  type BowlingReservation,
} from "@/lib/bowling-db";

/**
 * End-of-session Square-order completion for CHECKED-IN bowling/KBF reservations.
 *
 * Lane-open (lib/bowling-lane-open.ts) intentionally leaves the day-of order OPEN
 * — fully paid, $0 due — with its SHIPMENT fulfillment, so the kitchen/KDS keeps
 * showing shoe sizes + food during the session. Square reporting and the
 * Square→QuickBooks sync only pull COMPLETED sales, so an order left OPEN never
 * imports into QuickBooks (see
 * docs/postmortems/2026-06-16-bowling-day-of-orders-left-open.md).
 *
 * Once the session is well over (3h buffer, enforced in
 * getCheckedInOrdersToComplete), finish the lifecycle: complete the open
 * fulfillment (KDS no longer needs it), then set the order COMPLETED. No money
 * moves — the order was paid at lane-open; only the order state changes.
 *
 * Runs inside the reservation-status-close cron, right after it flips past
 * sessions to status='completed'. Pairs with bowling-no-show-close, the fallback
 * for never-checked-in no-shows (checkin_method IS NULL) which charges the
 * forfeited deposit and completes WITHOUT a fulfillment. This path only touches
 * showed-up, already-paid orders. Idempotent via dayof_order_completed_at.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";
const CONCURRENCY = 5;

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

type Order = {
  id: string;
  state: string;
  version: number;
  location_id: string;
  total_money?: { amount?: number };
  net_amount_due_money?: { amount?: number };
  fulfillments?: { uid: string; state?: string }[];
};

async function getOrder(orderId: string): Promise<Order | null> {
  const res = await fetch(`${SQUARE_BASE}/orders/${orderId}`, { headers: sqHeaders() });
  if (!res.ok) return null;
  return (await res.json().catch(() => ({}))).order ?? null;
}

type Outcome =
  | { kind: "completed"; cents: number }
  | { kind: "already"; note: string }
  | { kind: "skipped"; note: string }
  | { kind: "failed"; note: string };

/**
 * Complete a checked-in, paid, OPEN order: finish its open fulfillment(s) first
 * (Square blocks OPEN→COMPLETED while a fulfillment is non-terminal), then set
 * the order COMPLETED. Re-fetches version between writes to avoid conflicts.
 */
async function completeOrder(orderId: string): Promise<Outcome> {
  const order = await getOrder(orderId);
  if (!order) return { kind: "failed", note: "order fetch failed" };
  if (order.state === "COMPLETED") return { kind: "already", note: "already COMPLETED" };
  if (order.state === "CANCELED") return { kind: "already", note: "CANCELED" };
  if (order.state !== "OPEN") return { kind: "skipped", note: `state ${order.state}` };

  const total = order.total_money?.amount ?? 0;
  const due = order.net_amount_due_money?.amount ?? 0;
  // Checked-in orders are paid at lane-open. A balance still due means something
  // is off (failed gift-card charge) — leave it OPEN and unmarked so it surfaces
  // / retries rather than being silently completed.
  if (due > 0) return { kind: "skipped", note: `balance due $${(due / 100).toFixed(2)}` };

  // 1. Complete any non-terminal fulfillments (KDS no longer needs them).
  const openFuls = (order.fulfillments ?? []).filter(
    (f) => f.state && f.state !== "COMPLETED" && f.state !== "CANCELED",
  );
  if (openFuls.length) {
    const r1 = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
      method: "PUT",
      headers: sqHeaders(),
      body: JSON.stringify({
        order: {
          location_id: order.location_id,
          version: order.version,
          fulfillments: openFuls.map((f) => ({ uid: f.uid, state: "COMPLETED" })),
        },
      }),
    });
    if (!r1.ok) {
      const e = await r1.json().catch(() => ({}));
      return { kind: "failed", note: `fulfillment: ${e.errors?.[0]?.detail ?? r1.status}` };
    }
  }

  // 2. Complete the order (re-fetch version after the fulfillment write).
  const fresh = await getOrder(orderId);
  if (!fresh) return { kind: "failed", note: "re-fetch failed" };
  if (fresh.state === "COMPLETED") return { kind: "completed", cents: total };
  const r2 = await fetch(`${SQUARE_BASE}/orders/${orderId}`, {
    method: "PUT",
    headers: sqHeaders(),
    body: JSON.stringify({
      order: { location_id: fresh.location_id, version: fresh.version, state: "COMPLETED" },
    }),
  });
  if (!r2.ok) {
    const e = await r2.json().catch(() => ({}));
    return { kind: "failed", note: `complete: ${e.errors?.[0]?.detail ?? r2.status}` };
  }
  return { kind: "completed", cents: total };
}

function orderIdOf(r: BowlingReservation): string | null {
  const raw = r.squareDayofOrderId;
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length) return String(p[0]);
  } catch {
    /* bare id */
  }
  return raw;
}

/**
 * Complete the day-of Square order for ONE reservation. The primary trigger —
 * called from the QAMF lane lifecycle the moment a session is reported Completed
 * (lanes closed), so the order closes in real time, in a SEPARATE call from
 * lane-open. By the Completed transition the order is final (no changes are made
 * after the lane is open) and fully paid, so it's safe to complete + drop the
 * KDS ticket. Stamps dayof_order_completed_at on success / already-terminal so
 * the reservation-status-close backstop cron skips it. Skips combos and
 * non-bowling kinds (races complete on payment via race-dayof-pay). Idempotent
 * and non-throwing-by-contract for callers that want fire-and-forget.
 */
export async function completeReservationOrder(r: BowlingReservation): Promise<Outcome> {
  if (r.comboSpecialId) return { kind: "skipped", note: "combo (own settle flow)" };
  if (r.productKind !== "open" && r.productKind !== "kbf")
    return { kind: "skipped", note: `kind ${r.productKind}` };
  const orderId = orderIdOf(r);
  if (!orderId) return { kind: "skipped", note: "no order id" };
  const res = await completeOrder(orderId);
  if (res.kind === "completed" || res.kind === "already") {
    await markDayofOrderCompleted(r.id);
  }
  return res;
}

export type CompleteOrdersResult = {
  candidates: number;
  completed: number;
  completedCents: number;
  already: number;
  skipped: number;
  failed: number;
  details: string[];
};

export async function completeCheckedInOrders(
  opts: { dryRun?: boolean } = {},
): Promise<CompleteOrdersResult> {
  const candidates = await getCheckedInOrdersToComplete();
  const out: CompleteOrdersResult = {
    candidates: candidates.length,
    completed: 0,
    completedCents: 0,
    already: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const r = candidates[idx++];
      const label = `${r.guestName ?? "?"} (neon ${r.id}, ${r.productKind})`;
      if (opts.dryRun) {
        out.details.push(`WOULD complete ${label} — order ${orderIdOf(r) ?? "none"}`);
        continue;
      }
      try {
        const res = await completeReservationOrder(r);
        switch (res.kind) {
          case "completed":
            out.completed++;
            out.completedCents += res.cents;
            out.details.push(`${label}: COMPLETED $${(res.cents / 100).toFixed(2)}`);
            break;
          case "already":
            // Terminal already (e.g. staff closed it on the POS) — marked so it
            // drops out of future runs.
            out.already++;
            out.details.push(`${label}: ${res.note} (marked)`);
            break;
          case "skipped":
            // Leave unmarked — re-evaluate next run.
            out.skipped++;
            out.details.push(`SKIP ${label}: ${res.note}`);
            break;
          case "failed":
            out.failed++;
            out.details.push(`ERROR ${label}: ${res.note}`);
            break;
        }
      } catch (err) {
        out.failed++;
        out.details.push(
          `ERROR ${label}: ${err instanceof Error ? err.message : "complete error"}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length || 1) }, worker));
  return out;
}
