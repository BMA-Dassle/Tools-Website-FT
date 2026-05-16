import { type BowlingReservation, updateBowlingReservationLaneOpen } from "@/lib/bowling-db";

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

const SQUARE_BASE = "https://connect.squareup.com/v2";
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
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN ?? ""}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/** A Square HTTP status that indicates a transient failure worth retrying. */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * fetch() wrapper with exponential backoff retry on 429 + 5xx.
 *
 * Square occasionally throws 429 (rate limit) under bursty load — e.g. when
 * many lanes go Running within the same second. The 429 window is short
 * (typically <1s), so two retries with 250ms / 750ms backoff almost always
 * succeed. If all attempts fail with a transient status, the final response
 * is returned (caller can inspect .status), and callers should mark the
 * reservation as retryable so the lane-poll cron can pick it up again later.
 *
 * POSTs to Square use idempotency keys, so retries cannot double-charge.
 */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  const delaysMs = [250, 750]; // retries 2 and 3
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt < delaysMs.length) {
        console.warn(
          `[lane-open] ${label} threw attempt ${attempt + 1}, retrying in ${delaysMs[attempt]}ms:`,
          err instanceof Error ? err.message : err,
        );
        await new Promise((r) => setTimeout(r, delaysMs[attempt]));
        continue;
      }
      throw err;
    }
    if (isTransientStatus(res.status) && attempt < delaysMs.length) {
      console.warn(
        `[lane-open] ${label} ${res.status} attempt ${attempt + 1}, retrying in ${delaysMs[attempt]}ms`,
      );
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
      continue;
    }
    return res;
  }
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
  // True when processingError was caused by a transient Square failure
  // (429/5xx/network) AFTER our in-function retries were exhausted. The
  // caller leaves dayof_order_sent_at NULL so the lane-poll cron retries.
  let retryable = false;

  const srcTag = source ?? "unknown";

  if (reservation.squareDayofOrderId) {
    // ── 1. Fetch day-of order ─────────────────────────────────────
    const tOrder = Date.now();
    const orderRes = await fetchWithRetry(
      `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
      { headers: sqHeaders(), cache: "no-store" },
      `GET order neonId=${neonId}`,
    );
    console.log(`[lane-open] neonId=${neonId} src=${srcTag} GET order ${Date.now() - tOrder}ms`);
    if (!orderRes.ok) {
      const body = (await orderRes.json().catch(() => ({}))) as { errors?: { detail: string }[] };
      const msg = body.errors?.[0]?.detail ?? `Order fetch failed (${orderRes.status})`;
      const transient = isTransientStatus(orderRes.status);
      console.error(
        `[lane-open] neonId=${neonId} order fetch failed: ${msg} (retryable=${transient})`,
      );
      await updateBowlingReservationLaneOpen(neonId, {
        laneNumbers,
        error: msg,
        source,
        retryable: transient,
      });
      return { ok: false, laneLabel, kitchenItemsUpdated: 0, error: msg };
    }
    const orderJson = (await orderRes.json()) as { order?: SquareOrder };
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
        uid: li.uid,
        note: li.note ? `${laneLabel} | ${li.note}` : laneLabel,
      }));
      let updatedOrderVersion = order.version;
      try {
        const tNotes = Date.now();
        const noteRes = await fetchWithRetry(
          `${SQUARE_BASE}/orders/${reservation.squareDayofOrderId}`,
          {
            method: "PUT",
            headers: sqHeaders(),
            body: JSON.stringify({
              order: {
                version: order.version,
                location_id: reservation.centerCode,
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
          `PUT notes neonId=${neonId}`,
        );
        if (noteRes.ok) {
          kitchenItemsUpdated = kitchenItems.length;
          const noteJson = (await noteRes.json().catch(() => ({}))) as {
            order?: { version: number };
          };
          updatedOrderVersion = noteJson.order?.version ?? order.version + 1;
        } else {
          const noteBody = (await noteRes.json().catch(() => ({}))) as {
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
          const gcRes = await fetchWithRetry(
            `${SQUARE_BASE}/gift-cards/${reservation.squareGiftCardId}`,
            { headers: sqHeaders(), cache: "no-store" },
            `GET gift-card neonId=${neonId}`,
          );
          console.log(
            `[lane-open] neonId=${neonId} src=${srcTag} GET gift-card ${Date.now() - tGc}ms`,
          );
          if (!gcRes.ok) {
            if (isTransientStatus(gcRes.status)) retryable = true;
            throw new Error(`Gift card fetch failed (${gcRes.status})`);
          }
          const gcJson = (await gcRes.json()) as {
            gift_card?: { balance_money?: { amount?: number } };
          };
          const gcBalance = gcJson.gift_card?.balance_money?.amount ?? 0;

          if (gcBalance > 0) {
            // Cap at remaining order balance to avoid overpaying
            const remaining = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
            const amountToPay = remaining > 0 ? Math.min(gcBalance, remaining) : gcBalance;

            const tPay = Date.now();
            const payRes = await fetchWithRetry(
              `${SQUARE_BASE}/payments`,
              {
                method: "POST",
                headers: sqHeaders(),
                body: JSON.stringify({
                  idempotency_key: `${idempotencyBase}-pay`,
                  source_id: reservation.squareGiftCardId,
                  amount_money: { amount: amountToPay, currency: "USD" },
                  order_id: reservation.squareDayofOrderId,
                  location_id: reservation.centerCode,
                  autocomplete: true,
                  note: `Deposit applied — ${reservation.qamfReservationId ?? `#${reservation.id}`}${laneLabel ? ` — ${laneLabel}` : ""}`,
                }),
              },
              `POST payment neonId=${neonId}`,
            );
            console.log(
              `[lane-open] neonId=${neonId} src=${srcTag} POST payment ${Date.now() - tPay}ms`,
            );
            if (payRes.ok) {
              const payJson = (await payRes.json()) as {
                payment?: { id: string; amount_money?: { amount?: number } };
              };
              paymentId = payJson.payment?.id;
              paymentCents = payJson.payment?.amount_money?.amount;
              console.log(
                `[lane-open] neonId=${neonId} gift card charged ${paymentCents}¢` +
                  ` paymentId=${paymentId} ${laneLabel}`,
              );

              // NOTE: We intentionally do NOT complete the order here.
              // Square requires all fulfillments to be COMPLETED before the
              // order can transition to COMPLETED. Completing the SHIPMENT
              // fulfillment removes it from KDS within milliseconds — before
              // staff can see shoe sizes and items. Instead we leave the order
              // OPEN (fully paid, $0 due). Loyalty accrual works on paid OPEN
              // orders. Staff complete the order on the POS when the session ends,
              // which also dismisses it from KDS at the right time.
            } else {
              const errBody = (await payRes.json().catch(() => ({}))) as {
                errors?: { code: string; detail: string }[];
              };
              const errMsg = errBody.errors?.[0]?.detail ?? `Payment failed (${payRes.status})`;
              if (isTransientStatus(payRes.status)) retryable = true;
              console.error(
                `[lane-open] neonId=${neonId} gift card payment failed: ${errMsg} (retryable=${retryable})`,
              );
              processingError = errMsg;
            }
          } else {
            console.log(`[lane-open] neonId=${neonId} gift card has no balance — skipping payment`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // fetch() throwing (network error) is also transient
          if (!(err instanceof Error && err.message.startsWith("Gift card fetch failed"))) {
            retryable = true;
          }
          console.error(
            `[lane-open] neonId=${neonId} payment threw: ${errMsg} (retryable=${retryable})`,
          );
          processingError = errMsg;
        }
      }

      // ── 3b. $0 walk-in orders: add external tender so loyalty accrual works ──
      // KBF and walk-in orders have $0 due. A $0 EXTERNAL payment marks the
      // order as "paid" so AccumulateLoyaltyPoints succeeds. We do NOT
      // complete the order — same KDS reasoning as gift-card orders above.
      if (!paymentId && !reservation.squareGiftCardId) {
        const due = order.net_amount_due_money?.amount ?? order.total_money?.amount ?? 0;
        if (due <= 0) {
          try {
            const tClose = Date.now();
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
            console.log(
              `[lane-open] neonId=${neonId} $0 external payment added ${Date.now() - tClose}ms`,
            );
          } catch (err) {
            console.warn(`[lane-open] neonId=${neonId} $0 external payment threw:`, err);
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
  // Square requires the order to be paid (net_amount_due = 0) before
  // AccumulateLoyaltyPoints succeeds. Order does NOT need to be COMPLETED.
  // Best-effort: look up loyalty account from customer_id, then accrue.
  if (reservation.squareCustomerId && reservation.squareDayofOrderId && !processingError) {
    try {
      const searchRes = await fetch(`${SQUARE_BASE}/loyalty/accounts/search`, {
        method: "POST",
        headers: sqHeaders(),
        body: JSON.stringify({ query: { customer_ids: [reservation.squareCustomerId] } }),
      });
      if (searchRes.ok) {
        const searchData = (await searchRes.json()) as {
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
            const accData = (await accRes.json()) as {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              events?: Array<{ accumulate_points?: { points?: number } }>;
            };
            const pts = (accData.events ?? []).reduce(
              (s, e) => s + (e.accumulate_points?.points ?? 0),
              0,
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
  // On a transient (retryable) error we deliberately leave dayof_order_sent_at
  // NULL so the lane-poll cron can retry. On success or permanent failure we
  // set it so we don't redo work or loop on a hopeless error.
  const tNeon = Date.now();
  const written = await updateBowlingReservationLaneOpen(neonId, {
    laneNumbers,
    paymentId,
    error: processingError,
    source,
    retryable: retryable && !!processingError,
  });
  console.log(
    `[lane-open] neonId=${neonId} src=${srcTag} Neon write ${Date.now() - tNeon}ms retryable=${retryable && !!processingError}`,
  );

  if (!written) {
    // Race: another trigger wrote first — that's fine, no action needed
    console.log(`[lane-open] neonId=${neonId} already written by concurrent trigger — skipped`);
    return { ok: true, skipped: true, laneLabel, kitchenItemsUpdated };
  }

  console.log(
    `[lane-open] neonId=${neonId} src=${srcTag} done totalMs=${Date.now() - t0}` +
      ` lane="${laneLabel}" kitchen=${kitchenItemsUpdated}` +
      ` paymentId=${paymentId ?? "none"} error=${processingError ?? "none"}` +
      ` retryable=${retryable && !!processingError}`,
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
