import { NextRequest, NextResponse } from "next/server";
import { createReservation } from "@/lib/qamf-bowling";
import {
  assertBookable,
  DurationGuardError,
  qamfSlotTakenMessage,
} from "~/features/booking/service/duration-guard";
import { FASTTRAX_QAMF_CENTER_ID } from "@/lib/qamf-centers";

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

const VALID_CENTER_IDS = new Set([9172, 3148, FASTTRAX_QAMF_CENTER_ID]);

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

  // Duration/option guard: reject options that don't belong to the offer,
  // durations past close, and durations whose occupancy window is provably
  // blocked — BEFORE creating the QAMF hold. Typed codes let the wizard
  // refresh its slot grid instead of dead-ending. Fail-open on guard
  // infrastructure errors (QAMF createReservation stays the final authority).
  try {
    await assertBookable({
      centerId,
      webOfferId,
      optionId,
      optionType,
      bookedAt,
      players,
      mode: "full",
      logTag: "[bowling/v2/reserve/hold]",
    });
  } catch (err) {
    if (err instanceof DurationGuardError) {
      console.log(`[bowling/v2/reserve/hold] guard rejected (${err.code}): ${err.message}`);
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.warn("[bowling/v2/reserve/hold] duration guard errored (fail-open):", err);
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
    // Lane-fit/availability rejections become a typed 409 the UI can recover
    // from (refresh slots) instead of an opaque 502.
    const taken = qamfSlotTakenMessage(err);
    if (taken) {
      // `detail` carries QAMF's raw reason so an offer-level misconfiguration
      // (every hold on one offer 409ing — the 2026-07-31 Midnight Madness
      // outage) is distinguishable from a genuine slot race without log
      // access. The wizard renders only `error`.
      return NextResponse.json(
        { error: taken, code: "slot_taken", detail: msg.slice(0, 500) },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
