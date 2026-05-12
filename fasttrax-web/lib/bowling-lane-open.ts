import {
  type BowlingReservation,
  updateBowlingReservationLaneOpen,
} from "@/lib/bowling-db";

/**
 * Lane-open processor for bowling reservations.
 *
 * Called when QAMF signals a reservation has gone Running (lanes started).
 * Two triggers:
 *   1. QAMF webhook handler (inline) — processes `reservation.updated` with
 *      Data.Status="Arrived" or Lanes[].Status="Running" instantly
 *   2. bowling-lane-poll cron — polls listLanes() every minute as fallback
 *
 * Steps per reservation:
 *  1. Guard: cancelled or already processed → skip
 *  2. Fetch the open day-of Square order
 *  3. Add SHIPMENT fulfillment (display_name = laneLabel) so the KDS
 *     routes the order to kitchen staff, AND prepend "Lane N |" to
 *     kitchen display item notes (Chips & Salsa, Pizza Bowl Pizza,
 *     Pizza Bowl Soda Pitcher) via sparse UpdateOrder
 *  4. Apply the eGift card balance to the day-of order via POST /v2/payments
 *  5. Write result to Neon (idempotent — conditional on dayof_order_sent_at IS NULL)
 *
 * Idempotency: both triggers use the same idempotencyBase (`lane-open-{neonId}`)
 * so Square calls and Neon updates are safe to call concurrently.
 */

const SQUARE_BASE    = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

// Square catalog object IDs for items shown on the kitchen display system.
// These must have their notes updated with the actual lane number so KDS
// staff know which lane to deliver to.
const KITCHEN_CATALOG_IDS = new Set([
  "LHZXWYO72N5QFX4CGYKRVPZX", // VIP Chips & Salsa
  "2IKZB4O2HQBXWMTSUQ2SEKJY", // Pizza Bowl Pizza ($0 sub-item)
  "SJUBJLB4QGHIHCW5AKTTMLH7", // Pizza Bowl Soda Pitcher ($0 sub-item)
]);

// Fallback: match by name when catalog_object_id is absent
const KITCHEN_NAME_RE = /pizza\s+bowl\s+pizza|pizza\s+bowl\s+soda|chips.+salsa/i;

// ── Types ──────────────────────────────────────────────────────────

interface SquareLineItem {
  uid: string;
  name?: string;
  note?: string;
  catalog_object_id?: string;
  quantity: string;
}

interface SquareOrder {
  id: string;
  version: number;
  location_id: string;
  state: string;
  line_items?: SquareLineItem[];
  net_amount_due_money?: { amount: number; currency: string };
  total_money?: { amount: number; currency: string };
}

