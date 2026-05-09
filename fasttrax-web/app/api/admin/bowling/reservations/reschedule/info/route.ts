import { NextRequest, NextResponse } from "next/server";
import { getReservation } from "@/lib/qamf-bowling";
import { getBowlingReservation } from "@/lib/bowling-db";

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

/**
 * GET /api/admin/bowling/reservations/reschedule/info?neonId=…&token=…
 *
 * Returns the QAMF web offer details for an existing reservation so the
 * admin reschedule modal can fetch availability constrained to the same
 * web offer. The web offer ID is pulled from the live QAMF reservation.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const neonIdStr = req.nextUrl.searchParams.get("neonId");
  if (!neonIdStr) {
    return NextResponse.json({ error: "neonId required" }, { status: 400 });
  }
  const neonId = parseInt(neonIdStr, 10);
  if (isNaN(neonId)) {
    return NextResponse.json({ error: "invalid neonId" }, { status: 400 });
  }

  const reservation = await getBowlingReservation(neonId);
  if (!reservation) {
    return NextResponse.json({ error: "reservation not found" }, { status: 404 });
  }

  const qamfCenterId = CENTER_CODE_TO_QAMF[reservation.centerCode];
  if (!qamfCenterId) {
    return NextResponse.json(
      { error: `unknown center: ${reservation.centerCode}` },
      { status: 400 },
    );
  }

  if (!reservation.qamfReservationId) {
    return NextResponse.json(
      { error: "no QAMF reservation linked — cannot determine web offer" },
      { status: 400 },
    );
  }

  try {
    const qamfRes = await getReservation(qamfCenterId, reservation.qamfReservationId);
    const woId = qamfRes.WebOffer?.Id;
    if (!woId) {
      return NextResponse.json(
        { error: "QAMF reservation has no WebOffer — cannot reschedule" },
        { status: 400 },
      );
    }

    // Extract option details from the QAMF reservation
    let optionId: number | undefined;
    let optionType: string = "Game";
    const opts = qamfRes.WebOffer?.Options;
    if (opts?.Time?.length) {
      optionType = "Time";
      optionId = opts.Time[0].Id;
    } else if (opts?.Unlimited?.length) {
      optionType = "Unlimited";
      optionId = opts.Unlimited[0].Id;
    } else if (opts?.Game?.length) {
      optionType = "Game";
      optionId = opts.Game[0].Id;
    }

    return NextResponse.json({
      webOfferId: woId,
      optionId,
      optionType,
      centerId: qamfCenterId,
      centerCode: reservation.centerCode,
      playerCount: reservation.playerCount ?? 1,
      bookedAt: reservation.bookedAt,
      guestName: reservation.guestName,
      productKind: reservation.productKind,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF error";
    console.error("[admin/reschedule/info] getReservation failed:", msg);
    return NextResponse.json(
      { error: `Failed to fetch QAMF reservation: ${msg}` },
      { status: 502 },
    );
  }
}
