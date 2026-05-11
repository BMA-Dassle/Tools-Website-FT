import { NextRequest, NextResponse } from "next/server";
import { getTodayReservationsNeedingLaneReady } from "@/lib/bowling-db";
import { getReservation, listLanes } from "@/lib/qamf-bowling";
import { sendLaneReadyNotification } from "@/lib/bowling-lane-ready-notify";

/**
 * GET /api/cron/bowling-pre-arrival
 *
 * Runs every 2 minutes. **Fallback** lane-ready notifier — catches the case
 * where QAMF marks a lane Ready/Running but the webhook was missed (or
 * arrived before the reservation existed in our DB).
 *
 * Primary path: the QAMF webhook handler sends lane-ready SMS instantly
 * on Arrived/Running events (see app/api/webhooks/qamf-bowling/route.ts).
 *
 * This cron provides belt-and-suspenders coverage:
 *   1. Fetches today's reservations where lane_ready_sent_at IS NULL
 *   2. For each, polls QAMF to resolve the lane phase
 *   3. If phase = ready or running → sendLaneReadyNotification()
 *
 * Idempotent: lane_ready_sent_at column prevents double-sends.
 */

const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

type LanePhase = "not_ready" | "ready" | "running" | "completed";

async function resolveLanePhase(
  centerCode: string,
  qamfReservationId: string,
): Promise<{ phase: LanePhase; laneLabel: string }> {
  const centerId = CENTER_CODE_TO_QAMF_ID[centerCode];
  if (!centerId || !qamfReservationId) {
    return { phase: "not_ready", laneLabel: "" };
  }

  const qamfRes = await getReservation(centerId, qamfReservationId);
  const lanes = qamfRes.Lanes ?? [];
  const laneNumbers = lanes
    .map((l: { LaneNumber: number }) => l.LaneNumber)
    .filter(Boolean)
    .sort((a: number, b: number) => a - b);

  // Determine phase from booked-lane statuses
  const statuses = lanes.map((l: { Status: string }) => l.Status);
  let phase: LanePhase;
  if (statuses.some((s: string) => s === "Completed")) {
    phase = "completed";
  } else if (statuses.some((s: string) => s === "Running")) {
    phase = "running";
  } else if (statuses.some((s: string) => s === "Ready")) {
    phase = "ready";
  } else {
    phase = "not_ready";
  }

  // Self-service gate: within 30 min + physical lanes Closed → ready
  if (phase === "not_ready" && laneNumbers.length > 0) {
    const bookedAt = qamfRes.BookedAt ? new Date(qamfRes.BookedAt).getTime() : 0;
    const now = Date.now();
    const minsUntilBooked = (bookedAt - now) / 60_000;

    if (bookedAt && minsUntilBooked <= 30) {
      try {
        const physicalLanes = await listLanes(centerId);
        const assignedPhysical = physicalLanes.filter((pl: { LaneNumber: number }) =>
          laneNumbers.includes(pl.LaneNumber),
        );
        const allClosed =
          assignedPhysical.length > 0 &&
          assignedPhysical.every((pl: { Status: string }) => pl.Status === "Closed");
        if (allClosed) {
          phase = "ready";
        }
      } catch {
        // Fall through — keep phase as not_ready
      }
    }
  }

  const laneLabel =
    laneNumbers.length === 1
      ? `Lane ${laneNumbers[0]}`
      : laneNumbers.length > 1
        ? `Lanes ${laneNumbers.join(", ")}`
        : "";

  return { phase, laneLabel };
}

// ── Handler ─────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const invoker = req.headers.get("x-vercel-cron") ? "vercel-cron" : "manual";

  const reservations = await getTodayReservationsNeedingLaneReady();
  console.log(
    `[lane-ready-cron] invoker=${invoker} candidates=${reservations.length}`,
  );

  if (reservations.length === 0) {
    return NextResponse.json({ ok: true, invoker, sent: 0, checked: 0 });
  }

  const results: Array<{
    id: number;
    guest: string;
    phase: string;
    email: boolean;
    sms: boolean;
  }> = [];

  for (const r of reservations) {
    // Skip K/C reservations — SMS disabled until self-service lane open is validated
    if (r.bookingSource && r.bookingSource !== "web") {
      results.push({ id: r.id, guest: r.guestName ?? "?", phase: "skipped-walkin", email: false, sms: false });
      continue;
    }

    if (!r.qamfReservationId) {
      results.push({ id: r.id, guest: r.guestName ?? "?", phase: "no_qamf_id", email: false, sms: false });
      continue;
    }

    let phase: LanePhase = "not_ready";
    let laneLabel = "";

    try {
      const resolved = await resolveLanePhase(r.centerCode, r.qamfReservationId);
      phase = resolved.phase;
      laneLabel = resolved.laneLabel;
    } catch (err) {
      console.warn(
        `[lane-ready-cron] QAMF poll failed neonId=${r.id}:`,
        err instanceof Error ? err.message : err,
      );
      results.push({ id: r.id, guest: r.guestName ?? "?", phase: "error", email: false, sms: false });
      continue;
    }

    if (phase !== "ready" && phase !== "running") {
      results.push({ id: r.id, guest: r.guestName ?? "?", phase, email: false, sms: false });
      continue;
    }

    if (dryRun) {
      results.push({ id: r.id, guest: r.guestName ?? "?", phase, email: false, sms: false });
      continue;
    }

    try {
      const { smsOk, emailOk } = await sendLaneReadyNotification(r, laneLabel);
      results.push({ id: r.id, guest: r.guestName ?? "?", phase, email: emailOk, sms: smsOk });
    } catch (err) {
      console.warn(
        `[lane-ready-cron] notification failed neonId=${r.id}:`,
        err instanceof Error ? err.message : err,
      );
      results.push({ id: r.id, guest: r.guestName ?? "?", phase, email: false, sms: false });
    }
  }

  return NextResponse.json({
    ok: true,
    invoker,
    dryRun,
    checked: reservations.length,
    sent: results.filter((r) => r.email || r.sms).length,
    results,
  });
}
