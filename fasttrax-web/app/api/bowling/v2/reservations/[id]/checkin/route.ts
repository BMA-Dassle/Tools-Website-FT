import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation } from "@/lib/bowling-db";
import { getReservation, setReservationStatus } from "@/lib/qamf-bowling";

/**
 * Check-in API for bowling reservations.
 *
 * GET  — poll QAMF for current lane status (no side effects)
 * POST — mark the reservation as "Arrived" in QAMF, opening the lane
 *
 * Phase values (GET response):
 *   not_ready  — lanes not yet prepared (Confirmed/None/Temporary)
 *   ready      — at least one lane is Ready (staff set it up, awaiting customer)
 *   running    — lane(s) are Running (already open / bowling in progress)
 *   completed  — session complete
 *   cancelled  — reservation cancelled in Neon
 */

const CENTER_CODE_TO_QAMF_ID: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

function buildLaneLabel(nums: number[]): string {
  if (!nums.length) return "";
  if (nums.length === 1) return `Lane ${nums[0]}`;
  return `Lanes ${nums.join(", ")}`;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const neonId = parseInt(id, 10);
  if (!neonId || isNaN(neonId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const reservation = await getBowlingReservation(neonId);
  if (!reservation) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (reservation.status === "cancelled") {
    return NextResponse.json({ phase: "cancelled", laneLabel: "", laneNumbers: [] });
  }

  const centerId = CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
  if (!centerId || !reservation.qamfReservationId) {
    return NextResponse.json({ phase: "not_ready", laneLabel: "", laneNumbers: [] });
  }

  try {
    const qamfRes = await getReservation(centerId, reservation.qamfReservationId);
    const lanes = qamfRes.Lanes ?? [];
    const laneNumbers = lanes
      .map((l) => l.LaneNumber)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const laneLabel = buildLaneLabel(laneNumbers);

    // Determine phase from lane statuses
    const statuses = lanes.map((l) => l.Status);
    let phase: "not_ready" | "ready" | "running" | "completed";
    if (statuses.some((s) => s === "Completed")) {
      phase = "completed";
    } else if (statuses.some((s) => s === "Running")) {
      phase = "running";
    } else if (statuses.some((s) => s === "Ready")) {
      phase = "ready";
    } else {
      phase = "not_ready";
    }

    return NextResponse.json({
      phase,
      laneLabel,
      laneNumbers,
      reservationStatus: qamfRes.Status,
    });
  } catch (err) {
    console.error(
      `[checkin] QAMF fetch failed neonId=${neonId}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "Unable to check lane status" }, { status: 502 });
  }
}

/**
 * POST /api/bowling/v2/reservations/[id]/checkin
 *
 * Marks the reservation as "Arrived" in QAMF, which signals the system
 * that the customer is present and their lane should open.
 * Only call after GET confirms phase="ready".
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const neonId = parseInt(id, 10);
  if (!neonId || isNaN(neonId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const reservation = await getBowlingReservation(neonId);
  if (!reservation) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (reservation.status === "cancelled") {
    return NextResponse.json({ error: "reservation cancelled" }, { status: 409 });
  }

  const centerId = CENTER_CODE_TO_QAMF_ID[reservation.centerCode];
  if (!centerId || !reservation.qamfReservationId) {
    return NextResponse.json({ error: "no QAMF link" }, { status: 400 });
  }

  const ok = await setReservationStatus(centerId, reservation.qamfReservationId, "Arrived");
  return NextResponse.json({ ok });
}
