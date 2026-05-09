import { NextRequest, NextResponse } from "next/server";
import { getReservation } from "@/lib/qamf-bowling";
import { getBowlingReservation } from "@/lib/bowling-db";
import { sql } from "@/lib/db";

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

/**
 * GET /api/bowling/v2/reservations/[id]/reschedule/info
 *
 * Returns the QAMF web offer details for an existing reservation so the
 * confirmation page's reschedule panel can fetch availability constrained
 * to the same web offer.
 *
 * Also returns `daysOfWeek` (0=Sun..6=Sat) from the linked experience
 * so the UI can grey out dates that won't have availability without
 * making 14 QAMF availability probes.
 *
 * No auth — customer-facing, but requires knowing the neonId.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: idStr } = await ctx.params;
  const neonId = parseInt(idStr, 10);
  if (isNaN(neonId) || neonId < 1) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
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
      { error: "no QAMF reservation linked" },
      { status: 400 },
    );
  }

  try {
    const qamfRes = await getReservation(qamfCenterId, reservation.qamfReservationId);
    const woId = qamfRes.WebOffer?.Id;
    if (!woId) {
      return NextResponse.json(
        { error: "reservation has no web offer" },
        { status: 400 },
      );
    }

    // Extract option details
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

    // Look up days_of_week + duration from the experience linked to this web offer
    let daysOfWeek: number[] = [0, 1, 2, 3, 4, 5, 6]; // default: all days
    let durationMinutes: number | undefined;
    try {
      const q = sql();
      const rows = await q`
        SELECT e.days_of_week, e.label
        FROM bowling_experience_offers eo
        JOIN bowling_experiences e ON e.id = eo.experience_id
        WHERE eo.center_code = ${reservation.centerCode}
          AND eo.qamf_web_offer_id = ${woId}
        LIMIT 1
      `;
      if (rows.length > 0) {
        const raw = rows[0].days_of_week;
        if (Array.isArray(raw)) daysOfWeek = raw as number[];
      }

      // Get duration from the duration option matching this reservation's QAMF option
      if (optionId && optionType === "Time") {
        const durRows = await q`
          SELECT duration_minutes
          FROM bowling_experience_duration_options
          WHERE qamf_option_id = ${optionId}
            AND center_code = ${reservation.centerCode}
          LIMIT 1
        `;
        if (durRows.length > 0) {
          durationMinutes = durRows[0].duration_minutes as number;
        }
      }
    } catch {
      // Non-fatal — default to all days, no duration filter
    }

    return NextResponse.json({
      webOfferId: woId,
      optionId,
      optionType,
      centerId: qamfCenterId,
      playerCount: reservation.playerCount ?? 1,
      bookedAt: reservation.bookedAt,
      daysOfWeek,
      durationMinutes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF error";
    console.error("[bowling/v2/reschedule/info] getReservation failed:", msg);
    return NextResponse.json(
      { error: `Failed to load offer info: ${msg}` },
      { status: 502 },
    );
  }
}
