import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import {
  getBowlingReservationByQamfId,
  updateBowlingReservationStatus,
  updateBowlingReservationCancelled,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";
import { getReservation } from "@/lib/qamf-bowling";
import { processLaneOpen } from "@/lib/bowling-lane-open";

/**
 * GET /api/cron/bowling-events-consumer
 *
 * Drains the QAMF bowling webhook queue (qamf:bowling:events:queue) and
 * processes each event against Neon + Square.
 *
 * Runs every 2 minutes (see vercel.json).
 *
 * Event types handled:
 *
 *   reservation.updated  — maps QAMF status → Neon status:
 *     Confirmed  → confirmed
 *     Arrived    → arrived
 *     Ready      → confirmed  (lane ready, not yet started)
 *     Running    → arrived    (game in progress)
 *     Completed  → completed
 *     Canceled   → cancelled  + Square refund (same as customer cancel, no time window)
 *
 *   reservation.deleted  — treat as cancellation + Square refund
 *
 *   reservation.created  — logged, no Neon action (we create the row ourselves)
 *   lanes.updated        — ignored
 *
 * Only reservations whose QAMF ID starts with "X" are processed.
 * Others are logged and skipped (QAMF may send events for non-web reservations).
 *
 * Idempotency: the webhook receiver deduplicates on webhook-id (Redis, 3d TTL)
 * so this consumer won't see the same event twice in normal operation.
 */

const QUEUE_KEY = "qamf:bowling:events:queue";
const BATCH_SIZE = 50;

// QAMF status → Neon status mapping
const QAMF_STATUS_MAP: Record<string, BowlingReservation["status"] | "cancel"> = {
  Confirmed:  "confirmed",
  Arrived:    "arrived",
  Ready:      "confirmed",   // lane ready, treat as confirmed
  Running:    "arrived",     // game running
  Completed:  "completed",
  Canceled:   "cancel",      // triggers refund flow
  Cancelled:  "cancel",      // alternate spelling
};

interface QamfWebhookEntry {
  webhookId: string;
  eventType: string;
  centerId: number | null;
  receivedAt: string;
  raw: {
    Type?: string;
    CenterId?: number;
    Data?: {
      Id?: string;
      Status?: string;
      [key: string]: unknown;
    };
  };
}

const results = {
  processed:  0,
  updated:    0,
  cancelled:  0,
  refunded:   0,
  skipped:    0,
  errors:     0,
  unknown:    0,
};

async function handleCancellation(
  reservation: BowlingReservation & { lines: unknown[] },
  webhookId: string,
): Promise<void> {
  // Skip if already cancelled
  if (reservation.status === "cancelled") {
    console.log(`[bowling-events] neonId=${reservation.id} already cancelled — skip`);
    return;
  }

  // Square refund — only if a deposit was charged and a gift card exists
  let squareRefundId: string | undefined;
  let refundCents = 0;

  if (reservation.squareDepositPaymentId && reservation.squareGiftCardId) {
    try {
      // Use webhookId as part of idempotency key so retries don't double-refund
      const idempotencyKey = `qamf-cancel-${webhookId}`;
      const result = await processSquareBowlingRefund({
        depositPaymentId: reservation.squareDepositPaymentId,
        giftCardId:       reservation.squareGiftCardId,
        dayofOrderId:     reservation.squareDayofOrderId,
        locationId:       reservation.centerCode,
        idempotencyKey,
      });
      squareRefundId = result.refundId;
      refundCents    = result.refundedCents;
      results.refunded++;
      console.log(
        `[bowling-events] neonId=${reservation.id} refunded ${refundCents}¢` +
        ` refundId=${result.refundId}`,
      );
    } catch (err) {
      // Log but still mark cancelled in Neon — staff can manually refund
      console.error(
        `[bowling-events] neonId=${reservation.id} refund failed:`,
        err instanceof Error ? err.message : err,
      );
      results.errors++;
    }
  } else {
    console.log(
      `[bowling-events] neonId=${reservation.id} no deposit on file — marking cancelled without refund`,
    );
  }

  await updateBowlingReservationCancelled(reservation.id, { squareRefundId, refundCents });
  results.cancelled++;
  console.log(`[bowling-events] neonId=${reservation.id} marked cancelled`);
}

export async function GET(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();

  // Reset counters
  results.processed = results.updated = results.cancelled =
    results.refunded = results.skipped = results.errors = results.unknown = 0;

  try {
    // Drain up to BATCH_SIZE events from the RIGHT end (oldest-first FIFO)
    const raw = await redis.lrange(QUEUE_KEY, -BATCH_SIZE, -1);
    if (raw.length === 0) {
      return NextResponse.json({ ok: true, dryRun, elapsedMs: Date.now() - started, ...results });
    }

    if (!dryRun) {
      // Remove the entries we just read
      await redis.ltrim(QUEUE_KEY, 0, -(raw.length + 1));
    }

    for (const entryStr of raw) {
      results.processed++;

      let entry: QamfWebhookEntry;
      try {
        entry = JSON.parse(entryStr) as QamfWebhookEntry;
      } catch {
        console.error("[bowling-events] failed to parse queue entry:", entryStr.slice(0, 200));
        results.errors++;
        continue;
      }

      const eventType   = entry.eventType ?? entry.raw?.Type ?? "unknown";
      const data        = entry.raw?.Data;
      const qamfId      = data?.Id ?? "";
      const qamfStatus  = data?.Status ?? "";

      // Diagnostic: log the full Data shape for reservation.updated events
      // so we can see whether Running comes through as Data.Status or Data.Lanes[].Status
      if (eventType === "reservation.updated" && qamfId.startsWith("X")) {
        const lanes = Array.isArray((data as Record<string, unknown>)?.Lanes)
          ? ((data as Record<string, unknown>).Lanes as Array<{ LaneNumber?: number; Status?: string }>)
              .map((l) => `${l.LaneNumber ?? "?"}:${l.Status ?? "?"}`)
              .join(",")
          : "none";
        console.log(
          `[bowling-events] reservation.updated qamfId=${qamfId}` +
          ` Data.Status="${qamfStatus}" Lanes=[${lanes}]`,
        );
      }

      // Only process our web reservations (QAMF IDs start with "X")
      if (qamfId && !qamfId.startsWith("X")) {
        console.log(`[bowling-events] skipping non-web qamfId=${qamfId} type=${eventType}`);
        results.skipped++;
        continue;
      }

      if (eventType === "reservation.created") {
        // We create the Neon row ourselves — no action needed
        console.log(`[bowling-events] reservation.created qamfId=${qamfId} — no action`);
        results.skipped++;
        continue;
      }

      if (eventType === "lanes.updated") {
        results.skipped++;
        continue;
      }

      if (!qamfId) {
        console.warn(`[bowling-events] no Data.Id in event type=${eventType}`, entry);
        results.unknown++;
        continue;
      }

      // Look up the Neon reservation
      const reservation = await getBowlingReservationByQamfId(qamfId);
      if (!reservation) {
        console.warn(`[bowling-events] no Neon row for qamfId=${qamfId} type=${eventType}`);
        results.unknown++;
        continue;
      }

      if (dryRun) {
        console.log(
          `[bowling-events] dryRun: would process qamfId=${qamfId}` +
          ` neonId=${reservation.id} type=${eventType} status=${qamfStatus}`,
        );
        results.skipped++;
        continue;
      }

      // ── reservation.deleted → always cancel + refund ──────────────────
      if (eventType === "reservation.deleted") {
        console.log(`[bowling-events] reservation.deleted qamfId=${qamfId} neonId=${reservation.id}`);
        await handleCancellation(reservation, entry.webhookId);
        continue;
      }

      // ── reservation.updated → map status ─────────────────────────────
      if (eventType === "reservation.updated") {
        // ── Running → lane-open processor ────────────────────────────
        // When QAMF marks a reservation as Running, lanes have opened.
        // Call processLaneOpen to update kitchen display notes and apply
        // the gift card deposit to the day-of Square order.
        if (qamfStatus === "Running" && !reservation.dayofOrderSentAt) {
          const tLaneOpen = Date.now();
          console.log(`[bowling-events] Running webhook received neonId=${reservation.id} qamfId=${qamfId} webhookId=${entry.webhookId}`);
          const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
            TXBSQN0FEKQ11: 9172,
            PPTR5G2N0QXF7: 3148,
          };
          const centerId = entry.centerId ?? CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
          let laneNumbers: number[] = [];
          if (centerId) {
            try {
              const tQamf = Date.now();
              const qamfRes = await getReservation(centerId, qamfId);
              console.log(`[bowling-events] getReservation neonId=${reservation.id} ${Date.now() - tQamf}ms`);
              laneNumbers = (qamfRes.Lanes ?? [])
                .map((l) => l.LaneNumber)
                .filter((n): n is number => typeof n === "number");
            } catch (err) {
              console.warn(
                `[bowling-events] getReservation failed for lane-open neonId=${reservation.id}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
          try {
            const laneResult = await processLaneOpen({
              reservation,
              laneNumbers,
              idempotencyBase: `lane-open-${reservation.id}`,
              source: "webhook",
            });
            console.log(
              `[bowling-events] lane-open neonId=${reservation.id} totalMs=${Date.now() - tLaneOpen}` +
              ` lane="${laneResult.laneLabel}" kitchen=${laneResult.kitchenItemsUpdated}` +
              ` paymentId=${laneResult.paymentId ?? "none"}` +
              (laneResult.error ? ` error=${laneResult.error}` : ""),
            );
          } catch (err) {
            console.error(
              `[bowling-events] processLaneOpen threw neonId=${reservation.id} totalMs=${Date.now() - tLaneOpen}:`,
              err instanceof Error ? err.message : err,
            );
            results.errors++;
          }
          // Fall through — let the status map advance Neon status to 'arrived'
        }

        const neonAction = QAMF_STATUS_MAP[qamfStatus];

        if (!neonAction) {
          console.log(
            `[bowling-events] reservation.updated qamfId=${qamfId}` +
            ` status=${qamfStatus} — no mapped action, skip`,
          );
          results.skipped++;
          continue;
        }

        if (neonAction === "cancel") {
          console.log(
            `[bowling-events] reservation.updated with status=${qamfStatus}` +
            ` → cancellation qamfId=${qamfId} neonId=${reservation.id}`,
          );
          await handleCancellation(reservation, entry.webhookId);
          continue;
        }

        // Status transition — skip if it would be a no-op or a downgrade
        const current = reservation.status;
        if (current === neonAction) {
          results.skipped++;
          continue;
        }
        // Don't downgrade completed/cancelled bookings
        if (current === "completed" || current === "cancelled") {
          console.log(
            `[bowling-events] skipping status transition ${current} → ${neonAction}` +
            ` (terminal state) neonId=${reservation.id}`,
          );
          results.skipped++;
          continue;
        }

        await updateBowlingReservationStatus(reservation.id, neonAction);
        results.updated++;
        console.log(
          `[bowling-events] neonId=${reservation.id} qamfId=${qamfId}` +
          ` status ${current} → ${neonAction}`,
        );
        continue;
      }

      console.log(`[bowling-events] unhandled eventType=${eventType} qamfId=${qamfId}`);
      results.unknown++;
    }
  } catch (err) {
    console.error("[bowling-events] consumer error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "consumer error" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    elapsedMs: Date.now() - started,
    ...results,
  });
}
