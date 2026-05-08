import { NextRequest, NextResponse } from "next/server";
import { createReservation } from "@/lib/qamf-bowling";

/**
 * POST /api/bowling/v2/reserve/hold
 *
 * Creates a QAMF Temporary reservation ("hold") as soon as the user
 * selects their experience on the offer step. The slot is held until
 * the user completes checkout or navigates away.
 *
 * The hold is extended every ~8 minutes by the wizard via
 * PATCH /api/bowling/v2/reserve/hold/[qamfId].
 *
 * At submit time, /api/bowling/v2/reserve accepts an optional
 * `qamfReservationId` to use the existing hold rather than creating a
 * fresh reservation — this prevents a double-booking race.
 *
 * Body: { centerId, webOfferId, optionId?, optionType?, bookedAt, players, service? }
 * Response: { qamfReservationId, expiresAt, status }
 */

const VALID_CENTER_IDS = new Set([9172, 3148]);

interface HoldBody {
  centerId: number;
  webOfferId: number;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  bookedAt: string;
  players: number;
  service?: "BookForLater" | "PlayNow";
}

export async function POST(req: NextRequest) {
  let body: HoldBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { centerId, webOfferId, bookedAt, players } = body;

  if (!centerId || !webOfferId || !bookedAt || !players) {
    return NextResponse.json(
      { error: "centerId, webOfferId, bookedAt, and players are required" },
      { status: 400 },
    );
  }

  if (!VALID_CENTER_IDS.has(centerId)) {
    return NextResponse.json({ error: `unknown centerId: ${centerId}` }, { status: 400 });
  }

  const optionType = body.optionType ?? "Game";
  const optionId = body.optionId;
  const service = body.service ?? "BookForLater";

  const qamfOptions: {
    Game?: { Id: number }[];
    Time?: { Id: number }[];
    Unlimited?: { Id: number }[];
  } = {};
  if (optionId) {
    if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
    else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
    else qamfOptions.Game = [{ Id: optionId }];
  }

  try {
    const reservation = await createReservation(centerId, {
      BookedAt: bookedAt,
      Title: `Hold (${players}p)`,
      WebOffer: {
        Id: webOfferId,
        Options: qamfOptions,
        Services: [service],
      },
      TotalPlayers: players,
    });

    return NextResponse.json({
      qamfReservationId: reservation.Id,
      expiresAt: reservation.ExpiresAt ?? null,
      status: reservation.Status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF hold failed";
    console.error("[bowling/v2/reserve/hold] POST error:", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
