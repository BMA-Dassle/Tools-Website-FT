import { NextRequest, NextResponse } from "next/server";
import { getBowlingReservation } from "@/lib/bowling-db";
import { getReservation, listLanes, setReservationStatus, setLaneStatus } from "@/lib/qamf-bowling";

/**
 * Check-in API for bowling reservations.
 *
 * GET  — poll QAMF for current lane status (no side effects)
 * POST — self-service lane open: Arrived → Lane Ready → Lane Running
 *
 * Phase values (GET response):
 *   not_ready  — lanes not yet assigned (None/Temporary)
 *   ready      — lane(s) are Confirmed or Ready (eligible for self-service open)
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

    // Determine phase from booked-lane statuses.
    // See docs/qamf-lane-lifecycle.md for the full state machine.
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

    // Self-service gate: if the reservation is within 30 minutes and
    // the physical lane is "Closed" (hardware off, ready to be started),
    // let the guest open it themselves instead of waiting for staff to
    // set the booked-lane to "Ready" in Conqueror.
    if (phase === "not_ready" && laneNumbers.length > 0) {
      const bookedAt = qamfRes.BookedAt ? new Date(qamfRes.BookedAt).getTime() : 0;
      const now = Date.now();
      const minsUntilBooked = (bookedAt - now) / 60_000;

      if (bookedAt && minsUntilBooked <= 30) {
        try {
          const physicalLanes = await listLanes(centerId);
          const assignedPhysical = physicalLanes.filter((pl) =>
            laneNumbers.includes(pl.LaneNumber),
          );
          // All assigned lanes must be "Closed" (not Error, not Open for
          // someone else). If any lane is Error or already Open, don't
          // allow self-service — let staff handle it.
          const allClosed = assignedPhysical.length > 0 &&
            assignedPhysical.every((pl) => pl.Status === "Closed");
          if (allClosed) {
            phase = "ready";
            console.log(
              `[checkin] neonId=${neonId} self-service gate: within ${Math.round(minsUntilBooked)}min,` +
              ` lanes ${laneNumbers.join(",")} all Closed → phase=ready`,
            );
          }
        } catch (err) {
          console.warn(
            `[checkin] neonId=${neonId} listLanes failed for self-service check:`,
            err instanceof Error ? err.message : err,
          );
          // Fall through — keep phase as not_ready
        }
      }
    }

    // Include lane GUIDs so POST can target them for status transitions
    const laneIds = lanes.map((l) => l.Id).filter(Boolean);

    return NextResponse.json({
      phase,
      laneLabel,
      laneNumbers,
      laneIds,
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
 * Self-service lane open: Arrived → Lane Ready → Lane Running.
 * See docs/qamf-lane-lifecycle.md for the full state machine.
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

  const qamfId = reservation.qamfReservationId;

  // Step 1: Set reservation → Arrived
  const arrived = await setReservationStatus(centerId, qamfId, "Arrived");
  if (!arrived) {
    return NextResponse.json({ error: "Failed to set Arrived" }, { status: 502 });
  }

  // Step 2: Get lane GUIDs from QAMF
  let lanes: Array<{ Id: string; LaneNumber: number; Status: string }> = [];
  try {
    const qamfRes = await getReservation(centerId, qamfId);
    lanes = (qamfRes.Lanes ?? []).filter((l) => l.Id);
  } catch (err) {
    console.error(`[checkin] getReservation failed after Arrived:`, err);
    // Arrived was set — return partial success
    return NextResponse.json({ ok: true, lanesOpened: 0, error: "Arrived set but could not fetch lanes" });
  }

  // Step 3: Lane Ready → Lane Running for each lane
  let lanesOpened = 0;
  for (const lane of lanes) {
    if (lane.Status !== "Running") {
      const readyOk = await setLaneStatus(centerId, qamfId, lane.Id, "Ready");
      if (readyOk) {
        const runOk = await setLaneStatus(centerId, qamfId, lane.Id, "Running");
        if (runOk) lanesOpened++;
      }
    } else {
      lanesOpened++; // already Running
    }
  }

  const laneNumbers = lanes.map((l) => l.LaneNumber).filter(Boolean).sort((a, b) => a - b);
  const laneLabel = buildLaneLabel(laneNumbers);

  console.log(
    `[checkin] neonId=${neonId} qamfId=${qamfId}: Arrived + ${lanesOpened}/${lanes.length} lanes opened → ${laneLabel}`,
  );

  return NextResponse.json({ ok: true, lanesOpened, laneLabel });
}
