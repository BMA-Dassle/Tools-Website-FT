import { NextRequest, NextResponse } from "next/server";
import { listLanes } from "@/lib/qamf-bowling";
import { getBowlingReservationByQamfId } from "@/lib/bowling-db";
import { processLaneOpen } from "@/lib/bowling-lane-open";

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
  const started = Date.now();
  const allResults: PollResult[] = [];

  // Poll both centers in parallel
  await Promise.all(
    CENTERS.map(async ({ centerId, centerCode }) => {
      const result: PollResult = {
        center:    centerCode,
        openLanes: 0,
        processed: 0,
        skipped:   0,
        errors:    0,
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

      // Find open lanes tied to web reservations (IDs starting with "X")
      const openWebLanes = lanes.filter(
        (l) => l.Status === "Open" && l.Reservation?.Id?.startsWith("X"),
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
        const reservation = await getBowlingReservationByQamfId(qamfId).catch(() => null);

        if (!reservation) {
          // Not a Neon-tracked reservation (e.g. manually created in Conqueror)
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
    ok:        true,
    elapsedMs: Date.now() - started,
    centers:   allResults,
  });
}