export interface LaneOpenResult {
  ok: boolean;
  /** True when the reservation was already processed or is cancelled. */
  skipped?: boolean;
  /** Human-readable lane label, e.g. "Lane 12" or "Lanes 12, 13". */
  laneLabel: string;
  /** Number of kitchen display items whose notes were updated. */
  kitchenItemsUpdated: number;
  /** Square payment ID for the gift card charge, if applied. */
  paymentId?: string;
  /** Amount charged to the gift card (cents). */
  paymentCents?: number;
  /** Non-fatal error description, if any step partially failed. */
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function sqHeaders(): Record<string, string> {
  return {
    Authorization:    `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
    "Content-Type":   "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

function buildLaneLabel(laneNumbers: number[]): string {
  if (laneNumbers.length === 0) return "";
  if (laneNumbers.length === 1) return `Lane ${laneNumbers[0]}`;
  return `Lanes ${laneNumbers.join(", ")}`;
}

function isKitchenItem(item: SquareLineItem): boolean {
  if (item.catalog_object_id && KITCHEN_CATALOG_IDS.has(item.catalog_object_id)) return true;
  return KITCHEN_NAME_RE.test(item.name ?? "");
}

// ── Core function ──────────────────────────────────────────────────

export async function processLaneOpen(opts: {
  reservation: BowlingReservation;
  laneNumbers: number[];
  /**
   * Stable idempotency base for this reservation, e.g. "lane-open-42".
   * Appended with "-notes" and "-pay" for individual Square calls so both
   * the webhook consumer and polling cron produce identical keys.
   */
  idempotencyBase: string;
  /** How this was triggered: "webhook" (events-consumer) or "cron" (lane-poll). */
  source?: "webhook" | "cron";
}): Promise<LaneOpenResult> {
  const { reservation, laneNumbers, idempotencyBase, source } = opts;
  const t0 = Date.now();
  const laneLabel = buildLaneLabel(laneNumbers);

  // ── Guard ─────────────────────────────────────────────────────────
  if (reservation.status === "cancelled" || reservation.dayofOrderSentAt) {
    return { ok: true, skipped: true, laneLabel, kitchenItemsUpdated: 0 };
  }

  const neonId = reservation.id;
  let kitchenItemsUpdated = 0;
  let paymentId: string | undefined;
  let paymentCents: number | undefined;
  let processingError: string | undefined;

  const srcTag = source ?? "unknown";

  if (reservation.squareDayofOrderId) {
    // ── 1. Fetch day-of order ─────────────────────────────────────
    const tOrder = Date.now();
    const orderRes = await fetch(
      `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
      { headers: sqHeaders(), cache: "no-store" },
    );
    console.log(`[lane-open] neonId=${neonId} src=${srcTag} GET order ${Date.now() - tOrder}ms`);
    if (!orderRes.ok) {
      const body = await orderRes.json().catch(() => ({})) as { errors?: { detail: string }[] };
      const msg = body.errors?.[0]?.detail ?? `Order fetch failed (${orderRes.status})`;
      console.error(`[lane-open] neonId=${neonId} order fetch failed: ${msg}`);
      await updateBowlingReservationLaneOpen(neonId, { laneNumbers, error: msg, source });
      return { ok: false, laneLabel, kitchenItemsUpdated: 0, error: msg };
    }
    const orderJson = await orderRes.json() as { order?: SquareOrder };
    const order = orderJson.order;
    if (!order) {
      const msg = "Day-of order missing in Square response";
      await updateBowlingReservationLaneOpen(neonId, { laneNumbers, error: msg });
      return { ok: false, laneLabel, kitchenItemsUpdated: 0, error: msg };
    }

    // If order is already terminal, skip Square steps but still record in Neon
    const terminal = order.state === "CANCELED" || order.state === "COMPLETED";
    if (!terminal && laneLabel) {
      // ── 2. Add SHIPMENT fulfillment + update kitchen item notes ───
      // The SHIPMENT fulfillment (display_name = lane label) is what routes
      // the order to the KDS so kitchen staff see it. Line item notes are
      // updated concurrently so staff see the lane on each item.
      // Square adds new fulfillments (no uid provided) without removing
      // existing ones — no fields_to_clear required.
      const kitchenItems = (order.line_items ?? []).filter(isKitchenItem);
      const updatedItems = kitchenItems.map((li) => ({
        uid:  li.uid,
        note: li.note ? `${laneLabel} | ${li.note}` : laneLabel,
      }));
      let updatedOrderVersion = order.version;
      try {
        const tNotes = Date.now();
        const noteRes = await fetch(
          `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
          {
            method:  "PUT",
            headers: sqHeaders(),
            body:    JSON.stringify({
              order: {
                version:      order.version,
                location_id:  reservation.centerCode,
                // SHIPMENT fulfillment → KDS routing
                fulfillments: [
                  {
                    type: "SHIPMENT",
                    shipment_details: {
                      recipient: { display_name: laneLabel },
                    },
                  },
                ],
                // Sparse note update — only present when there are kitchen items
                ...(updatedItems.length > 0 ? { line_items: updatedItems } : {}),
              },
              idempotency_key: `${idempotencyBase}-notes`,
            }),
          },
        );
        console.log(`[lane-open] neonId=${neonId} src=${srcTag} PUT notes ${Date.now() - tNotes}ms`);
        if (noteRes.ok) {
          kitchenItemsUpdated = kitchenItems.length;
          const noteJson = await noteRes.json().catch(() => ({})) as { order?: { version: number } };
          updatedOrderVersion = noteJson.order?.version ?? order.version + 1;
        } else {
          const noteBody = await noteRes.json().catch(() => ({})) as {
            errors?: { detail: string }[];
          };
          console.warn(
            `[lane-open] neonId=${neonId} fulfillment/notes update failed:`,
            noteBody.errors?.[0]?.detail ?? noteRes.status,
          );
        }
      } catch (err) {
        console.warn(`[lane-open] neonId=${neonId} fulfillment/notes update threw:`, err);
      }

      // ── 3. Apply gift card to day-of order ────────────────────
      // Square /v2/payments requires the gift card ID (gftc:...) as source_id,
      // NOT the raw GAN. The GAN returns BAD_REQUEST "Invalid source_id".
      if (reservation.squareGiftCardId) {
        try {
          // Get authoritative gift card balance
          const tGc = Date.now();
          const gcRes = await fetch(
            `${SQUARE_BASE}/gift-cards/${reservation.squareGiftCardId}`,
            { headers: sqHeaders(), cache: "no-store" },
          );
          console.log(`[lane-open] neonId=${neonId} src=${srcTag} GET gift-card ${Date.now() - tGc}ms`);
          if (!gcRes.ok) throw new Error(`Gift card fetch failed (${gcRes.status})`);
          const gcJson = await gcRes.json() as {
            gift_card?: { balance_money?: { amount?: number } };
          };
          const gcBalance = gcJson.gift_card?.balance_money?.amount ?? 0;

          if (gcBalance > 0) {
            // Cap at remaining order balance to avoid overpaying
            const remaining = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
            const amountToPay = remaining > 0 ? Math.min(gcBalance, remaining) : gcBalance;

            const tPay = Date.now();
            const payRes = await fetch(`${SQUARE_BASE}/payments`, {
              method:  "POST",
              headers: sqHeaders(),
              body:    JSON.stringify({
                idempotency_key: `${idempotencyBase}-pay`,
                source_id:       reservation.squareGiftCardId,
                amount_money:    { amount: amountToPay, currency: "USD" },
                order_id:        reservation.squareDayofOrderId,
                location_id:     reservation.centerCode,
                autocomplete:    true,
                note:            `Deposit applied — ${reservation.qamfReservationId ?? `#${reservation.id}`}${laneLabel ? ` — ${laneLabel}` : ""}`,
              }),
            });
            console.log(`[lane-open] neonId=${neonId} src=${srcTag} POST payment ${Date.now() - tPay}ms`);
            if (payRes.ok) {
              const payJson = await payRes.json() as {
                payment?: { id: string; amount_money?: { amount?: number } };
              };
              paymentId    = payJson.payment?.id;
              paymentCents = payJson.payment?.amount_money?.amount;
              console.log(
                `[lane-open] neonId=${neonId} gift card charged ${paymentCents}¢` +
                ` paymentId=${paymentId} ${laneLabel}`,
              );

              // Gift card payments don't auto-complete the order.
              // If the order is now fully paid, close it explicitly.
              try {
                const refetchRes = await fetch(
                  `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
                  { headers: sqHeaders(), cache: "no-store" },
                );
                const refetchJson = await refetchRes.json() as {
                  order?: SquareOrder & { fulfillments?: { uid: string; type: string }[] };
                };
                const freshOrder = refetchJson.order;
                const due = freshOrder?.net_amount_due_money?.amount ?? freshOrder?.total_money?.amount ?? 1;
                if (freshOrder && due <= 0 && freshOrder.state !== "COMPLETED") {
                  const ffUpdates = (freshOrder.fulfillments ?? []).map((ff) => ({
                    uid: ff.uid, type: ff.type, state: "COMPLETED",
                  }));
                  const completeRes = await fetch(
                    `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
                    {
                      method: "PUT",
                      headers: sqHeaders(),
                      body: JSON.stringify({
                        order: {
                          version: freshOrder.version,
                          location_id: reservation.centerCode,
                          fulfillments: ffUpdates,
                          state: "COMPLETED",
                        },
                      }),
                    },
                  );
                  if (completeRes.ok) {
                    console.log(`[lane-open] neonId=${neonId} order completed (fully paid by gift card)`);
                  } else {
                    const errBody = await completeRes.json().catch(() => ({})) as { errors?: { detail: string }[] };
                    console.warn(`[lane-open] neonId=${neonId} complete order failed:`, errBody.errors?.[0]?.detail ?? completeRes.status);
                  }
                }
              } catch (closeErr) {
                console.warn(`[lane-open] neonId=${neonId} order close after GC threw:`, closeErr);
              }
            } else {
              const errBody = await payRes.json().catch(() => ({})) as {
                errors?: { code: string; detail: string }[];
              };
              const errMsg =
                errBody.errors?.[0]?.detail ?? `Payment failed (${payRes.status})`;
              console.error(`[lane-open] neonId=${neonId} gift card payment failed: ${errMsg}`);
              processingError = errMsg;
            }
          } else {
            console.log(`[lane-open] neonId=${neonId} gift card has no balance — skipping payment`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[lane-open] neonId=${neonId} payment threw: ${errMsg}`);
          processingError = errMsg;
        }
      }

      // ── 3b. Close $0 walkin orders for KDS visibility ─────────
      // Square won't auto-transition $0 orders to COMPLETED via PayOrder.
      // Instead: create a $0 EXTERNAL payment (adds a tender), then
      // UpdateOrder to set fulfillment + order state to COMPLETED.
      if (!paymentId && !reservation.squareGiftCardId) {
        const due = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
        if (due <= 0) {
          try {
            const tClose = Date.now();

            // 1. $0 external payment → creates a tender on the order
            await fetch(`${SQUARE_BASE}/payments`, {
              method: "POST",
              headers: sqHeaders(),
              body: JSON.stringify({
                idempotency_key: `${idempotencyBase}-close`,
                source_id: "EXTERNAL",
                amount_money: { amount: 0, currency: "USD" },
                order_id: reservation.squareDayofOrderId,
                location_id: reservation.centerCode,
                external_details: { type: "OTHER", source: "Walk-in bowling" },
                autocomplete: true,
              }),
            });

            // 2. Re-fetch order for current version + fulfillment uid
            const refetchRes = await fetch(
              `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
              { headers: sqHeaders(), cache: "no-store" },
            );
            const refetchJson = await refetchRes.json() as { order?: SquareOrder & { fulfillments?: { uid: string; type: string }[] } };
            const freshOrder = refetchJson.order;

            if (freshOrder && freshOrder.state !== "COMPLETED") {
              // 3. Complete fulfillment + order state
              const ffUpdates = (freshOrder.fulfillments ?? []).map((ff) => ({
                uid: ff.uid,
                type: ff.type,
                state: "COMPLETED",
              }));
              const completeRes = await fetch(
                `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
                {
                  method: "PUT",
                  headers: sqHeaders(),
                  body: JSON.stringify({
                    order: {
                      version: freshOrder.version,
                      location_id: reservation.centerCode,
                      fulfillments: ffUpdates,
                      state: "COMPLETED",
                    },
                  }),
                },
              );
              if (completeRes.ok) {
                console.log(`[lane-open] neonId=${neonId} closed $0 walkin order for KDS ${Date.now() - tClose}ms`);
              } else {
                const errBody = await completeRes.json().catch(() => ({})) as { errors?: { detail: string }[] };
                console.warn(`[lane-open] neonId=${neonId} complete order failed:`, errBody.errors?.[0]?.detail ?? completeRes.status);
              }
            } else {
              console.log(`[lane-open] neonId=${neonId} order already COMPLETED`);
            }
          } catch (err) {
            console.warn(`[lane-open] neonId=${neonId} close $0 order threw:`, err);
          }
        }
      }
    } else if (terminal) {
      console.log(
        `[lane-open] neonId=${neonId} day-of order already ${order.state} — skipping Square steps`,
      );
    }
  }

  // ── 3c. Accrue loyalty points ─────────────────────────────────────
  // Square requires the order to be paid/completed before AccumulateLoyaltyPoints
  // succeeds, so this runs after the gift card / $0-close step.
  // Best-effort: look up loyalty account from customer_id, then accrue.
  if (reservation.squareCustomerId && reservation.squareDayofOrderId && !processingError) {
    try {
      const searchRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/search`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({ query: { customer_ids: [reservation.squareCustomerId] } }),
      });
      if (searchRes.ok) {
        const searchData = await searchRes.json() as {
          loyalty_accounts?: { id: string }[];
        };
        const loyaltyAccountId = searchData.loyalty_accounts?.[0]?.id;
        if (loyaltyAccountId) {
          const accRes = await fetch(
            `${SQUARE_BASE}/loyalty/accounts/${loyaltyAccountId}/accumulate`,
            {
              method: "POST",
              headers: sqHeaders(),
              body: JSON.stringify({
                accumulate_points: { order_id: reservation.squareDayofOrderId },
                location_id: reservation.centerCode,
                idempotency_key: `${idempotencyBase}-loyalty`,
              }),
            },
          );
          if (accRes.ok) {
            const accData = await accRes.json() as {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              events?: Array<{ accumulate_points?: { points?: number } }>;
            };
            const pts = (accData.events ?? []).reduce(
              (s, e) => s + (e.accumulate_points?.points ?? 0), 0,
            );
            console.log(`[lane-open] neonId=${neonId} loyalty accrued ${pts} pts`);
          } else {
            // Non-fatal — order might not be fully paid yet (partial deposit)
            const accErr = await accRes.json().catch(() => ({}));
            console.log(
              `[lane-open] neonId=${neonId} loyalty accumulate skipped (order may not be fully paid):`,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (accErr as any).errors?.[0]?.detail ?? accRes.status,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[lane-open] neonId=${neonId} loyalty accrual error:`, err);
    }
  }

  // ── 4. Write to Neon ──────────────────────────────────────────────
  const tNeon = Date.now();
  const written = await updateBowlingReservationLaneOpen(neonId, {
    laneNumbers,
    paymentId,
    error: processingError,
    source,
  });
  console.log(`[lane-open] neonId=${neonId} src=${srcTag} Neon write ${Date.now() - tNeon}ms`);

  if (!written) {
    // Race: another trigger wrote first — that's fine, no action needed
    console.log(`[lane-open] neonId=${neonId} already written by concurrent trigger — skipped`);
    return { ok: true, skipped: true, laneLabel, kitchenItemsUpdated };
  }

  console.log(
    `[lane-open] neonId=${neonId} src=${srcTag} done totalMs=${Date.now() - t0}` +
    ` lane="${laneLabel}" kitchen=${kitchenItemsUpdated}` +
    ` paymentId=${paymentId ?? "none"} error=${processingError ?? "none"}`,
  );

  return {
    ok: true,
    laneLabel,
    kitchenItemsUpdated,
    paymentId,
    paymentCents,
    error: processingError,
  };
}
