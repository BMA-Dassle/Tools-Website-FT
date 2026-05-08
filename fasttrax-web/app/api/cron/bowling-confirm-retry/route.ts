import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import {
  getPendingQamfConfirms,
  incrementQamfConfirmAttempt,
  updateBowlingReservationStatus,
  MAX_QAMF_CONFIRM_ATTEMPTS,
} from "@/lib/bowling-db";
import {
  setReservationCustomer,
  setReservationStatus,
} from "@/lib/qamf-bowling";

/**
 * GET /api/cron/bowling-confirm-retry
 *
 * Retries QAMF confirmation for paid bookings where the initial confirm
 * failed at submit time.  Runs every 5 minutes.
 *
 * How it works:
 *   1. Fetch rows WHERE status = 'confirm_pending' (max 20 per run)
 *   2. For each: PUT /customer + PATCH /status on QAMF
 *   3. Success → status = 'confirmed'
 *   4. Failure + attempts < MAX_QAMF_CONFIRM_ATTEMPTS → status stays
 *      'confirm_pending', attempt counter incremented
 *   5. Failure + attempts >= MAX_QAMF_CONFIRM_ATTEMPTS → status =
 *      'confirm_failed', logged as error so Vercel alerts can fire
 *
 * The Redis queue (`qamf:bowling:confirm-retry`) provides fast first-retry
 * visibility; the Neon query is the authoritative source of truth and
 * handles retries that survive a Redis eviction.
 */

const CONFIRM_RETRY_QUEUE = "qamf:bowling:confirm-retry";

const CENTER_CODE_TO_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

export async function GET(req: NextRequest) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();

  const results = {
    attempted: 0,
    confirmed: 0,
    requeued: 0,
    failed: 0,
  };

  try {
    // Drain any entries queued by the reserve route first — these are the
    // newest failures and benefit from a quick first retry.  We don't
    // deduplicate against the Neon query below; both paths converge on the
    // same Neon row update so duplicate attempts are safe (idempotent PATCH).
    const queuedRaw = await redis.lrange(CONFIRM_RETRY_QUEUE, 0, 19);
    if (queuedRaw.length > 0 && !dryRun) {
      await redis.ltrim(CONFIRM_RETRY_QUEUE, queuedRaw.length, -1);
    }

    // Primary source: Neon rows in 'confirm_pending' status.
    // This covers queued entries AND any that survived a Redis eviction.
    const pending = await getPendingQamfConfirms();

    for (const row of pending) {
      results.attempted++;
      const centerId = CENTER_CODE_TO_ID[row.centerCode];
      if (!centerId || !row.qamfReservationId) {
        console.error(
          `[bowling-confirm-retry] neonId=${row.id}: unknown centerCode=${row.centerCode} or missing qamfReservationId`,
        );
        results.failed++;
        continue;
      }

      const attemptsAfter = row.qamfConfirmAttempts + 1;

      if (dryRun) {
        console.log(
          `[bowling-confirm-retry] dryRun: would retry neonId=${row.id} qamf=${row.qamfReservationId} attempt=${attemptsAfter}`,
        );
        results.requeued++;
        continue;
      }

      let confirmed = false;
      try {
        await setReservationCustomer(centerId, row.qamfReservationId, {
          Guest: {
            Name: row.guestName ?? "",
            PhoneNumber: row.guestPhone ?? "",
            Email: row.guestEmail ?? "",
          },
        });
        confirmed = await setReservationStatus(centerId, row.qamfReservationId, "Confirmed");
      } catch (err) {
        console.error(
          `[bowling-confirm-retry] neonId=${row.id} attempt=${attemptsAfter} error:`,
          err instanceof Error ? err.message : err,
        );
      }

      if (confirmed) {
        await updateBowlingReservationStatus(row.id, "confirmed");
        results.confirmed++;
        console.log(
          `[bowling-confirm-retry] neonId=${row.id} qamf=${row.qamfReservationId} confirmed after ${attemptsAfter} attempt(s)`,
        );
      } else if (attemptsAfter >= MAX_QAMF_CONFIRM_ATTEMPTS) {
        // Exhausted retries — mark as failed so staff can see it
        await incrementQamfConfirmAttempt(row.id, "confirm_failed");
        results.failed++;
        console.error(
          `[bowling-confirm-retry] neonId=${row.id} qamf=${row.qamfReservationId}` +
            ` CONFIRM_FAILED after ${attemptsAfter} attempts` +
            ` — depositCents=${row.depositCents} guest=${row.guestName}` +
            ` — MANUAL INTERVENTION REQUIRED`,
        );
      } else {
        await incrementQamfConfirmAttempt(row.id, "confirm_pending");
        results.requeued++;
        console.warn(
          `[bowling-confirm-retry] neonId=${row.id} qamf=${row.qamfReservationId}` +
            ` attempt=${attemptsAfter}/${MAX_QAMF_CONFIRM_ATTEMPTS} — will retry`,
        );
      }
    }
  } catch (err) {
    console.error("[bowling-confirm-retry] sweep error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep error" },
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
