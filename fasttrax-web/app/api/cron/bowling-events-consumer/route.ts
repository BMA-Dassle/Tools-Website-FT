import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import redis from "@/lib/redis";
import {
  getBowlingReservationByQamfId,
  insertBowlingReservation,
  updateBowlingReservationStatus,
  updateBowlingReservationCancelled,
  updateSquareDayofOrderId,
  updateWalkinGuestData,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { processSquareBowlingRefund } from "@/lib/square-bowling-refund";
import { getReservation } from "@/lib/qamf-bowling";
import { processLaneOpen } from "@/lib/bowling-lane-open";
import { createWalkinDayofOrder } from "@/lib/bowling-walkin-order";

/**
 * GET /api/cron/bowling-events-consumer
 *
 * Dead-letter processor for QAMF bowling webhook events.
 *
 * The primary processing path is now INLINE in the webhook POST handler
 * (app/api/webhooks/qamf-bowling/route.ts). This cron only runs as a
 * safety net: if the webhook handler's inline processEvent() throws an
 * unhandled error, the event is pushed to qamf:bowling:events:queue as
 * a dead letter. This cron drains that queue every 2 minutes.
 *
 * In normal operation, the queue is empty. If you see events landing
 * here, check the webhook handler logs for the root cause.
 *
 * Event types handled (same logic as the webhook handler):
 *
 *   reservation.updated  — maps QAMF reservation-level status → Neon status:
 *     Confirmed  → confirmed
 *     Arrived    → arrived  + triggers lane-open (Square day-of order)
 *     Completed  → completed
 *     Canceled   → cancelled  + Square refund
 *
 *   Lane-open trigger (processLaneOpen):
 *     Fires when Data.Status="Ready" OR Data.Lanes[].Status="Running".
 *
 *   reservation.deleted  — treat as cancellation + Square refund
 *   reservation.created  — logged, no Neon action
 *   lanes.updated        — ignored
 */

const QUEUE_KEY = "qamf:bowling:events:queue";
const BATCH_SIZE = 50;

// QAMF reservation-level status → Neon status mapping.
// See docs/qamf-lane-lifecycle.md for the full state machine.
const QAMF_STATUS_MAP: Record<string, BowlingReservation["status"] | "cancel"> = {
  Confirmed:  "confirmed",
  Ready:      "arrived",   // lane assigned — triggers shoe KDS
  Arrived:    "arrived",
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

      // Only process tracked prefixes (X=web, K=kiosk, C=conqueror)
      const TRACKED_PREFIXES = ["X", "K", "C"];
      const isTracked = !qamfId || TRACKED_PREFIXES.some((p) => qamfId.startsWith(p));
      if (!isTracked) {
        console.log(`[bowling-events] skipping untracked qamfId=${qamfId} type=${eventType}`);
        results.skipped++;
        continue;
      }

      if (eventType === "reservation.created") {
        if (!qamfId || qamfId.startsWith("X")) {
          results.skipped++;
          continue;
        }
        // K/C dead-letter: backfill Neon row if missing
        const existing = await getBowlingReservationByQamfId(qamfId);
        if (!existing && entry.centerId) {
          try {
            const QAMF_ID_TO_CODE: Record<number, string> = { 9172: "TXBSQN0FEKQ11", 3148: "PPTR5G2N0QXF7" };
            const cc = QAMF_ID_TO_CODE[entry.centerId];
            if (cc) {
              const qamfRes = await getReservation(entry.centerId, qamfId);
              const guest = qamfRes.Customer?.Guest;
              await insertBowlingReservation({
                centerCode: cc,
                productKind: "open",
                qamfReservationId: qamfId,
                depositCents: 0, totalCents: 0,
                status: "confirmed",
                bookedAt: qamfRes.BookedAt ?? new Date().toISOString(),
                playerCount: qamfRes.TotalPlayers ?? undefined,
                guestName: guest?.Name ?? undefined,
                guestEmail: guest?.Email ?? undefined,
                guestPhone: guest?.PhoneNumber ?? undefined,
                bookingSource: qamfId.startsWith("K") ? "kiosk" : "conqueror",
              }, []);
              console.log(`[bowling-events] walkin backfill qamfId=${qamfId}`);
            }
          } catch (err) {
            console.warn(`[bowling-events] walkin backfill failed qamfId=${qamfId}:`, err);
          }
        }
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

      // Look up the Neon reservation (backfill K/C if missing)
      let reservation = await getBowlingReservationByQamfId(qamfId);
      if (!reservation && (qamfId.startsWith("K") || qamfId.startsWith("C")) && entry.centerId) {
        try {
          const QAMF_ID_TO_CODE: Record<number, string> = { 9172: "TXBSQN0FEKQ11", 3148: "PPTR5G2N0QXF7" };
          const cc = QAMF_ID_TO_CODE[entry.centerId];
          if (cc) {
            const qamfRes = await getReservation(entry.centerId, qamfId);
            const guest = qamfRes.Customer?.Guest;
            await insertBowlingReservation({
              centerCode: cc, productKind: "open", qamfReservationId: qamfId,
              depositCents: 0, totalCents: 0, status: "confirmed",
              bookedAt: qamfRes.BookedAt ?? new Date().toISOString(),
              playerCount: qamfRes.TotalPlayers ?? undefined,
              guestName: guest?.Name ?? undefined, guestEmail: guest?.Email ?? undefined,
              guestPhone: guest?.PhoneNumber ?? undefined,
              bookingSource: qamfId.startsWith("K") ? "kiosk" : "conqueror",
            }, []);
            reservation = await getBowlingReservationByQamfId(qamfId);
          }
        } catch (err) {
          console.warn(`[bowling-events] walkin backfill failed qamfId=${qamfId}:`, err);
        }
      }
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
        // ── Sync guest + player data for K/C reservations ──────────
        const isWalkin = qamfId.startsWith("K") || qamfId.startsWith("C");
        if (isWalkin) {
          const CENTER_CODE_TO_QAMF: Record<string, number> = {
            TXBSQN0FEKQ11: 9172,
            PPTR5G2N0QXF7: 3148,
          };
          try {
            const cid = entry.centerId ?? CENTER_CODE_TO_QAMF[reservation.centerCode];
            if (cid) {
              const qamfFull = await getReservation(cid, qamfId);
              const guest = qamfFull.Customer?.Guest;
              await updateWalkinGuestData(reservation.id, {
                guestName: guest?.Name ?? null,
                guestEmail: guest?.Email ?? null,
                guestPhone: guest?.PhoneNumber ?? null,
                playerCount: qamfFull.TotalPlayers ?? null,
              });
              reservation = {
                ...reservation,
                guestName: guest?.Name ?? undefined,
                guestEmail: guest?.Email ?? undefined,
                guestPhone: guest?.PhoneNumber ?? undefined,
                playerCount: qamfFull.TotalPlayers ?? reservation.playerCount,
              };
            }
          } catch (err) {
            console.warn(`[bowling-events] guest sync failed neonId=${reservation.id}:`, err);
          }
        }

        // ── Lane-open trigger ───────────────────────────────────────
        // Fire processLaneOpen when EITHER:
        //   1. Data.Status = "Ready" (reservation-level — lane assigned)
        //   2. Data.Lanes[].Status includes "Running" (lane-level fallback)
        const webhookLanes = Array.isArray((data as Record<string, unknown>)?.Lanes)
          ? ((data as Record<string, unknown>).Lanes as Array<{ LaneNumber?: number; Status?: string; Players?: Array<{ Name?: string; ShoeSize?: string | null }> }>)
          : [];
        const hasRunningLane = webhookLanes.some((l) => l.Status === "Running");
        const isReady = qamfStatus === "Ready";

        if ((isReady || hasRunningLane) && !reservation.dayofOrderSentAt) {
          const tLaneOpen = Date.now();
          console.log(
            `[bowling-events] lane-open trigger neonId=${reservation.id} qamfId=${qamfId}` +
            ` Data.Status="${qamfStatus}" isReady=${isReady} hasRunningLane=${hasRunningLane}` +
            ` webhookId=${entry.webhookId}`,
          );

          // Extract lane numbers directly from the webhook payload —
          // no need to call getReservation since QAMF includes full
          // Lanes[] in reservation.updated events.
          let laneNumbers: number[] = webhookLanes
            .filter((l) => l.Status === "Running")
            .map((l) => l.LaneNumber)
            .filter((n): n is number => typeof n === "number");

          // Fallback: if no Running lanes in payload, fetch from QAMF
          if (laneNumbers.length === 0) {
            const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
              TXBSQN0FEKQ11: 9172,
              PPTR5G2N0QXF7: 3148,
            };
            const centerId = entry.centerId ?? CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
            if (centerId) {
              try {
                const tQamf = Date.now();
                const qamfRes = await getReservation(centerId, qamfId);
                console.log(`[bowling-events] getReservation fallback neonId=${reservation.id} ${Date.now() - tQamf}ms`);
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
          }

          // For walkin reservations without a day-of order, create a $0 one
          if (!reservation.squareDayofOrderId && reservation.bookingSource !== "web") {
            try {
              const webhookPlayers = webhookLanes
                .flatMap((l) => l.Players ?? [])
                .filter((p) => p.Name && p.Name !== "Player1")
                .map((p) => ({ name: p.Name!, shoeSize: p.ShoeSize }));

              const { dayofOrderId } = await createWalkinDayofOrder({
                locationId: reservation.centerCode,
                guestName: reservation.guestName ?? "Walk-in",
                playerCount: reservation.playerCount ?? 1,
                neonId: reservation.id,
                qamfReservationId: qamfId,
                squareCustomerId: reservation.squareCustomerId,
                players: webhookPlayers.length > 0 ? webhookPlayers : undefined,
              });
              await updateSquareDayofOrderId(reservation.id, dayofOrderId);
              reservation = { ...reservation, squareDayofOrderId: dayofOrderId };
            } catch (err) {
              console.error(
                `[bowling-events] createWalkinDayofOrder failed neonId=${reservation.id}:`,
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
