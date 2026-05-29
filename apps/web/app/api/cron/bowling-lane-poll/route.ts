import { NextRequest, NextResponse } from "next/server";
import { listLanes } from "@/lib/qamf-bowling";
import {
  getBowlingReservationByQamfId,
  insertBowlingReservation,
  updateSquareDayofOrderId,
  updateWalkinGuestData,
} from "@/lib/bowling-db";
import { processLaneOpen } from "@/lib/bowling-lane-open";
import { getReservation } from "@/lib/qamf-bowling";
import { createWalkinDayofOrder } from "@/lib/bowling-walkin-order";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/bowling-lane-poll
 *
 * Polls QAMF lane status every 1 minute for all centers.
 * Acts as a fallback for the bowling-events-consumer webhook path:
 * if a `reservation.updated` Running event was missed, this cron detects
 * the open lane and triggers processLaneOpen.
 *
 * Flow:
 *  1. listLanes(centerId) for both FM + Naples
 *  2. Filter lanes: Status="Open" with a web reservation (QAMF ID starts "X")
 *  3. Group open lanes by reservation ID → Map<qamfId, laneNumbers[]>
 *  4. For each: look up Neon row, skip if already processed or cancelled
 *  5. processLaneOpen — idempotent (same keys as the webhook consumer)
 *
 * Runs every 1 minute (vercel.json schedule "* * * * *").
 */

const CENTERS = [
  { centerId: 9172, centerCode: "TXBSQN0FEKQ11" },
  { centerId: 3148, centerCode: "PPTR5G2N0QXF7" },
] as const;

interface PollResult {
  center: string;
  openLanes: number;
  processed: number;
  skipped: number;
  errors: number;
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const started = Date.now();
  const allResults: PollResult[] = [];

  // Poll both centers in parallel
  await Promise.all(
    CENTERS.map(async ({ centerId, centerCode }) => {
      const result: PollResult = {
        center: centerCode,
        openLanes: 0,
        processed: 0,
        skipped: 0,
        errors: 0,
      };
      allResults.push(result);

      let lanes;
      try {
        lanes = await listLanes(centerId);
      } catch (err) {
        console.error(
          `[bowling-lane-poll] listLanes(${centerId}) failed:`,
          err instanceof Error ? err.message : err,
        );
        result.errors++;
        return;
      }

      // Find open lanes tied to tracked reservations (X=web, K=kiosk, C=conqueror)
      const openWebLanes = lanes.filter(
        (l) => l.Status === "Open" && l.Reservation?.Id && /^[XKC]/.test(l.Reservation.Id),
      );
      result.openLanes = openWebLanes.length;

      if (openWebLanes.length === 0) return;

      // Group lane numbers by QAMF reservation ID
      const byReservation = new Map<string, number[]>();
      for (const lane of openWebLanes) {
        const qamfId = lane.Reservation!.Id!;
        if (!byReservation.has(qamfId)) byReservation.set(qamfId, []);
        byReservation.get(qamfId)!.push(lane.LaneNumber);
      }

      // Process each open reservation
      for (const [qamfId, laneNumbers] of byReservation) {
        let reservation = await getBowlingReservationByQamfId(qamfId).catch(() => null);

        // Backfill K/C if no Neon row exists yet
        if (!reservation && (qamfId.startsWith("K") || qamfId.startsWith("C"))) {
          try {
            const QAMF_ID_TO_CODE: Record<number, string> = {
              9172: "TXBSQN0FEKQ11",
              3148: "PPTR5G2N0QXF7",
            };
            const cc = QAMF_ID_TO_CODE[centerId];
            if (cc) {
              const qamfRes = await getReservation(centerId, qamfId);
              const guest = qamfRes.Customer?.Guest;
              await insertBowlingReservation(
                {
                  centerCode: cc,
                  productKind: "open",
                  qamfReservationId: qamfId,
                  depositCents: 0,
                  totalCents: 0,
                  status: "confirmed",
                  bookedAt: qamfRes.BookedAt ?? new Date().toISOString(),
                  playerCount: qamfRes.TotalPlayers ?? undefined,
                  guestName: guest?.Name ?? undefined,
                  guestEmail: guest?.Email ?? undefined,
                  guestPhone: guest?.PhoneNumber ?? undefined,
                  bookingSource: qamfId.startsWith("K") ? "kiosk" : "conqueror",
                },
                [],
              );
              reservation = await getBowlingReservationByQamfId(qamfId);
              console.log(
                `[bowling-lane-poll] backfill qamfId=${qamfId} neonId=${reservation?.id}`,
              );
            }
          } catch (err) {
            console.warn(
              `[bowling-lane-poll] backfill failed qamfId=${qamfId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        if (!reservation) {
          result.skipped++;
          continue;
        }

        if (
          reservation.status === "cancelled" ||
          reservation.status === "completed" ||
          reservation.dayofOrderSentAt
        ) {
          result.skipped++;
          continue;
        }

        // Sync guest data + create $0 order for walkin reservations
        if (!reservation.squareDayofOrderId && reservation.bookingSource !== "web") {
          try {
            // Lane-poll has no webhook payload — fetch player/shoe data from QAMF
            const qamfFull = await getReservation(centerId, qamfId);
            const guest = qamfFull.Customer?.Guest;

            // Always sync guest data
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

            // Extract players for shoe line items
            const qamfPlayers = (qamfFull.Lanes ?? [])
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
              players: qamfPlayers.length > 0 ? qamfPlayers : undefined,
            });
            await updateSquareDayofOrderId(reservation.id, dayofOrderId);
            reservation = { ...reservation, squareDayofOrderId: dayofOrderId };
          } catch (err) {
            console.error(
              `[bowling-lane-poll] createWalkinDayofOrder failed neonId=${reservation.id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        try {
          const laneResult = await processLaneOpen({
            reservation,
            laneNumbers,
            idempotencyBase: `lane-open-${reservation.id}`,
            source: "cron",
          });

          if (laneResult.skipped) {
            result.skipped++;
          } else {
            result.processed++;
            console.log(
              `[bowling-lane-poll] processed neonId=${reservation.id}` +
                ` qamfId=${qamfId} lane="${laneResult.laneLabel}"` +
                ` kitchen=${laneResult.kitchenItemsUpdated}` +
                ` paymentId=${laneResult.paymentId ?? "none"}`,
            );
          }
        } catch (err) {
          result.errors++;
          console.error(
            `[bowling-lane-poll] processLaneOpen threw neonId=${reservation.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }),
  );

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - started,
    centers: allResults,
  });
}
